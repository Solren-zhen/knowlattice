/**
 * 复习压力熵：把「今天到期 / 明天到期 / 本周到期」三档加权成一个 0..1 的指数，
 * 用来回答「现在的复习队列到底是稳的还是正在堆」——单看今天到期几题看不出来：
 * 今天 5 题、明天 5 题、本周 60 题，其实是正在堆。
 *
 * ponytail: 归一容量 ENTROPY_CAPACITY=48 是经验值（≈ 两天各 24 题的容量），
 * 和自己的 DAILY_QUOTA 对不上时直接调这个常数，不做自适应拟合。
 */
import { DAILY_QUOTA, isArchived, loadMistakes, stageOf, type MistakeMap } from './mistakes';

const DAY_MS = 86_400_000;

/** 本地 0 点的时间戳（与 mistakes.ts 的日期口径一致） */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface PressureBuckets {
  /** 今天（含已逾期）需要复习的条数 */
  today: number;
  /** 明天整天的到期条数 */
  tomorrow: number;
  /** 未来 7 天内（含今天）的总到期条数 */
  week: number;
}

/** 从错题表算出三档到期数。已归档的不计入。 */
export function pressureBuckets(now = Date.now(), map: MistakeMap = loadMistakes()): PressureBuckets {
  const startOfToday = startOfLocalDay(now);
  const startOfTomorrow = startOfToday + DAY_MS;
  const startOfDayAfter = startOfTomorrow + DAY_MS;
  const endOfWeek = startOfToday + 7 * DAY_MS;
  let today = 0;
  let tomorrow = 0;
  let week = 0;
  for (const r of Object.values(map)) {
    if (isArchived(r)) continue;
    const due = r.dueAt ?? 0;
    if (due < startOfTomorrow) today++;
    else if (due < startOfDayAfter) tomorrow++;
    if (due < endOfWeek) week++;
  }
  return { today, tomorrow, week };
}

/** 归一容量：加权到期数到这个值时就认为队列满载（熵 100%） */
export const ENTROPY_CAPACITY = 48;

export interface PressureMetrics extends PressureBuckets {
  /** today*0.5 + tomorrow*0.3 + week*0.2 */
  weighted: number;
  /** 0..1 */
  entropy: number;
  /** 0..100，直接上屏 */
  entropyPercent: number;
  /** 三档里的最大值 */
  peak: number;
  /** 明天 - 今天，正数表示明天更重 */
  tomorrowDelta: number;
  /** 本周还剩多少（不含今天） */
  remainingWindow: number;
  /** 今天占峰值的百分比，peak 为 0 时是 0 */
  todayShare: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function pressureMetrics(b: PressureBuckets): PressureMetrics {
  const weighted = b.today * 0.5 + b.tomorrow * 0.3 + b.week * 0.2;
  const entropy = clamp01(weighted / ENTROPY_CAPACITY);
  const peak = Math.max(b.today, b.tomorrow, b.week);
  return {
    ...b,
    weighted,
    entropy,
    entropyPercent: Math.round(entropy * 100),
    peak,
    tomorrowDelta: b.tomorrow - b.today,
    remainingWindow: Math.max(b.week - b.today, 0),
    todayShare: peak > 0 ? Math.round((b.today / peak) * 100) : 0,
  };
}

export type PressureLevel = 'empty' | 'low' | 'medium' | 'high';

export function pressureLevel(m: PressureMetrics): PressureLevel {
  if (m.peak === 0) return 'empty';
  if (m.entropy >= 0.85) return 'high';
  if (m.entropy >= 0.5) return 'medium';
  return 'low';
}

/** 一句话压力描述：只陈述数字与档位，建议部分交给上层决定要不要显示 */
export function pressureLine(m: PressureMetrics): string {
  switch (pressureLevel(m)) {
    case 'empty':
      return '复习队列已清空，明天和本周都没有到期题。';
    case 'high':
      return '拥堵：今天 ' + m.today + ' 题、明天 ' + m.tomorrow + ' 题、本周 ' + m.week + ' 题，先清今天。';
    case 'medium':
      return '承压：今天 ' + m.today + ' 题，本周共 ' + m.week + ' 题，先做今天到期的。';
    default:
      return '平稳：今天 ' + m.today + ' 题，本周共 ' + m.week + ' 题，按节奏走。';
  }
}

export type TrendDirection = 'accelerating' | 'improving' | 'stable' | 'worsening';

/** 今日净减少 = 今日归档数 - 今日新增失败数。正数表示在清仓。 */
export function todayNet(now = Date.now(), map: MistakeMap = loadMistakes()): number {
  const startOfToday = startOfLocalDay(now);
  let archived = 0;
  let fresh = 0;
  for (const r of Object.values(map)) {
    if (stageOf(r) >= 3 && (r.lastAdvanceAt ?? 0) >= startOfToday) archived++;
    if ((r.lastFailedAt ?? 0) >= startOfToday) fresh++;
  }
  return archived - fresh;
}

/**
 * 趋势方向：净减少达到今日配额的一半算「加速」，为正算「稳步」，0 持平，负数是「积压增加」。
 * ponytail: 没有历史序列就只用今天一天判断，够回答「今天在变好还是变坏」。
 */
export function trendOf(net: number, quota = DAILY_QUOTA.critical + DAILY_QUOTA.core): TrendDirection {
  if (net >= Math.max(1, Math.round(quota / 2))) return 'accelerating';
  if (net > 0) return 'improving';
  if (net === 0) return 'stable';
  return 'worsening';
}

export const TREND_LABELS: Record<TrendDirection, string> = {
  accelerating: '加速清仓',
  improving: '稳步推进',
  stable: '基本持平',
  worsening: '积压增加',
};

/** 一步到位：读错题表 → 指标 + 文案 + 趋势（视图只要显示就用这个） */
export function reviewPressure(now = Date.now(), map: MistakeMap = loadMistakes()) {
  const metrics = pressureMetrics(pressureBuckets(now, map));
  const net = todayNet(now, map);
  return { metrics, line: pressureLine(metrics), net, trend: trendOf(net), trendLabel: TREND_LABELS[trendOf(net)] };
}