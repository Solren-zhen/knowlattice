/** 把 `unknown` 收窄成「普通对象」（排除 null 与数组）。题库/内容包等逐条解析共用。 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
