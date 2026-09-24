/**
 * 题库组题的**逐题**历史：错题加权与 FSRS 逐题排程的唯一数据来源。
 *
 * 为什么必须新建：`QuizView` 的 `results` 是 session 内的（关掉面板即丢），
 * `core/mistakes.ts` 的主键是**笔记路径**而不是题目——「这道题错过几次」
 * 在原设计里无处可查；没有它就没有错题加权，也没有逐题排程。
 *
 * 为什么不并进 `core/srs.ts` 那张表：那张表的键是笔记/小节卡（`<path>#<标题>`），
 * 与题目 id 不在同一个键空间；混在一起会让「笔记复习卡片」的统计被十几万道题稀释。
 *
 * 存储：IndexedDB 独立记录。逐题只写入变化项，并兼容迁移旧 localStorage 数据。
 * 紧凑编码用于控制 IndexedDB 占用与备份体积：
 *   一道题的完整 ts-fsrs Card JSON ≈ 180 字符（字段名每道题重复一遍）
 *   20,000 道答过的题：180 × 20k = 3.6 M 字符 ≈ 7.2 MB（UTF-16 计）
 *   改存数字数组后同一批量 ≈ 0.9 M 字符 ≈ 1.8 MB
 * 时间戳另外存「epoch 分钟」而不是毫秒：13 位 → 8 位，两万道题再省约 100 KB。
 * FSRS 的间隔以天计，分钟精度绰绰有余。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating as FSRSRating, type Card } from 'ts-fsrs';
import { getAllQuestionStats, migrateLegacyQuestionStats, putQuestionStat, removeQuestionStats, replaceQuestionStats, type StoredQuestionStat } from '../storage/qbank';

/** 一道题的逐题记录。时间都是 epoch **毫秒**（存储层再折算成分钟）。 */
export interface QStat {
  /** 下次该复习的时间 */
  due: number;
  stability: number;
  difficulty: number;
  /** ts-fsrs 已废弃但仍在算的字段，原样保留以免重建 Card 时失真 */
  elapsed: number;
  scheduled: number;
  /** 当前处在第几个学习步骤 */
  steps: number;
  reps: number;
  lapses: number;
  /** ts-fsrs 的 State 枚举值 */
  state: number;
  /** 上次复习时间；0 = 还没复习过 */
  lastReview: number;
  /** 累计答错次数——错题加权的唯一依据 */
  wrong: number;
}

/** qid → 记录 */
export type BankStats = Record<string, QStat>;
/** 题库名 → qid → 记录。题库名只存一次，不按题目重复。 */
export type StatsMap = Record<string, BankStats>;

const LEGACY_KEY = 'knowlattice-qstats';
const MIN = 60_000;

const f = fsrs(generatorParameters());

/** 存储用紧凑数组的字段顺序。改这里必须同时改 toTuple/fromTuple 并跑往返测试。 */
const T = {
  due: 0, stability: 1, difficulty: 2, elapsed: 3, scheduled: 4,
  steps: 5, reps: 6, lapses: 7, state: 8, lastReview: 9, wrong: 10,
} as const;
const LEN = 11;

/** 还没复习过时 last_review 的占位值（0 会被误当成 1970 年，用 -1 明确表示「无」） */
const NO_REVIEW = -1;

function toTuple(s: QStat): number[] {
  const t = new Array<number>(LEN).fill(0);
  t[T.due] = Math.round(s.due / MIN);
  // FSRS 的 stability/difficulty 是双精度浮点，直接序列化常带出 3.2100000000000004
  // 这种尾巴。三位小数远超算法本身的精度需求（FSRS 自己的参数就是 2–4 位），
  // 而每道题能省下十几字符——两万道题就是几百 KB。
  t[T.stability] = round3(s.stability);
  t[T.difficulty] = round3(s.difficulty);
  t[T.elapsed] = s.elapsed;
  t[T.scheduled] = s.scheduled;
  t[T.steps] = s.steps;
  t[T.reps] = s.reps;
  t[T.lapses] = s.lapses;
  t[T.state] = s.state;
  t[T.lastReview] = s.lastReview ? Math.round(s.lastReview / MIN) : NO_REVIEW;
  t[T.wrong] = s.wrong;
  return t;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** 数组 → 记录；长度或类型不对返回 null（旧版/损坏数据按「没做过」处理，不让整表读不出来） */
function fromTuple(v: unknown): QStat | null {
  if (!Array.isArray(v) || v.length < LEN) return null;
  for (let i = 0; i < LEN; i++) if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return null;
  const n = v as number[];
  return {
    due: n[T.due] * MIN,
    stability: n[T.stability],
    difficulty: n[T.difficulty],
    elapsed: n[T.elapsed],
    scheduled: n[T.scheduled],
    steps: n[T.steps],
    reps: n[T.reps],
    lapses: n[T.lapses],
    state: n[T.state],
    lastReview: n[T.lastReview] === NO_REVIEW ? 0 : n[T.lastReview] * MIN,
    wrong: n[T.wrong],
  };
}

/** 模块级运行时缓存；组件挂载时异步从 IndexedDB 刷新。 */
let cache: StatsMap = {};
let initialized = false;
let saveFailed = false;

export async function initializeStats(): Promise<StatsMap> {
  let raw: string | null = null;
  let localStorageReadable = true;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    localStorageReadable = false;
  }
  const legacy: StoredQuestionStat[] = [];
  let canMarkMigrated = localStorageReadable && raw === null;
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid legacy stats');
      const parsed = value as Record<string, unknown>;
      for (const [bank, questions] of Object.entries(parsed)) {
        if (!questions || typeof questions !== 'object' || Array.isArray(questions)) continue;
        for (const [qid, tuple] of Object.entries(questions as Record<string, unknown>)) {
          if (fromTuple(tuple)) legacy.push({ bank, qid, tuple: tuple as number[] });
        }
      }
      canMarkMigrated = true;
    } catch {
      canMarkMigrated = false;
    }
  }
  if (canMarkMigrated) {
    await migrateLegacyQuestionStats(legacy);
    if (raw !== null) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Keep the IndexedDB copy authoritative if browser storage is unavailable.
      }
    }
  }
  const out: StatsMap = {};
  for (const { bank, qid, tuple } of await getAllQuestionStats()) {
    const rec = fromTuple(tuple);
    if (rec) (out[bank] ??= {})[qid] = rec;
  }
  cache = out;
  initialized = canMarkMigrated;
  return cache;
}

export function loadStats(): StatsMap {
  return cache;
}

export function resetQbankStatsForTests(): void {
  cache = {};
  initialized = false;
  saveFailed = false;
}

/** 取走「上次落盘失败」标志（读一次就清）。UI 用它提示一次，不重复打扰。 */
export function consumeSaveFailure(): boolean {
  const v = saveFailed;
  saveFailed = false;
  return v;
}

export function statOf(stats: StatsMap, bank: string, qid: string): QStat | undefined {
  return stats[bank]?.[qid];
}

export function isDue(stat: QStat, now = Date.now()): boolean {
  return stat.due <= now;
}

function toCard(s: QStat): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed,
    scheduled_days: s.scheduled,
    learning_steps: s.steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as Card['state'],
    last_review: s.lastReview ? new Date(s.lastReview) : undefined,
  };
}

function fromCard(c: Card, wrong: number): QStat {
  return {
    due: new Date(c.due).getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed: c.elapsed_days,
    scheduled: c.scheduled_days,
    steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.last_review ? new Date(c.last_review).getTime() : 0,
    wrong,
  };
}

/**
 * 记录一次作答并推进 FSRS 排程，返回新记录。
 *
 * 二值对错 → FSRS 四档评分的映射：对 = Good，错 = Again。
 * 不做「用时/犹豫」之类的推测——那是编造数据，宁可只喂真实信号。
 * `recall`（简答自判）与选择题共用这一条路径，因为两者拿到的都是用户自报的对错。
 */
export async function recordAnswer(bank: string, qid: string, correct: boolean, now = Date.now()): Promise<QStat> {
  const stats = initialized ? cache : await initializeStats();
  const prev = stats[bank]?.[qid];
  const card = prev ? toCard(prev) : createEmptyCard(now);
  const next = f.next(card, new Date(now), correct ? FSRSRating.Good : FSRSRating.Again).card;
  const rec = fromCard(next, (prev?.wrong ?? 0) + (correct ? 0 : 1));
  const per: BankStats = { ...(stats[bank] ?? {}), [qid]: rec };
  cache = { ...stats, [bank]: per };
  try {
    await putQuestionStat({ bank, qid, tuple: toTuple(rec) });
    saveFailed = false;
  } catch {
    saveFailed = true;
  }
  return rec;
}

/** 清空某个题库的逐题记录（题库删掉时一并清，别留孤儿数据占配额） */
export async function dropBankStats(bank: string, persist = true): Promise<void> {
  if (!initialized) await initializeStats();
  if (persist) await removeQuestionStats(bank);
  const next = { ...cache };
  delete next[bank];
  cache = next;
}

export async function exportQuestionStats(): Promise<StatsMap> {
  return initializeStats();
}

export async function importQuestionStats(state: unknown): Promise<void> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  if (!initialized) await initializeStats();
  const merged: StatsMap = { ...cache };
  for (const [bank, questions] of Object.entries(state as Record<string, unknown>)) {
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) continue;
    const records: BankStats = { ...(merged[bank] ?? {}) };
    for (const [qid, raw] of Object.entries(questions as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Partial<QStat>;
      if ([value.due, value.stability, value.difficulty, value.elapsed, value.scheduled, value.steps, value.reps, value.lapses, value.state, value.lastReview, value.wrong].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        records[qid] = value as QStat;
      }
    }
    merged[bank] = records;
  }
  const packed = Object.entries(merged).flatMap(([bank, questions]) =>
    Object.entries(questions).map(([qid, stat]) => ({ bank, qid, tuple: toTuple(stat) }))
  );
  await replaceQuestionStats(packed);
  cache = merged;
  initialized = true;
}

/** 某题库的整体进度：做过几道 / 错过几道 / 今天该复习几道 */
export function bankProgress(bank: string, qids: string[], stats: StatsMap = loadStats(), now = Date.now()) {
  const per = stats[bank] ?? {};
  let seen = 0;
  let wrong = 0;
  let due = 0;
  for (const id of qids) {
    const s = per[id];
    if (!s) continue;
    seen++;
    if (s.wrong > 0) wrong++;
    if (isDue(s, now)) due++;
  }
  return { total: qids.length, seen, wrong, due };
}
