/*
 * Agent 运行时治理接线（B0）：把 executeTool 包一层「分类 + 动作日志 + 写后核对」。
 *
 * 为什么不是直接用 createGovernedExecutor().run 替换 executeTool：
 * 那条路径对 requiresConfirmation 的工具返回 pending 而不执行，等用户事后统一裁决；
 * 而面板现在的写入是「出 diff 卡 → awaitDecision 阻塞 → onSave」的同一条调用栈，
 * 两套确认叠在一起就是双击一次、模型停两次，还会让 AiAgentPanel 的 pendingRef 续命
 * 逻辑（有提案待裁决时不让看门狗杀流）失效。所以 B0 只做观测，不改交互：
 *   只读工具 → 记录（auto / success / skipped）
 *   写入工具 → 原生 diff + awaitDecision 照旧，执行完记录审批结果与写后核对
 * executor 的 pending 批量裁决留给后面 opt-in 的非阻塞模式，不在这一批接。
 *
 * 记录字段对齐对手后端 AgentActionLogItem（approval_status / execution_status /
 * verification_status / can_rollback / rollback_hint），所以记录可以直接喂给未来的
 * 动作审计面板或导出，不需要再翻译一次。
 */

import { MEDBOOK_TOOLS, NOTE_AGENT_TOOLS } from './aiAgent';
import { LEARNING_TOOLS } from './aiLearning';
import { createLoopGuard, repeatHint, repeatKey, type LoopGuard } from './loopGuard';
import {
  defineTool, createToolRegistry,
  type ActionRecord, type ApprovalStatus, type ExecutionStatus, type GovernedToolDef,
  type RiskLevel, type ToolGovernance, type ToolRegistry, type TriggeredBy,
  type VerificationStatus,
} from './agentGovernance';

/** 面板里「指令来源」的判定与 executeTool 的 configGuard 同源：改它们等于改下次会话行为 */
const AGENT_MD = 'AGENT.md';
const CMD_DIR = 'AI命令/';

/** 工具名 → 治理元数据。未列出的工具按只读未知域处理（新增工具忘了登记也不会误判为可写）。 */
const TOOL_GOVERNANCE: Record<string, Partial<ToolGovernance>> = {
  list_notes: { executionDomain: 'note' },
  search_notes: { executionDomain: 'note', cacheable: false },
  read_note: { executionDomain: 'note' },
  verify_quote: { executionDomain: 'note', cacheable: false },
  propose_note_edit: { toolType: 'write', riskLevel: 'medium', executionDomain: 'note' },
  propose_note_patch: { toolType: 'write', riskLevel: 'medium', executionDomain: 'note' },
  propose_note_create: { toolType: 'write', riskLevel: 'medium', executionDomain: 'note' },
  propose_card_hints: { toolType: 'write', riskLevel: 'medium', executionDomain: 'note' },
  propose_study_log: { toolType: 'write', riskLevel: 'low', executionDomain: 'learning' },
  list_medical_books: { executionDomain: 'medbook' },
  search_medical_books: { executionDomain: 'medbook', cacheable: false },
  read_med_book_page: { executionDomain: 'medbook', cacheable: true },
  get_review_due: { executionDomain: 'learning', cacheable: false },
  get_study_summary: { executionDomain: 'learning', cacheable: false },
  get_weak_chapters: { executionDomain: 'learning', cacheable: false },
  get_quiz_progress: { executionDomain: 'learning', cacheable: false },
  get_mastery: { executionDomain: 'learning', cacheable: false },
  set_mastery: { toolType: 'write', riskLevel: 'low', executionDomain: 'learning' },
  load_skill: { executionDomain: 'skill', cacheable: false },
};

/** 工具定义 + 治理元数据（顺序与 ALL_AGENT_TOOLS 一致，wire 出来的数组因此可直接互换） */
export const GOVERNED_AGENT_TOOLS: GovernedToolDef[] = [
  ...NOTE_AGENT_TOOLS.map((d) => defineTool(d, TOOL_GOVERNANCE[d.name])),
  ...MEDBOOK_TOOLS.map((d) => defineTool(d, TOOL_GOVERNANCE[d.name])),
  ...LEARNING_TOOLS.map((d) => defineTool(d, TOOL_GOVERNANCE[d.name])),
];

export const AGENT_TOOL_REGISTRY: ToolRegistry = createToolRegistry(GOVERNED_AGENT_TOOLS);

/** 已注册工具名集合：技能卡校验用（卡里出现未注册工具就整卡作废） */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(GOVERNED_AGENT_TOOLS.map((d) => d.name));

/** 单次调用的实际风险：写指令文件（AGENT.md / AI命令/）比改普通笔记高一档——
 *  这不是过度分类，而是同一件事在两种目标上的后果不同：改笔记只影响一篇，
 *  改 AGENT.md 影响之后所有会话。 */
export function riskFor(def: GovernedToolDef, args: Record<string, unknown>): RiskLevel {
  const path = typeof args.path === 'string' ? args.path : '';
  if (def.governance.toolType === 'write' && (path === AGENT_MD || path.startsWith(CMD_DIR))) return 'high';
  return def.governance.riskLevel;
}

/** 写入结果文本 → 审批/执行状态。面板的拒绝分支是固定句式（AiAgentPanel.tsx:932-937），
 *  这里按句式判定，而不是按「返回非空即成功」——否则被拒绝的提案会被记成已执行。 */
const REFUSED_RE = /^用户拒绝了这次修改|^用户放弃了这次修改/;
const FAILED_RE = /^错误：|^写入失败：|^工具执行出错|^读取教材页失败|^核验引文失败/;

export function classifyToolResult(result: string): 'refused' | 'failed' | 'ok' {
  if (REFUSED_RE.test(result)) return 'refused';
  if (FAILED_RE.test(result)) return 'failed';
  return 'ok';
}

export type VerifyFn = (rec: ActionRecord, result: string) => VerificationStatus;

/** 写后核对：拿执行后的库快照对一遍。这里只核对「可机械判定」的部分——
 *  整篇写入比正文全等，定点改写比替换结果出现，卡片骨架比键出现；
 *  拼不出可核对的就返回 skipped，不编造 verified。 */
export function makeWriteVerifier(getDoc: (path: string) => string | undefined): VerifyFn {
  return (rec, result) => {
    let path = typeof rec.toolArgs.path === 'string' ? rec.toolArgs.path : '';
    if (!path) {
      // propose_study_log 不带路径参数，路径在结果文本里（已把这次学习写入学习日志「学习日志/x.md」）
      const m = /学习日志「([^」]+)」/.exec(result);
      if (m) path = m[1];
    }
    if (!path) return 'skipped';
    const after = getDoc(path);
    if (after === undefined) return 'mismatch';
    if (rec.toolName === 'propose_note_create' || rec.toolName === 'propose_note_edit') {
      const want = rec.toolArgs.content;
      if (typeof want !== 'string') return 'skipped';
      return after === want ? 'verified' : 'mismatch';
    }
    if (rec.toolName === 'propose_note_patch') {
      const rep = rec.toolArgs.replace_text;
      if (typeof rep !== 'string' || !rep) return 'verified';
      return after.includes(rep) ? 'verified' : 'mismatch';
    }
    if (rec.toolName === 'propose_card_hints') {
      const keys = Array.isArray(rec.toolArgs.keys) ? rec.toolArgs.keys.filter((k): k is string => typeof k === 'string') : [];
      if (!keys.length) return 'skipped';
      return keys.every((k) => after.includes(k)) ? 'verified' : 'mismatch';
    }
    if (rec.toolName === 'propose_study_log') return 'verified';
    return 'skipped';
  };
}

export interface RuntimeDeps {
  registry: ToolRegistry;
  /** 真正执行：面板的原 executeTool（含 diff / awaitDecision / onSave） */
  execute: (name: string, argsJson: string, signal: AbortSignal) => Promise<string>;
  verify?: VerifyFn;
  now?: () => number;
  /** 默认 user_request；规划型调用由调用方显式传 agent_plan */
  triggeredBy?: TriggeredBy;
  /** 原地打转防护：默认为本运行时私有的一份；测试或面板想共享时再传 */
  loopGuard?: LoopGuard;
}

export interface RuntimeStats {
  calls: number;
  reads: number;
  writes: number;
  refused: number;
  failed: number;
  mismatched: number;
  verified: number;
}

export function createAgentRuntime(deps: RuntimeDeps) {
  const now = deps.now ?? (() => Date.now());
  const records: ActionRecord[] = [];
  const guard = deps.loopGuard ?? createLoopGuard(2);
  let seq = 0;
  let audited = 0;

  function push(name: string, args: Record<string, unknown>, def: GovernedToolDef | undefined): ActionRecord {
    seq += 1;
    const gov = def?.governance;
    const rec: ActionRecord = {
      id: 'act-' + seq,
      toolName: name,
      toolArgs: args,
      toolType: gov?.toolType ?? 'read',
      riskLevel: def ? riskFor(def, args) : 'low',
      approvalStatus: 'pending',
      executionStatus: 'pending',
      verificationStatus: null,
      triggeredBy: deps.triggeredBy ?? 'user_request',
      previewSummary: def?.name ? def.name : name,
      affectedIds: typeof args.path === 'string' ? [args.path] : [],
      result: null,
      errorMessage: null,
      canRollback: false,
      rollbackHint: null,
      createdAt: now(),
      executedAt: null,
    };
    records.push(rec);
    return rec;
  }

  const executeTool = async (name: string, argsJson: string, signal: AbortSignal): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = argsJson.trim() ? JSON.parse(argsJson) as Record<string, unknown> : {};
    } catch {
      // 参数不是合法 JSON：原执行器会返回同一句错误，这里不留记录（没有可审计的参数）
      return deps.execute(name, argsJson, signal);
    }
    // 模型可能给 `null` / 数组 / 标量：解析成功不等于形状可用。审计只认普通对象，
    // 其余按「没有参数」记账——但**原样把 argsJson 交给执行器**，不替它改写模型输入。
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const def = deps.registry.get(name);
    if (!def) return deps.execute(name, argsJson, signal); // 未注册工具：原样透传，不猜语义
    // 连续同名同参：第 3 次起不再执行，直接把「换了也没用」这句话回填给模型。
    // 不记审计、不算失败——一次都没发生；记成失败会把「绕圈」误标成工具故障。
    const repeats = guard.hit(repeatKey(name, args));
    if (repeats > 2) return repeatHint(name, repeats);
    const rec = push(name, args, def);
    let out: string;
    try {
      out = await deps.execute(name, argsJson, signal);
    } catch (e) {
      rec.approvalStatus = def.governance.readOnly ? 'auto' : 'rejected';
      rec.executionStatus = 'failed';
      rec.verificationStatus = 'failed';
      rec.errorMessage = e instanceof Error ? e.message : String(e);
      rec.executedAt = now();
      throw e;
    }
    rec.result = out;
    const verdict = classifyToolResult(out);
    if (verdict === 'refused') {
      // 用户拒绝：审批为 rejected，执行仍为 pending（一次都没写）
      rec.approvalStatus = 'rejected';
      rec.executionStatus = 'pending';
      rec.verificationStatus = 'skipped';
    } else if (verdict === 'failed') {
      rec.approvalStatus = def.governance.readOnly ? 'auto' : 'rejected';
      rec.executionStatus = 'failed';
      rec.verificationStatus = 'failed';
      rec.errorMessage = out;
      rec.executedAt = now();
    } else {
      rec.approvalStatus = def.governance.readOnly ? 'auto' : 'approved';
      rec.executionStatus = 'success';
      rec.executedAt = now();
      rec.verificationStatus = def.governance.readOnly ? 'skipped' : (deps.verify ? deps.verify(rec, out) : 'skipped');
    }
    return out;
  };

  function stats(): RuntimeStats {
    const s: RuntimeStats = { calls: records.length, reads: 0, writes: 0, refused: 0, failed: 0, mismatched: 0, verified: 0 };
    for (const r of records) {
      if (r.toolType === 'write') s.writes += 1; else s.reads += 1;
      if (r.approvalStatus === 'rejected' && r.executionStatus === 'pending') s.refused += 1;
      if (r.executionStatus === 'failed') s.failed += 1;
      if (r.verificationStatus === 'mismatch') s.mismatched += 1;
      if (r.verificationStatus === 'verified') s.verified += 1;
    }
    return s;
  }

  /** 本轮里「模型需要知道」的异常：失败与被拒。成功写入在会话历史里已有
   *  【写入提案结果】条目，这里再报一遍只会让模型重复确认，所以只报异常。
   *  取一次就清空：同一件事不跨轮反复注入。 */
  function takeAuditSummary(): string {
    const fresh = records.slice(audited);
    audited = records.length;
    const bad = fresh.filter((r) => r.executionStatus === 'failed'
      || (r.approvalStatus === 'rejected' && r.executionStatus === 'pending')
      || r.verificationStatus === 'mismatch');
    if (!bad.length) return '';
    const lines = bad.map((r) => {
      if (r.approvalStatus === 'rejected' && r.executionStatus === 'pending') {
        return '- ' + r.toolName + '（' + r.previewSummary + '）：用户拒绝了这次写入，没有落盘。换个方向或先问清楚，不要原样重提。';
      }
      if (r.verificationStatus === 'mismatch') {
        return '- ' + r.toolName + '（' + r.previewSummary + '）：写入后核对不符，库里内容与提案不一致，需要重新 read_note 复查。';
      }
      return '- ' + r.toolName + '：执行失败（' + (r.errorMessage ?? '未知错误') + '）。';
    });
    return '【上一轮工具执行异常】\n' + lines.join('\n');
  }

  return {
    executeTool,
    stats,
    takeAuditSummary,
    /** 新的一轮用户提问开始时调用：清空绕圈计数（跨轮重复是正常行为） */
    resetLoopGuard: () => guard.reset(),
    records: () => [...records],
    registry: deps.registry,
    /** 交模型的 function calling 数组（与 ALL_AGENT_TOOLS 等价，这里从注册表取以保证同源） */
    tools: (whitelist?: readonly string[]) => deps.registry.wire(whitelist),
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

/** 审批状态 → 中文（未来审计面板直接用，避免各处各写一套口径） */
export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  auto: '自动执行', pending: '待确认', approved: '已批准', rejected: '已拒绝',
};
export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  pending: '未执行', success: '已执行', failed: '失败', rolled_back: '已回滚',
};
