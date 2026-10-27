/**
 * 清仓预测（backlog forecast）：把「还要多久才能把错题清完」算成一个带区间的数。
 *
 * 两件事：
 * 1. 历史积压倒推——只有「当前积压」是准的，往日积压靠每日净变化往回加，
 *    因为净变化（晋级 = 清掉一条、失败 = 多一条）是可从记录时间反推的。
 * 2. 未来预测带——按近期净清速率的均值往外推，用净变化的标准差撑开上下界，
 *    步数越远区间越宽（sqrt(step)）。不确定度下限 0.8，免得历史太平把人骗成「一定 X 天」。
 *
 * 纯函数，只读错题记录，不写存储。
 */
import { isArchived, loadMistakes, type MistakeMap } from './mistakes';

/** 往回看多少天算净速率 */
export const HISTORY_DAYS = 14;
/** 往前推多少天 */
export const FORECAST_DAYS = 7;

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

export interface DailyNet {
  /** YYYY-MM-DD */
  date: string;
  /** 正数 = 当天净增，负数 = 当天净清 */
  net: number;
}

/**
 * 逐日净变化。一条记录只留了「最后一次晋级 / 最后一次失败」的时间，
 * 所以历史是近似值，但足以给出波动率——这正是预测带需要的量。
 */
export function netByDay(
  now = Date.now(),
  map: MistakeMap = loadMistakes(),
  days = HISTORY_DAYS,
): DailyNet[] {
  const buckets = new Map<string, number>();
  const base = new Date(startOfLocalDay(now));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    buckets.set(dayKey(d.getTime()), 0);
  }
  const bump = (ts: number | undefined, delta: number) => {
    if (!ts) return;
    const key = dayKey(ts);
    if (!buckets.has(key)) return;
    buckets.set(key, (buckets.get(key) ?? 0) + delta);
  };
  for (const rec of Object.values(map)) {
    if (!rec) continue;
    // 已归档的不再参与积压，但它的晋级日仍算「当天清掉一条」
    bump(rec.lastAdvanceAt, 1);
    bump(rec.lastFailedAt, -1);
  }
  return [...buckets.entries()].map(([date, net]) => ({ date, net }));
}

/** 从当前积压往回倒推每日积压（index 0 = 最早一天，末项 = 当前） */
export function backlogSeries(nets: readonly DailyNet[], current: number): number[] {
  const out: number[] = new Array(nets.length).fill(0);
  if (nets.length === 0) return out;
  out[nets.length - 1] = Math.max(0, current);
  for (let i = nets.length - 1; i > 0; i--) {
    out[i - 1] = Math.max(0, out[i] + nets[i].net);
  }
  return out;
}

export interface ForecastPoint {
  /** 第几步（1 = 明天） */
  step: number;
  value: number;
  lower: number;
  upper: number;
}

export interface BacklogForecast {
  /** 当前积压（未归档条数） */
  current: number;
  /** 近 HISTORY_DAYS 天的平均净变化：正 = 在堆，负 = 在清 */
  meanNet: number;
  /** 每日净清量，恒 > 0（没有历史时给 0.5 的乐观下限，避免除零） */
  dailyRate: number;
  /** 净变化标准差 */
  volatility: number;
  /** 每一步的区间半步 */
  uncertaintyStep: number;
  /** 按均值算的清空天数；积压为 0 时为 0 */
  clearDays: number;
  /** 乐观/悲观两端的天数 */
  clearRange: [number, number];
  points: ForecastPoint[];
}

export function forecastBacklog(
  nets: readonly DailyNet[],
  current: number,
  horizon = FORECAST_DAYS,
): BacklogForecast {
  const values = nets.map((n) => n.net);
  const meanNet = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length
    ? values.reduce((a, b) => a + (b - meanNet) * (b - meanNet), 0) / values.length
    : Math.abs(meanNet);
  const volatility = Math.sqrt(Math.max(variance, 0));
  const uncertaintyStep = Math.max(0.8, volatility * 0.9);
  // 净变化为负才是「在清」，取反得当天的清仓量
  const dailyRate = Math.max(0.5, -meanNet);
  const start = Math.max(0, current);
  const points: ForecastPoint[] = [];
  let prev = start;
  for (let step = 1; step <= horizon; step++) {
    const value = Math.max(0, prev - dailyRate);
    const uncertainty = uncertaintyStep * Math.sqrt(step);
    points.push({
      step,
      value: Math.round(value * 10) / 10,
      lower: Math.max(0, Math.round((value - uncertainty) * 10) / 10),
      upper: Math.round((value + uncertainty) * 10) / 10,
    });
    prev = value;
  }
  const clearDays = start <= 0 ? 0 : Math.ceil(start / dailyRate);
  // 悲观 = 清得慢（速率减半步），乐观 = 清得快（速率加半步），下限 0.1 防除零
  const slow = Math.max(0.1, dailyRate - uncertaintyStep);
  const fast = dailyRate + uncertaintyStep;
  const clearRange: [number, number] = [
    start <= 0 ? 0 : Math.ceil(start / fast),
    start <= 0 ? 0 : Math.ceil(start / slow),
  ];
  return { current: start, meanNet, dailyRate, volatility, uncertaintyStep, clearDays, clearRange, points };
}

/** 未归档条数（预测的起点） */
export function activeBacklog(map: MistakeMap = loadMistakes()): number {
  return Object.values(map).filter((r) => r && !isArchived(r)).length;
}

/** 一行话：积压多少、什么节奏、多久清完 */
export function forecastLine(f: BacklogForecast): string {
  if (f.current <= 0) return '积压已清空。';
  const rate = Math.round(f.dailyRate * 10) / 10;
  if (f.meanNet > 0.05) {
    return '近 ' + HISTORY_DAYS + ' 天每天净增 ' + Math.round(f.meanNet * 10) / 10 + ' 题，当前节奏清不空。';
  }
  if (f.clearDays > 365) return '按每天净清 ' + rate + ' 题，一年都清不完，先压新增。';
  const lo = f.clearRange[0];
  const hi = f.clearRange[1];
  const span = lo === hi ? lo + ' 天' : lo + '–' + hi + ' 天';
  return f.current + ' 题积压，按每天净清 ' + rate + ' 题，约 ' + span + '清空。';
}
