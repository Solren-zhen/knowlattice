/**
 * AI 助手的上下文预算：工具结果是唯一会「无上限」长大的输入。
 *
 * 中文约 1 字 ≈ 1 token。一次 read_note 能带回整篇长笔记，教材检索能带回多段原文，
 * 同一轮里模型常连读十几篇——不设限时单轮上下文能涨到几十万字符：既烧钱，
 * 也会把真正重要的系统指令挤出窗口。
 *
 * 两道闸，两个引擎（pi / 内置）共用同一套口径：
 * - 单条：capToolResult 保留首尾、中间省略，并写明原长与「分段重读」提示；
 * - 整轮：trimToolResults 在每次请求模型前把更早的工具结果换成占位说明
 *   （模型需要时可重新调用工具），保证累计不超预算。
 */

/** 单条工具结果上限（字符） */
export const TOOL_RESULT_LIMIT = 8_000;
/** 一轮对话里全部工具结果的累计上限（字符） */
export const TOOL_RESULT_TOTAL_LIMIT = 40_000;
/** 头尾保留比例：开头含标题与结论，结尾常是被编辑的那一段 */
const HEAD_RATIO = 0.6;
/** 累计预算的边界那一条至少要留这么长，否则直接换成占位说明（留几百字没意义） */
const MIN_KEEP = 600;

/** 单条工具结果超限：保留首尾 + 截断说明（模型据此知道该分段重读） */
export function capToolResult(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = `\n\n【已截断：原文 ${text.length} 字，此处只保留首尾。需要完整内容请用 read_note 分段读，`
    + '或用 search_notes 先定位到小节再读。】\n\n';
  const room = Math.max(0, limit - note.length);
  const head = Math.ceil(room * HEAD_RATIO);
  const tail = room - head;
  return text.slice(0, head) + note + (tail > 0 ? text.slice(text.length - tail) : '');
}

/** 整轮累计预算：从最新往回累加，超预算的更早结果换成占位说明（可重新调用工具取回） */
export function trimToolResults<M extends { role: string; content?: unknown }>(
  messages: readonly M[],
  totalLimit = TOOL_RESULT_TOTAL_LIMIT,
): M[] {
  let used = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const content = m.content;
    if (used + content.length <= totalLimit) {
      used += content.length;
      continue;
    }
    const room = totalLimit - used;
    const next = room >= MIN_KEEP
      ? capToolResult(content, room)
      : `【较早的工具结果已省略：原 ${content.length} 字，超出本轮上下文预算。需要时请重新调用工具取回。】`;
    used = totalLimit;
    out[i] = { ...m, content: next } as M;
  }
  return out;
}
