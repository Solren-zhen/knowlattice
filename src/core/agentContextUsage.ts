/*
 * 上下文预算分桶：aiBudget.ts 只回答「还能塞多少字符」，不回答「谁占掉的」。
 * 预算被撑爆时无法判断是历史太长、还是某个工具一次读回整本教材。
 * 这里按段度量并给出压缩建议，供面板展示与自动压缩决策。
 */

import { estimateTokens } from './aiAgent';
import { CONTEXT_TOTAL_BUDGET } from './aiBudget';

export interface ContextBuckets {
  systemPromptTokens: number;
  historyTokens: number;
  userInputTokens: number;
  toolResultTokens: number;
  declaredToolTokens: number;
  totalTokens: number;
  /** 距离整轮预算还剩多少 token（可为负） */
  remainingTokens: number;
  /** 是否已触发过压缩（占位说明替换掉旧工具结果） */
  compactActive: boolean;
  /** 被压缩掉的估算 token */
  compactSavedTokens: number;
}

export interface MeasureInput {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

function contentText(m: MeasureInput): string {
  let s = typeof m.content === 'string' ? m.content : '';
  if (m.tool_calls) s += m.tool_calls.map((c) => c.function.name + c.function.arguments).join('');
  return s;
}

/** 旧工具结果被 trimToolResults 换成的占位说明都以此开头，用它估算压缩收益 */
const COMPACT_MARK = '【较早的工具结果已省略：原 ';

export function measureContext(
  messages: readonly MeasureInput[],
  opts: { toolsJson?: string; budget?: number } = {},
): ContextBuckets {
  const b: ContextBuckets = {
    systemPromptTokens: 0, historyTokens: 0, userInputTokens: 0,
    toolResultTokens: 0, declaredToolTokens: 0, totalTokens: 0,
    remainingTokens: 0, compactActive: false, compactSavedTokens: 0,
  };
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') lastUser = i;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = contentText(m);
    const t = estimateTokens(text);
    if (m.role === 'system') b.systemPromptTokens += t;
    else if (m.role === 'tool') {
      b.toolResultTokens += t;
      if (text.startsWith(COMPACT_MARK)) {
        b.compactActive = true;
        const saved = Number((/原 (\d+) 字/.exec(text) ?? [])[1] ?? 0);
        if (saved > 0) b.compactSavedTokens += estimateTokens(saved.toString()) > 0 ? Math.max(saved - text.length, 0) : 0;
      }
    } else if (m.role === 'user' && i === lastUser) b.userInputTokens += t;
    else b.historyTokens += t;
  }
  if (opts.toolsJson) b.declaredToolTokens = estimateTokens(opts.toolsJson);
  b.totalTokens = b.systemPromptTokens + b.historyTokens + b.userInputTokens
    + b.toolResultTokens + b.declaredToolTokens;
  const budget = opts.budget ?? CONTEXT_TOTAL_BUDGET;
  b.remainingTokens = budget - b.totalTokens;
  return b;
}

export interface CompactAdvice {
  needed: boolean;
  /** 建议优先压掉的段 */
  target: 'toolResults' | 'history' | 'none';
  /** 建议回收的 token 量 */
  reclaimTokens: number;
  reason: string;
}

/** 超过预算 85% 才建议压缩：压早了会让模型反复重读同一篇笔记，反而更费。 */
export function adviseCompaction(b: ContextBuckets, budget = CONTEXT_TOTAL_BUDGET): CompactAdvice {
  const soft = Math.floor(budget * 0.85);
  if (b.totalTokens <= soft) {
    return { needed: false, target: 'none', reclaimTokens: 0, reason: '预算内' };
  }
  const over = b.totalTokens - soft;
  if (b.toolResultTokens >= over) {
    return { needed: true, target: 'toolResults', reclaimTokens: over, reason: '工具结果占比最高' };
  }
  return { needed: true, target: 'history', reclaimTokens: over, reason: '历史消息占比最高' };
}
