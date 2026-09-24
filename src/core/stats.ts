/**
 * 学习打卡 / 统计：记录每日学习行为（复习评卡、题库作答），计算连续天数与近 7 天。
 * 轻量 localStorage 存储，与 SRS、待办同策略。
 */
const KEY = 'knowlattice-days';

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDate(dt);
}

function load(): Map<string, number> {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    return new Map(Object.entries(o));
  } catch {
    return new Map();
  }
}

function save(m: Map<string, number>) {
  localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m)));
}

/** 记一次今日学习行为 */
export function markStudy() {
  const d = localDate();
  const m = load();
  m.set(d, (m.get(d) ?? 0) + 1);
  save(m);
}

/** 连续打卡天数（今天没学则从昨天起算，避免当天未学就清零） */
export function streak(): number {
  const m = load();
  let d = localDate();
  if (!m.has(d)) d = addDays(d, -1);
  let n = 0;
  while ((m.get(d) ?? 0) > 0) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/** 近 7 天每日学习次数 */
export function last7(): Array<{ day: string; count: number }> {
  const m = load();
  const out: Array<{ day: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(localDate(), -i);
    out.push({ day: d, count: m.get(d) ?? 0 });
  }
  return out;
}

export function studyDays(): string[] {
  return [...load().keys()].sort();
}

/**
 * GitHub 风格的打卡热力图：按周铺开（列 = 一周，行 = 周一到周日），
 * 末尾一定是今天所在的那一周，未来几天标 future（界面上不画颜色）。
 */
export interface HeatCell {
  day: string;
  count: number;
  /** 还没到的日子：不参与颜色，也不参与「连续」判断 */
  future: boolean;
}

export function heatmap(today: string, weeks = 12): HeatCell[][] {
  // 把 today 挪到所在周的周日，再回退 weeks-1 周，作为第一列
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const dow = (base.getDay() + 6) % 7; // 周一 = 0
  const first = addDays(today, -(dow + (weeks - 1) * 7));
  const counts = load();
  const out: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(first, w * 7 + i);
      col.push({ day, count: counts.get(day) ?? 0, future: day > today });
    }
    out.push(col);
  }
  return out;
}

/** 导出打卡记录（日期 → 当日学习次数）供整包备份 */
export function exportDays(): Record<string, number> {
  return Object.fromEntries(load());
}

/**
 * 从备份导入打卡记录。合并策略取同日较大值：重复导入同一份备份不会把次数翻倍，
 * 也不会用旧备份把新进度冲回去。返回并入的天数。
 */
export function importDays(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const m = load();
  let n = 0;
  for (const [day, raw] of Object.entries(state as Record<string, unknown>)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    m.set(day, Math.max(m.get(day) ?? 0, raw));
    n++;
  }
  save(m);
  return n;
}
