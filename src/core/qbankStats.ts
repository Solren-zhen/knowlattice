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
 * 存储：localStorage 的**独立键**（`knowlattice-qbanks` 是整份重写的且已接近
 * 每站点约 5 MB 上限，不能并进去）。**必须紧凑**，算一笔账：
 *   一道题的完整 ts-fsrs Card JSON ≈ 180 字符（字段名每道题重复一遍）
 *   20,000 道答过的题：180 × 20k = 3.6 M 字符 ≈ 7.2 MB（UTF-16 计）→ 直接爆 5 MB
 *   改存数字数组后同一批量 ≈ 0.9 M 字符 ≈ 1.8 MB → 装得下
 * 时间戳另外存「epoch 分钟」而不是毫秒：13 位 → 8 位，两万道题再省约 100 KB。
 * FSRS 的间隔以天计，分钟精度绰绰有余。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating as FSRSRating, type Card } from 'ts-fsrs';

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

const KEY = 'knowlattice-qstats';
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

/**
 * 模块级缓存，按 localStorage 原始串比对（与 core/srs.ts 同策略）：
 * 题库列表每渲染一次就要读一遍统计，不能反复 JSON.parse 整张表；
 * 外部直接写存储（另一个标签页、测试里 clear）时下一次读会自己失效重解析。
 */
let cacheRaw: string | null = null;
let cache: StatsMap = {};
/** 内存里有**没落盘成功**的改动。见 loadStats / save 的注释。 */
let dirty = false;
/** 上一次落盘是否因配额失败。UI 据此提示一次，不静默丢学习记录。 */
let saveFailed = false;

export function loadStats(): StatsMap {
  let rawStr: string;
  try {
    rawStr = localStorage.getItem(KEY) ?? '{}';
  } catch {
    return cache;
  }
  // dirty：内存里有存不下的新记录。此时磁盘上那份是旧的，比对必然「不一致」，
  // 若因此重解析就会把刚答完、只是没存下的记录丢掉——静默丢学习数据。
  // 所以有未落盘改动时一律以内存为准。
  if (dirty) return cache;
  if (rawStr === cacheRaw) return cache;
  const out: StatsMap = {};
  try {
    const raw = JSON.parse(rawStr) as Record<string, unknown>;
    for (const [bank, questions] of Object.entries(raw)) {
      if (!questions || typeof questions !== 'object') continue;
      const per: BankStats = {};
      for (const [qid, tuple] of Object.entries(questions as Record<string, unknown>)) {
        const rec = fromTuple(tuple);
        if (rec) per[qid] = rec;
      }
      out[bank] = per;
    }
  } catch {
    // 整表损坏：当没做过处理，别让题库面板打不开
  }
  cache = out;
  cacheRaw = rawStr;
  return cache;
}

function save(stats: StatsMap) {
  cache = stats;
  const json = serialize(stats);
  try {
    localStorage.setItem(KEY, json);
    cacheRaw = json;
    dirty = false;
    saveFailed = false;
  } catch {
    // 存不下时**不能抛**：这时候用户刚答完一道题，抛出去会打断整个练习。
    // 置 dirty 让内存里的新记录活下来（见 loadStats），并置标志让 UI 提示一次。
    dirty = true;
    saveFailed = true;
  }
}

/**
 * 内存里是 QStat 对象（好读好改），**落盘必须转成紧凑数组**（省配额）。
 * 这两件事必须一起改：只加 toTuple 而忘了在这里调用，就会静默退回完整对象
 * ——开发机上看不出任何异常，直到真实用户撞上 5 MB 配额。见单测里的体积回归。
 */
function serialize(stats: StatsMap): string {
  const out: Record<string, Record<string, number[]>> = {};
  for (const [bank, per] of Object.entries(stats)) {
    const packed: Record<string, number[]> = {};
    for (const [qid, s] of Object.entries(per)) packed[qid] = toTuple(s);
    out[bank] = packed;
  }
  return JSON.stringify(out);
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
export function recordAnswer(bank: string, qid: string, correct: boolean, now = Date.now()): QStat {
  const stats = loadStats();
  const prev = stats[bank]?.[qid];
  const card = prev ? toCard(prev) : createEmptyCard(now);
  const next = f.next(card, new Date(now), correct ? FSRSRating.Good : FSRSRating.Again).card;
  const rec = fromCard(next, (prev?.wrong ?? 0) + (correct ? 0 : 1));
  const per: BankStats = { ...(stats[bank] ?? {}), [qid]: rec };
  save({ ...stats, [bank]: per });
  return rec;
}

/** 清空某个题库的逐题记录（题库删掉时一并清，别留孤儿数据占配额） */
export function dropBankStats(bank: string): void {
  const stats = loadStats();
  if (!(bank in stats)) return;
  const next = { ...stats };
  delete next[bank];
  save(next);
}

/** 某题库的整体进度：做过几道 / 错过几道 / 今天该复习几道 */
export function bankProgress(bank: string, qids: string[], now = Date.now()) {
  const per = loadStats()[bank] ?? {};
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
