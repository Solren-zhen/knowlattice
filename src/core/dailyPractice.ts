/**
 * 每日一练 + 连续打卡。
 *
 * 与「整库练习 / 组题」的区别：每天的题是**按日期确定性地**抽出来的——
 * 同一天无论刷新几次、换哪台设备，抽到的都是同一套（种子 = 日期 + 题库名）。
 * 这样它才像「今日任务」：做了一半明天再看，题还是那批，不会每次打开都换一套。
 *
 * 打卡复用 `core/stats.markStudy`（总打卡），本模块另记一份「每日一练完成」的
 * 独立记录，用来算每日一练自己的连续天数——两者不是一回事：
 * 复习卡片也算总打卡，但不算「每日一练」。
 */
import { composeQuestions, type ComposeRules } from './qbankCompose';
import type { QuizBank, QuizQuestion } from './qbank';
import type { StatsMap } from './qbankStats';

const KEY = 'knowlattice-daily-practice';

/** 每日一练默认题量 */
export const DAILY_COUNT = 20;
/** 每日一练可选题量 */
export const DAILY_COUNT_OPTIONS = [10, 20, 30, 50];

/** 本地日历日 `YYYY-MM-DD`（与 core/stats.ts 同一口径，跨时区不会错位）。 */
export function todayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayKey(dt);
}

/** 字符串 → 32 位种子（FNV-1a），保证「同日期+同题库」永远得到同一批题。 */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：小而稳的可播种伪随机数发生器（用于确定性抽题与单测复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 今天的每日一练题单：确定性抽取（同一天同一题库恒为同一套）。 */
export function dailyQuestions(
  bank: QuizBank,
  dateKey: string,
  count: number,
  stats: StatsMap,
): QuizQuestion[] {
  const rules: ComposeRules = { count, chapters: [], types: [], scope: 'all', order: 'shuffle' };
  const rng = mulberry32(seedOf(`${dateKey}|${bank.name}`));
  return composeQuestions(bank, rules, stats, Date.parse(`${dateKey}T00:00:00`) || Date.now(), rng);
}

export interface DailyRecord {
  /** 题库名 */
  bank: string;
  /** 今天的目标题量 */
  total: number;
  /** 已完成（作答过）的题数 */
  done: number;
}

export type DailyStore = Record<string, DailyRecord>;

function load(): DailyStore {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as DailyStore;
  } catch {
    return {};
  }
}

function save(store: DailyStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 存储不可用时不影响当天练习本身 */
  }
}

/** 记一次每日一练进度（dateKey → 该题库的进度；done 取较大值，重做不会把进度打回去）。 */
export function recordDailyProgress(dateKey: string, bank: string, total: number, done: number): DailyStore {
  const store = load();
  const prev = store[dateKey];
  const next: DailyRecord = prev && prev.bank === bank
    ? { bank, total, done: Math.max(prev.done, done) }
    : { bank, total, done };
  store[dateKey] = next;
  save(store);
  return store;
}

export function dailyRecord(dateKey: string): DailyRecord | null {
  return load()[dateKey] ?? null;
}

export function dailyStore(): DailyStore {
  return load();
}

/** 某天是否完成了每日一练（做满目标题量才算「完成」，做一半只算有进度）。 */
export function isDailyDone(dateKey: string): boolean {
  const rec = load()[dateKey];
  return Boolean(rec && rec.total > 0 && rec.done >= rec.total);
}

/**
 * 每日一练连续天数：从今天（今天没练则从昨天）往前数，连续完成的日历日数。
 * 与 `core/stats.streak` 同一条规则：当天没练不清零，从昨天起算。
 */
export function dailyStreak(today = todayKey()): number {
  const store = load();
  const done = (d: string) => {
    const rec = store[d];
    return Boolean(rec && rec.total > 0 && rec.done >= rec.total);
  };
  let d = today;
  if (!done(d)) d = addDays(d, -1);
  let n = 0;
  while (done(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

/** 近 7 天「每日一练完成情况」（打卡热力用）。 */
export function last7Daily(today = todayKey()): Array<{ day: string; done: boolean; count: number }> {
  const store = load();
  const out: Array<{ day: string; done: boolean; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const rec = store[d];
    out.push({ day: d, done: Boolean(rec && rec.total > 0 && rec.done >= rec.total), count: rec?.done ?? 0 });
  }
  return out;
}

/** 备份：导出 / 恢复（合并，同日取较大进度）。 */
export function exportDaily(): DailyStore {
  return load();
}

export function importDaily(state: unknown): number {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 0;
  const store = load();
  let n = 0;
  for (const [day, raw] of Object.entries(state as Record<string, unknown>)) {
    const r = raw as Partial<DailyRecord>;
    if (!r || typeof r.bank !== 'string' || typeof r.total !== 'number' || typeof r.done !== 'number') continue;
    const prev = store[day];
    store[day] = prev && prev.bank === r.bank
      ? { bank: r.bank, total: r.total, done: Math.max(prev.done, r.done) }
      : { bank: r.bank, total: r.total, done: r.done };
    n += 1;
  }
  save(store);
  return n;
}
