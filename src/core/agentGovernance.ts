/*
 * Agent 工具治理层：把「工具定义」升级为「定义 + 治理元数据 + 动作日志」。
 *
 * 现状：aiAgent.ts 的 AgentToolDef 只有 name/description/parameters，
 * 写入类工具（propose_*）的执行与审批由 AiAgentPanel.tsx:699 的 executeTool 内联处理，
 * 审批是 awaitDecision 里的阻塞 promise（AiAgentPanel.tsx:662）：
 *   一次只能挂一个写入、模型整轮停住等用户点、promise 不持久化（:325 注释已承认遗留提案无法兑现）。
 *
 * 这里改成两段式：写入工具立即返回「预览已生成、待确认」，模型继续跑；
 * 用户一次性裁决若干条后再统一执行，结果在下一轮以一条系统消息回填。
 */

import type { AgentToolDef } from './aiAgent';

export type ToolType = 'read' | 'write';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'auto' | 'pending' | 'approved' | 'rejected';
export type ExecutionStatus = 'pending' | 'success' | 'failed' | 'rolled_back';
export type VerificationStatus = 'verified' | 'mismatch' | 'skipped' | 'failed';
export type TriggeredBy = 'user_request' | 'agent_plan' | 'event';

export interface ToolGovernance {
  toolType: ToolType;
  riskLevel: RiskLevel;
  /** true = 必须先出预览、用户确认才执行 */
  requiresConfirmation: boolean;
  /** 作用域：note / medbook / memory / graph，供白名单与审计分组 */
  executionDomain: string;
  readOnly: boolean;
  /** 并发安全 = 同一轮里可以与其他调用并行 */
  concurrencySafe: boolean;
  /** null = 未知；false = 结果随库变化不可缓存 */
  cacheable: boolean | null;
}

export interface GovernedToolDef extends AgentToolDef {
  governance: ToolGovernance;
}

/** 补默认值并做一致性推导：写入类一定不是只读；非 low 风险默认要求确认。 */
export function defineTool(def: AgentToolDef, g: Partial<ToolGovernance> = {}): GovernedToolDef {
  const toolType = g.toolType ?? 'read';
  const readOnly = g.readOnly ?? toolType === 'read';
  const riskLevel = g.riskLevel ?? 'low';
  return {
    ...def,
    governance: {
      toolType,
      riskLevel,
      requiresConfirmation: g.requiresConfirmation ?? (!readOnly || riskLevel !== 'low'),
      executionDomain: g.executionDomain ?? 'generic',
      readOnly,
      concurrencySafe: g.concurrencySafe ?? readOnly,
      cacheable: g.cacheable ?? null,
    },
  };
}

export interface ToolRegistry {
  get(name: string): GovernedToolDef | undefined;
  list(): GovernedToolDef[];
  /** 按白名单裁剪（会话模板的 tool_whitelist）；空数组 = 全给 */
  pick(whitelist?: readonly string[]): GovernedToolDef[];
  /** 交给模型的 function calling 数组（剥掉治理字段，OpenAI 兼容格式不认它） */
  wire(whitelist?: readonly string[]): AgentToolDef[];
}

export function createToolRegistry(defs: readonly GovernedToolDef[]): ToolRegistry {
  const map = new Map<string, GovernedToolDef>();
  for (const d of defs) map.set(d.name, d);
  const pick = (whitelist?: readonly string[]): GovernedToolDef[] => {
    if (!whitelist || !whitelist.length) return [...defs];
    const allow = new Set(whitelist);
    return defs.filter((d) => allow.has(d.name));
  };
  return {
    get: (n) => map.get(n),
    list: () => [...defs],
    pick,
    wire: (w) => pick(w).map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
  };
}

export interface ActionRecord {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolType: ToolType;
  riskLevel: RiskLevel;
  approvalStatus: ApprovalStatus;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus | null;
  triggeredBy: TriggeredBy;
  previewSummary: string;
  affectedIds: string[];
  result: string | null;
  errorMessage: string | null;
  canRollback: boolean;
  rollbackHint: string | null;
  createdAt: number;
  executedAt: number | null;
}

export interface ExecutorDeps {
  registry: ToolRegistry;
  /** 真正执行（只读直接跑；写入在 confirm 后跑） */
  apply: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  /** 反向操作；返回 true 表示已回滚 */
  undo?: (rec: ActionRecord) => Promise<boolean>;
  /** 执行后核对：默认 skipped */
  verify?: (rec: ActionRecord, result: string) => VerificationStatus;
  /** 预览文案：默认用工具名 + 关键参数 */
  preview?: (def: GovernedToolDef, args: Record<string, unknown>) => string;
  /** 从参数里抽出受影响的笔记路径等，供 UI 显示与回滚定位 */
  affected?: (def: GovernedToolDef, args: Record<string, unknown>) => string[];
  now?: () => number;
}

export interface ExecutorOutcome {
  action: ActionRecord;
  executed: boolean;
  requiresConfirmation: boolean;
  /** 回填给模型的文本 */
  toolResult: string;
}

function argSummary(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (!keys.length) return '(无参数)';
  return keys.slice(0, 4).map((k) => {
    const v = args[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const cut = s.length > 40 ? s.slice(0, 40) + '...' : s;
    return k + '=' + cut;
  }).join(', ');
}

export function createGovernedExecutor(deps: ExecutorDeps) {
  const now = deps.now ?? (() => Date.now());
  const records: ActionRecord[] = [];
  let seq = 0;

  function makeRecord(def: GovernedToolDef, args: Record<string, unknown>, triggeredBy: TriggeredBy): ActionRecord {
    seq += 1;
    const preview = deps.preview
      ? deps.preview(def, args)
      : def.name + ' ' + argSummary(args);
    return {
      id: 'act-' + seq,
      toolName: def.name,
      toolArgs: args,
      toolType: def.governance.toolType,
      riskLevel: def.governance.riskLevel,
      approvalStatus: 'pending',
      executionStatus: 'pending',
      verificationStatus: null,
      triggeredBy,
      previewSummary: preview,
      affectedIds: deps.affected ? deps.affected(def, args) : [],
      result: null,
      errorMessage: null,
      canRollback: false,
      rollbackHint: null,
      createdAt: now(),
      executedAt: null,
    };
  }

  async function runOnce(rec: ActionRecord): Promise<void> {
    try {
      const out = await deps.apply(rec.toolName, rec.toolArgs);
      rec.result = out;
      rec.executionStatus = 'success';
      rec.executedAt = now();
      rec.verificationStatus = deps.verify ? deps.verify(rec, out) : 'skipped';
      rec.canRollback = Boolean(deps.undo);
      rec.rollbackHint = deps.undo ? '可回滚：恢复执行前的笔记内容' : null;
    } catch (e) {
      rec.result = null;
      rec.executionStatus = 'failed';
      rec.executedAt = now();
      rec.errorMessage = e instanceof Error ? e.message : String(e);
      rec.verificationStatus = 'failed';
    }
  }

  async function confirmAction(id: string): Promise<ActionRecord> {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error('没有动作 ' + id);
    if (rec.approvalStatus !== 'pending') return rec;
    rec.approvalStatus = 'approved';
    await runOnce(rec);
    return rec;
  }

  function rejectAction(id: string): ActionRecord {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error('没有动作 ' + id);
    if (rec.approvalStatus === 'pending') rec.approvalStatus = 'rejected';
    return rec;
  }

  return {
    /** 模型发起一次工具调用 */
    async run(toolName: string, argsJson: string, triggeredBy: TriggeredBy = 'user_request'): Promise<ExecutorOutcome> {
      let args: Record<string, unknown>;
      try {
        args = argsJson.trim() ? JSON.parse(argsJson) as Record<string, unknown> : {};
      } catch {
        seq += 1;
        const bad: ActionRecord = {
          id: 'act-' + seq, toolName, toolArgs: {}, toolType: 'read', riskLevel: 'low',
          approvalStatus: 'rejected', executionStatus: 'failed', verificationStatus: 'failed',
          triggeredBy, previewSummary: '参数不是合法 JSON', affectedIds: [], result: null,
          errorMessage: '工具参数不是合法 JSON', canRollback: false, rollbackHint: null,
          createdAt: now(), executedAt: null,
        };
        records.push(bad);
        return { action: bad, executed: false, requiresConfirmation: false, toolResult: '错误：工具参数不是合法 JSON。' };
      }
      const def = deps.registry.get(toolName);
      if (!def) {
        return {
          action: { id: '', toolName, toolArgs: args } as ActionRecord,
          executed: false, requiresConfirmation: false,
          toolResult: '错误：没有名为「' + toolName + '」的工具。可用工具：' + deps.registry.list().map((d) => d.name).join(', '),
        };
      }
      const rec = makeRecord(def, args, triggeredBy);
      records.push(rec);
      if (def.governance.requiresConfirmation) {
        return {
          action: rec, executed: false, requiresConfirmation: true,
          toolResult: '已生成待确认改动（动作 ' + rec.id + '）：' + rec.previewSummary
            + '\n用户确认后才会真正写入。不要重复发起同一个改动；可以继续做只读检查或准备下一处修改。',
        };
      }
      rec.approvalStatus = 'auto';
      await runOnce(rec);
      return {
        action: rec, executed: rec.executionStatus === 'success', requiresConfirmation: false,
        toolResult: rec.executionStatus === 'success'
          ? (rec.result ?? '')
          : '工具执行出错：' + (rec.errorMessage ?? '未知错误'),
      };
    },

    /** 用户确认一条待办动作 */
    confirm: confirmAction,

    /** 用户拒绝：不执行 */
    reject: rejectAction,

    /** 批量裁决：一次点击处理整轮攒下的写入 */
    async resolveAll(decisions: { id: string; approve: boolean }[]): Promise<ActionRecord[]> {
      const out: ActionRecord[] = [];
      for (const d of decisions) {
        out.push(d.approve ? await confirmAction(d.id) : rejectAction(d.id));
      }
      return out;
    },

    /** 回滚一条已执行的动作 */
    async rollback(id: string): Promise<ActionRecord> {
      const rec = records.find((r) => r.id === id);
      if (!rec) throw new Error('没有动作 ' + id);
      if (!rec.canRollback || !deps.undo) throw new Error('动作 ' + id + ' 不可回滚');
      const ok = await deps.undo(rec);
      if (ok) rec.executionStatus = 'rolled_back';
      return rec;
    },

    pending: () => records.filter((r) => r.approvalStatus === 'pending'),
    all: () => [...records],
    get: (id: string) => records.find((r) => r.id === id),

    /** 已裁决的动作 → 一条系统消息，在下一轮请求前注入（两段式的结果回填） */
    formatResolvedSummary(): string {
      const done = records.filter((r) => r.approvalStatus === 'approved' || r.approvalStatus === 'rejected');
      if (!done.length) return '';
      const lines = done.map((r) => {
        if (r.approvalStatus === 'rejected') return '- ' + r.id + ' ' + r.previewSummary + '：用户已拒绝，未执行';
        if (r.executionStatus === 'success') {
          const v = r.verificationStatus === 'mismatch' ? '（校验不符，需要复查）' : '';
          return '- ' + r.id + ' ' + r.previewSummary + '：已执行' + v;
        }
        if (r.executionStatus === 'rolled_back') return '- ' + r.id + ' ' + r.previewSummary + '：已回滚';
        return '- ' + r.id + ' ' + r.previewSummary + '：执行失败（' + (r.errorMessage ?? '未知') + '）';
      });
      return '【系统】用户处理了上一轮待确认的写入：\n' + lines.join('\n');
    },
  };
}

export type GovernedExecutor = ReturnType<typeof createGovernedExecutor>;
