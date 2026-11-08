/**
 * 本地日历日键 `YYYY-MM-DD`。
 *
 * 为什么要集中一处：学习日历、每日一练、背诵流水、待办、单词工坊各自实现过一遍，
 * 口径虽然一致，但任何一处被顺手改成 `toISOString()`（UTC）都会让「今天」在晚上
 * 八点后差一天。本地时区只保留这一种实现。
 */

/** 本地日历日 `YYYY-MM-DD`；number 按时间戳解释 */
export function dayKey(d: Date | number = Date.now()): string {
  const x = typeof d === 'number' ? new Date(d) : d;
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
}

/** `dayKey` 的别名：调用方语义是「今天」时更易读 */
export function todayKey(d: Date | number = Date.now()): string {
  return dayKey(d);
}
