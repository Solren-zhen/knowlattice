/**
 * 单词工坊的领域层：词库、判定、排期、持久化。
 *
 * 这里只放「与界面无关」的规则，视图只负责渲染和输入：
 * - 判定规则（大小写/空格不敏感，差一两个字母算「接近」而不是直接判错）；
 * - 间隔排期（连续答对把间隔按 1/2/4/7/15/30 天拉长，答错清零重来）；
 * - 词库解析（粘贴「单词 释义」一行一条，容错多种分隔符）；
 * - 两个 localStorage 键（记录 / 自定义词库），键名登记在 `storage/kv.ts`。
 *
 * 为什么不用 `core/srs`：那套是给笔记卡片用的（4 档评分 + 到期队列），
 * 这里是「拼写对不对」的二值结果，排期规则更简单，硬套会把两边的参数绑死。
 */
import { defineStore } from '../storage/kv';
import { dayKey } from './dateKey';

export { dayKey };

export interface Word {
  /** 英文词条（多词术语允许空格与连字符） */
  en: string;
  /** 中文释义 */
  zh: string;
  /** 美式音标，如 `/əˈnætəmi/`。自定义词条可以没有 */
  ipa?: string;
  /** 例句。自定义词条可以没有 */
  example?: string;
  /** 词源 / 构词提示（来自词库原始数据，可能没有） */
  origin?: string;
}

export type DrillMode = 'copy' | 'dictation' | 'recall';

export type Verdict = 'right' | 'near' | 'wrong';

export interface WordRecord {
  en: string;
  right: number;
  wrong: number;
  /** 连续答对次数（答错清零） */
  reps: number;
  /** 下次到期时间戳 */
  due: number;
  mastered: boolean;
  /** FSRS 稳定性：保持 90% 回忆率所能撑住的天数 */
  stability: number;
  /** FSRS 难度：1（容易）– 10（很难） */
  difficulty: number;
  /** 上次复习时间戳（换算遗忘曲线要用） */
  lastReview: number;
  /** 遗忘次数 */
  lapses: number;
}

/**
 * 排期参数。
 *
 * 用的是 **FSRS-4.5 的更新式与默认权重**（Anki 现行调度器的同源模型）：
 * 稳定性 S 表示「回忆率掉到 90% 需要的天数」，难度 D 随答错上调、随答对回调，
 * 下次间隔由 S 按目标保持率反推。权重是官方默认值，**没有按你个人的作答数据拟合**，
 * 所以它是「FSRS 风格」，不等于官方 FSRS 的最优表现。
 */
const FSRS_W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
] as const;

const TARGET_RETENTION = 0.9;
const DECAY = -0.5;
const FACTOR = 19 / 81;

const clampDifficulty = (d: number): number => Math.min(10, Math.max(1, d));
const clampStability = (s: number): number => Math.min(3650, Math.max(0.1, s));

/** 由稳定性反推下次间隔（天）：目标保持率 0.9 时约等于 S */
function intervalOfDays(stability: number): number {
  const raw = (stability / FACTOR) * (TARGET_RETENTION ** (1 / DECAY) - 1);
  return Math.min(365, Math.max(1, Math.round(raw)));
}

/** 连续答对这么多次就算掌握，之后不再进入「到期」队列 */
export const MASTER_REPS = 5;

export const DAY = 86_400_000;

/**
 * 词库清单。词表数据放在 `public/wordbanks/`，按需 fetch：
 * 6000 多个词条如果把释义/例句一起打进 JS，会让首屏包体直接涨 1.4MB，
 * 而绝大多数用户只练一个词库。
 *
 * 数据来源：zyronon/TypeWords（GPL-3.0），词表资源由 files.typewords.cc 提供，
 * 抓取时间与原始文件记录在各 JSON 的 `source` / `resource` 字段里。
 */
export interface WordBank {
  id: string;
  name: string;
  /** 词条数（与 JSON 里的 count 一致，供选择器先展示、无需等下载） */
  count: number;
  /** 相对 BASE_URL 的路径 */
  file: string;
}

export const WORD_BANKS: readonly WordBank[] = [
  { id: 'cet6', name: 'CET-6', count: 2345, file: 'wordbanks/cet6.json' },
  { id: 'kaoyan', name: '考研', count: 3725, file: 'wordbanks/kaoyan.json' },
];

const bankCache = new Map<string, Word[]>();

/** 校验一条词条：en 必须像英文，zh 必须非空；其他字段缺省即可 */
function decodeWord(raw: unknown): Word | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Partial<Word>;
  if (typeof w.en !== 'string' || !normWord(w.en)) return null;
  if (typeof w.zh !== 'string' || !w.zh.trim()) return null;
  return {
    en: w.en.trim(),
    zh: w.zh.trim(),
    ...(typeof w.ipa === 'string' && w.ipa.trim() ? { ipa: w.ipa.trim() } : {}),
    ...(typeof w.example === 'string' && w.example.trim() ? { example: w.example.trim() } : {}),
    ...(typeof w.origin === 'string' && w.origin.trim() ? { origin: w.origin.trim() } : {}),
  };
}

/**
 * 读取词库（带内存缓存）。失败时抛错，由界面显示「词库加载失败」而不是静默空列表。
 * 路径拼 `import.meta.env.BASE_URL`：dev 是 `/`、打包后是 `./`，两种情况都能取到。
 */
export async function loadBank(id: string): Promise<Word[]> {
  const cached = bankCache.get(id);
  if (cached) return cached;
  const bank = WORD_BANKS.find((b) => b.id === id);
  if (!bank) throw new Error(`未知词库：${id}`);
  const url = `${import.meta.env.BASE_URL}${bank.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`词库下载失败（HTTP ${res.status}）`);
  const data: unknown = await res.json();
  const raw = Array.isArray(data)
    ? data
    : (data as { words?: unknown }).words;
  if (!Array.isArray(raw)) throw new Error('词库格式不对：缺少 words 数组');
  const words = raw.map(decodeWord).filter((w): w is Word => w !== null);
  if (!words.length) throw new Error('词库是空的');
  bankCache.set(id, words);
  return words;
}

/** 仅供测试：清掉内存缓存 */
export function resetBankCacheForTests(): void {
  bankCache.clear();
}

/**
 * 归一化：判定、去重、键名都用它。
 * 大小写、首尾空格、连续空格、各种连字符与撇号都不该影响「打对没打对」。
 */
export function normWord(input: string): string {
  return input
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 判定一次拼写。
 * `near` = 只差一两个字母：仍记为错（拼写不准就是不准），但界面会说「差一点」，
 * 而不是把 `metastatis` 和 `metastasis` 当成完全不会。
 */
export function judge(input: string, target: string): Verdict {
  const a = normWord(input);
  const b = normWord(target);
  if (!a) return 'wrong';
  if (a === b) return 'right';
  const tolerance = b.length >= 9 ? 2 : 1;
  return editDistance(a, b) <= tolerance ? 'near' : 'wrong';
}

export type DiffState = 'ok' | 'bad';

export interface DiffCell {
  ch: string;
  state: DiffState;
}

export interface CharDiff {
  /** 你打的字，逐字符标记对/错 */
  input: DiffCell[];
  /** 正确写法，逐字符标记「这里你没打对」 */
  target: DiffCell[];
  /** 多打的字符数 */
  extra: number;
  /** 漏打的字符数 */
  missing: number;
}

/**
 * 逐字符对齐：把「你的输入」和「正确写法」按最长公共子序列对齐。
 *
 * 为什么不是简单按位比对：少打一个字母时，按位比对会让后面每个字母都变红，
 * 看起来像「全错」。LCS 对齐后只有真正漏掉的那个位置标红，其余仍是对得上。
 */
export function diffChars(input: string, target: string): CharDiff {
  const a = Array.from(normWord(input));
  const b = Array.from(normWord(target));
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const inputCells: DiffCell[] = [];
  const targetCells: DiffCell[] = [];
  let extra = 0;
  let missing = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      inputCells.push({ ch: a[i], state: 'ok' });
      targetCells.push({ ch: b[j], state: 'ok' });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      inputCells.push({ ch: a[i], state: 'bad' });
      extra += 1;
      i += 1;
    } else {
      targetCells.push({ ch: b[j], state: 'bad' });
      missing += 1;
      j += 1;
    }
  }
  while (i < n) {
    inputCells.push({ ch: a[i], state: 'bad' });
    extra += 1;
    i += 1;
  }
  while (j < m) {
    targetCells.push({ ch: b[j], state: 'bad' });
    missing += 1;
    j += 1;
  }

  return { input: inputCells, target: targetCells, extra, missing };
}

/** 一轮练习之后的记录：按 FSRS 更新稳定性与难度 */
export function nextRecord(
  rec: WordRecord | undefined,
  en: string,
  correct: boolean,
  now = Date.now(),
): WordRecord {
  const grade = correct ? 3 : 1;

  // 新卡：用 FSRS 的初始稳定性/难度
  if (!rec) {
    const stability = clampStability(FSRS_W[grade - 1]);
    const difficulty = clampDifficulty(FSRS_W[4] - Math.exp(FSRS_W[5] * (grade - 3)) + 1);
    return {
      en,
      right: correct ? 1 : 0,
      wrong: correct ? 0 : 1,
      reps: correct ? 1 : 0,
      due: now + intervalOfDays(stability) * DAY,
      mastered: false,
      stability,
      difficulty,
      lastReview: now,
      lapses: correct ? 0 : 1,
    };
  }

  const elapsedDays = Math.max(0, (now - (rec.lastReview || now)) / DAY);
  const stabilityBefore = Math.max(0.1, rec.stability || 1);
  const retrievability = Math.exp((Math.log(TARGET_RETENTION) * elapsedDays) / stabilityBefore);

  let stability: number;
  if (correct) {
    // 记得：稳定性按「难度越低、可提取性越低，增益越大」增长
    stability = clampStability(
      stabilityBefore *
        (1 +
          Math.exp(FSRS_W[8]) *
            (11 - rec.difficulty) *
            stabilityBefore ** -FSRS_W[9] *
            (Math.exp(FSRS_W[10] * (1 - retrievability)) - 1)),
    );
  } else {
    // 忘了：稳定性回落到「遗忘后的新值」，并记一次 lapse
    stability = clampStability(
      FSRS_W[11] *
        rec.difficulty ** -FSRS_W[12] *
        ((stabilityBefore + 1) ** FSRS_W[13] - 1) *
        Math.exp(FSRS_W[14] * (1 - retrievability)),
    );
  }

  const difficulty = clampDifficulty(rec.difficulty - FSRS_W[6] * (grade - 3));
  const reps = correct ? rec.reps + 1 : 0;

  return {
    en,
    right: rec.right + (correct ? 1 : 0),
    wrong: rec.wrong + (correct ? 0 : 1),
    reps,
    due: now + intervalOfDays(stability) * DAY,
    mastered: reps >= MASTER_REPS,
    stability,
    difficulty,
    lastReview: now,
    lapses: rec.lapses + (correct ? 0 : 1),
  };
}

export type QueueFilter = 'due' | 'wrong' | 'all';

export interface QueueOptions {
  limit: number;
  now?: number;
  filter?: QueueFilter;
}

/**
 * 挑这一轮要练的词。
 *
 * 排序（稳定、可测）：生词 → 到期 → 其余；同档里到期早的优先，再按错得多的优先。
 * `wrong` 只收「错过且未掌握」，`all` 收全部（复习模式）。
 */
export function pickQueue(
  words: readonly Word[],
  records: Readonly<Record<string, WordRecord>>,
  { limit, now = Date.now(), filter = 'due' }: QueueOptions,
): Word[] {
  const seen = new Set<string>();
  const pool = words.filter((word) => {
    const key = normWord(word.en);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    const rec = records[key];
    if (filter === 'all') return true;
    if (filter === 'wrong') return Boolean(rec && rec.wrong > 0 && !rec.mastered);
    return !rec || (!rec.mastered && rec.due <= now);
  });

  const tier = (word: Word): number => {
    const rec = records[normWord(word.en)];
    if (!rec) return 0;
    return rec.due <= now ? 1 : 2;
  };

  return pool
    .map((word, index) => ({ word, index }))
    .sort((a, b) => {
      const ta = tier(a.word);
      const tb = tier(b.word);
      if (ta !== tb) return ta - tb;
      const ra = records[normWord(a.word.en)];
      const rb = records[normWord(b.word.en)];
      const dueDiff = (ra?.due ?? 0) - (rb?.due ?? 0);
      if (dueDiff !== 0) return dueDiff;
      const wrongDiff = (rb?.wrong ?? 0) - (ra?.wrong ?? 0);
      if (wrongDiff !== 0) return wrongDiff;
      return a.index - b.index;
    })
    .slice(0, Math.max(0, limit))
    .map((item) => item.word);
}

/** 每天的新词 / 复习配额（可在界面上改，默认值见 DEFAULT_SETTINGS） */
export const DEFAULT_NEW_LIMIT = 10;
export const DEFAULT_REVIEW_LIMIT = 20;

/** 每轮题量的可选项（界面的下拉框与设置归一化共用） */
export const DRILL_SIZES = [5, 10, 20, 30] as const;
export const NEW_LIMIT_MAX = 100;
export const REVIEW_LIMIT_MAX = 200;

/** 设置存储格式版本：首次落地时的临时数据没有这个字段，读到就回退到新默认（听写） */
export const SETTINGS_VERSION = 2;

/**
 * 上次使用的词库 / 模式 / 题量与每日配额。
 *
 * 存在 localStorage 里，重开面板不用每次重新选一遍；坏数据一律回退默认值。
 * 音效开关不在这里——那是 `core/keySound` 的键，避免两个地方写同一个开关。
 */
export interface DrillSettings {
  version: number;
  bankId: string;
  mode: DrillMode;
  size: number;
  newLimit: number;
  reviewLimit: number;
}

export const DEFAULT_SETTINGS: DrillSettings = {
  version: SETTINGS_VERSION,
  bankId: 'cet6',
  // 默认听写：打开就是真听写，不再先把单词摊在题面上；想先熟悉拼写可以切「跟打」
  mode: 'dictation',
  size: 10,
  newLimit: DEFAULT_NEW_LIMIT,
  reviewLimit: DEFAULT_REVIEW_LIMIT,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 归一化设置：未知词库 / 模式 / 题量都回退，配额夹在可用范围内 */
export function normalizeSettings(raw: unknown, fallback: DrillSettings = DEFAULT_SETTINGS): DrillSettings {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<DrillSettings>;
  // 没有版本号的是首次落地的临时数据（当时默认还是「跟打」），不沿用，回到新默认
  if (src.version !== SETTINGS_VERSION) return fallback;
  const bankId =
    typeof src.bankId === 'string' &&
    (src.bankId === 'custom' || WORD_BANKS.some((bank) => bank.id === src.bankId))
      ? src.bankId
      : fallback.bankId;
  const mode: DrillMode =
    src.mode === 'copy' || src.mode === 'dictation' || src.mode === 'recall'
      ? src.mode
      : fallback.mode;
  const size = (DRILL_SIZES as readonly number[]).includes(Number(src.size))
    ? Number(src.size)
    : fallback.size;
  return {
    version: SETTINGS_VERSION,
    bankId,
    mode,
    size,
    newLimit: clampInt(src.newLimit, 1, NEW_LIMIT_MAX, fallback.newLimit),
    reviewLimit: clampInt(src.reviewLimit, 1, REVIEW_LIMIT_MAX, fallback.reviewLimit),
  };
}

export interface DayStudy {
  newWords: number;
  reviews: number;
  correct: number;
  total: number;
}

export type DrillDaily = Record<string, DayStudy>;

const EMPTY_DAY: DayStudy = { newWords: 0, reviews: 0, correct: 0, total: 0 };

/** 记一笔今日完成量：新词与复习分开计数，正确率按总数算 */
export function recordDaily(
  daily: DrillDaily,
  entry: { isNew: boolean; ok: boolean; now?: number },
): DrillDaily {
  const key = dayKey(entry.now ?? Date.now());
  const cur = daily[key] ?? EMPTY_DAY;
  return {
    ...daily,
    [key]: {
      newWords: cur.newWords + (entry.isNew ? 1 : 0),
      reviews: cur.reviews + (entry.isNew ? 0 : 1),
      correct: cur.correct + (entry.ok ? 1 : 0),
      total: cur.total + 1,
    },
  };
}

export interface DailyPlan {
  newLimit: number;
  reviewLimit: number;
  done: DayStudy;
  remainingNew: number;
  remainingReview: number;
}

export function dailyPlan(
  daily: DrillDaily,
  newLimit = DEFAULT_NEW_LIMIT,
  reviewLimit = DEFAULT_REVIEW_LIMIT,
  now = Date.now(),
): DailyPlan {
  const done = daily[dayKey(now)] ?? EMPTY_DAY;
  return {
    newLimit,
    reviewLimit,
    done,
    remainingNew: Math.max(0, newLimit - done.newWords),
    remainingReview: Math.max(0, reviewLimit - done.reviews),
  };
}

/** 最近 N 天的正确率序列（缺数据的天补 0，便于画等距折线） */
export function dailySeries(
  daily: DrillDaily,
  days = 14,
  now = Date.now(),
): Array<{ key: string; total: number; correct: number; rate: number }> {
  const out: Array<{ key: string; total: number; correct: number; rate: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const at = now - i * DAY;
    const key = dayKey(at);
    const d = daily[key];
    out.push({
      key,
      total: d?.total ?? 0,
      correct: d?.correct ?? 0,
      rate: d && d.total > 0 ? d.correct / d.total : 0,
    });
  }
  return out;
}

export interface DailyQueueOptions {
  newLimit: number;
  reviewLimit: number;
  now?: number;
  daily?: DrillDaily;
}

/**
 * 按今日配额挑词：先补新词额度，再补到期复习额度。
 *
 * 两个额度都满了才退回普通到期队列 —— 否则「开始练习」会在配额用完时变成空按钮。
 */
export function pickDailyQueue(
  words: readonly Word[],
  records: Readonly<Record<string, WordRecord>>,
  { newLimit, reviewLimit, now = Date.now(), daily = {} }: DailyQueueOptions,
): Word[] {
  const plan = dailyPlan(daily, newLimit, reviewLimit, now);
  const seen = new Set<string>();
  const fresh: Word[] = [];
  const due: Array<{ word: Word; at: number }> = [];

  for (const word of words) {
    const key = normWord(word.en);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rec = records[key];
    if (!rec) fresh.push(word);
    else if (!rec.mastered && rec.due <= now) due.push({ word, at: rec.due });
  }

  const picked = [
    ...fresh.slice(0, plan.remainingNew),
    ...due.sort((a, b) => a.at - b.at).slice(0, plan.remainingReview).map((item) => item.word),
  ];
  if (picked.length) return picked;

  // 兜底退回普通队列。默认 filter:'due' 的条件里 `!rec` 会放行生词，把每日新词配额绕掉，
  // 所以先只给**练过**的词；一个练过的都没有（词库全新）再放开全部——兜底的底线是不返回空。
  const practiced = pickQueue(
    words.filter((w) => records[normWord(w.en)]),
    records,
    { limit: Math.max(1, newLimit + reviewLimit), now },
  );
  return practiced.length ? practiced : pickQueue(words, records, { limit: Math.max(1, newLimit + reviewLimit), now });
}

/** Fisher-Yates；`rand` 可注入，测试里给固定序列 */
export function shuffle<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SEPARATOR = /\t|\||=|,|，|;|；|:|\s+-\s+|\s{2,}/;

/**
 * 解析粘贴进来的词库。一行一条，常见写法都认：
 *   `anatomy 解剖学` / `anatomy\t解剖学` / `anatomy,解剖学` / `anatomy = 解剖学`
 * 认不出的行直接跳过（返回 skipped 计数），不因为一行脏数据整批失败。
 */
export function parseWordList(text: string): { words: Word[]; skipped: number } {
  const words: Word[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let en = '';
    let zh = '';
    const parts = line.split(SEPARATOR);
    if (parts.length >= 2) {
      en = parts[0].trim();
      zh = parts.slice(1).join(' ').trim();
    } else {
      // 没有显式分隔符时按「中文起点」切：英文在前、中文在后
      const match = line.match(/^([A-Za-z][A-Za-z'\-\s]*?)\s*([\u3400-\u9fff].*)$/);
      if (match) {
        en = match[1].trim();
        zh = match[2].trim();
      }
    }

    const key = normWord(en);
    if (!key || !zh || !/^[a-z][a-z'\-\s]*$/.test(key) || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    words.push({ en: en.replace(/\s+/g, ' '), zh });
  }

  return { words, skipped };
}

export interface WordBankImport {
  words: Word[];
  skipped: number;
  /** JSON 结构不对时的可读原因；文本行解析不会返回 error，只记 skipped */
  error?: string;
}

/**
 * 自定义词库文件：`.json` 支持本项目的 `{words:[{en,zh,...}]}` 或裸数组；
 * `.txt/.md/.csv` 走与粘贴框相同的逐行解析。JSON 里的 ipa/example/origin 会保留。
 */
export function parseWordBankFile(name: string, text: string): WordBankImport {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  const looksJson = /\.json$/i.test(name) || /^[[{]/.test(trimmed);
  if (!looksJson) return parseWordList(text);
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { words: [], skipped: 0, error: 'JSON 解析失败：请确认文件是完整的词库 JSON。' };
  }
  const list = Array.isArray(raw) ? raw : (raw as { words?: unknown } | null)?.words;
  if (!Array.isArray(list)) {
    return { words: [], skipped: 0, error: 'JSON 里没有 words 数组，也没有裸数组。' };
  }
  const words: Word[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of list) {
    const word = decodeWord(item);
    const key = word ? normWord(word.en) : '';
    if (!word || !key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    words.push(word);
  }
  return { words, skipped };
}

export interface DrillSummary {
  tracked: number;
  mastered: number;
  weak: number;
  dueNow: number;
}

export function drillSummary(
  records: Readonly<Record<string, WordRecord>>,
  now = Date.now(),
): DrillSummary {
  let mastered = 0;
  let weak = 0;
  let dueNow = 0;
  for (const rec of Object.values(records)) {
    if (rec.mastered) mastered += 1;
    else if (rec.wrong > 0) weak += 1;
    if (!rec.mastered && rec.due <= now) dueNow += 1;
  }
  return { tracked: Object.keys(records).length, mastered, weak, dueNow };
}

/**
 * 只统计**当前词库**的汇总。
 *
 * `drillSummary` 是全局口径，适合「所有练过的词」；但面板抬头写的是
 * 「CET-6 · 已掌握 N」，那个 N 必须是 CET-6 自己的。否则切到我的词库后，
 * 抬头仍显示别的词库的掌握数，和下面的错词本对不上。
 */
export function bankSummary(
  words: readonly Word[],
  records: Readonly<Record<string, WordRecord>>,
  now = Date.now(),
): DrillSummary {
  const seen = new Set<string>();
  let tracked = 0;
  let mastered = 0;
  let weak = 0;
  let dueNow = 0;
  for (const word of words) {
    const key = normWord(word.en);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rec = records[key];
    if (!rec) continue;
    tracked += 1;
    if (rec.mastered) mastered += 1;
    else if (rec.wrong > 0) weak += 1;
    if (!rec.mastered && rec.due <= now) dueNow += 1;
  }
  return { tracked, mastered, weak, dueNow };
}

/** 错词本：错过且未掌握，错得多的在前 */
export function wrongBook(
  words: readonly Word[],
  records: Readonly<Record<string, WordRecord>>,
): Word[] {
  const index = new Map(words.map((word) => [normWord(word.en), word]));
  return Object.values(records)
    .filter((rec) => rec.wrong > 0 && !rec.mastered)
    .sort((a, b) => b.wrong - a.wrong || b.reps - a.reps)
    .flatMap((rec) => {
      const word = index.get(normWord(rec.en));
      return word ? [word] : [];
    });
}

/** 某个词在排期里的位置，供词库列表标注 */
export type WordState = 'new' | 'due' | 'later' | 'mastered';

export function wordState(rec: WordRecord | undefined, now = Date.now()): WordState {
  if (!rec) return 'new';
  if (rec.mastered) return 'mastered';
  return rec.due <= now ? 'due' : 'later';
}

/**
 * 在当前词库里查词。
 *
 * 排序按「英文前缀 → 英文包含 → 中文包含」三段，同段保持词库原序；
 * 2–4k 条全表扫一遍是微秒级，不需要建索引。
 */
export function searchWords(words: readonly Word[], query: string, limit = 60): Word[] {
  const raw = query.trim();
  if (!raw) return [];
  const q = raw.toLowerCase();
  const prefix: Word[] = [];
  const contain: Word[] = [];
  const zhHits: Word[] = [];

  for (const word of words) {
    const en = word.en.toLowerCase();
    if (en.startsWith(q)) prefix.push(word);
    else if (en.includes(q)) contain.push(word);
    else if (word.zh.includes(raw)) zhHits.push(word);
  }

  return [...prefix, ...contain, ...zhHits].slice(0, limit);
}

function decodeRecords(raw: unknown, fallback: Record<string, WordRecord>): Record<string, WordRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const out: Record<string, WordRecord> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Partial<WordRecord>;
    if (typeof r.en !== 'string' || !r.en) continue;
    const reps = Number.isFinite(r.reps) ? Number(r.reps) : 0;
    const wrong = Number.isFinite(r.wrong) ? Number(r.wrong) : 0;
    out[normWord(key)] = {
      en: r.en,
      right: Number.isFinite(r.right) ? Number(r.right) : 0,
      wrong,
      reps,
      due: Number.isFinite(r.due) ? Number(r.due) : 0,
      mastered: r.mastered === true,
      // 旧记录（只有 reps/due）迁移成 FSRS 字段：稳定性按连对次数估，难度取中值
      stability: Number.isFinite(r.stability) ? clampStability(Number(r.stability)) : Math.max(1, reps),
      difficulty: Number.isFinite(r.difficulty) ? clampDifficulty(Number(r.difficulty)) : 5,
      lastReview: Number.isFinite(r.lastReview) ? Number(r.lastReview) : 0,
      lapses: Number.isFinite(r.lapses) ? Number(r.lapses) : wrong,
    };
  }
  return out;
}

function decodeDaily(raw: unknown, fallback: DrillDaily): DrillDaily {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const out: DrillDaily = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
    const v = value as Partial<DayStudy>;
    const n = (x: unknown) => (Number.isFinite(x) ? Math.max(0, Number(x)) : 0);
    out[key] = { newWords: n(v.newWords), reviews: n(v.reviews), correct: n(v.correct), total: n(v.total) };
  }
  return out;
}

function decodeWords(raw: unknown, fallback: Word[]): Word[] {
  if (!Array.isArray(raw)) return fallback;
  const out: Word[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Partial<Word>;
    if (typeof w.en !== 'string' || typeof w.zh !== 'string') continue;
    if (!normWord(w.en) || !w.zh.trim()) continue;
    out.push({ en: w.en.trim(), zh: w.zh.trim() });
  }
  return out;
}

export const recordsStore = defineStore<Record<string, WordRecord>>({
  key: 'knowlattice-word-drill',
  fallback: {},
  decode: decodeRecords,
});

/** 外部（手机回传）合并记录后广播，让已打开的单词工坊刷新队列与错词本。 */
export const RECORDS_UPDATED_EVENT = 'knowlattice-word-records-updated';

export const customBankStore = defineStore<Word[]>({
  key: 'knowlattice-word-drill-bank',
  fallback: [],
  decode: decodeWords,
});

export const loadRecords = (): Record<string, WordRecord> => recordsStore.read();
export const saveRecords = (records: Record<string, WordRecord>): void => recordsStore.write(records);
export const loadCustomWords = (): Word[] => customBankStore.read();
export const saveCustomWords = (words: Word[]): void => customBankStore.write(words);

export const dailyStore = defineStore<DrillDaily>({
  key: 'knowlattice-word-drill-daily',
  fallback: {},
  decode: decodeDaily,
});

export const loadDaily = (): DrillDaily => dailyStore.read();
export const saveDaily = (daily: DrillDaily): void => dailyStore.write(daily);

export const settingsStore = defineStore<DrillSettings>({
  key: 'knowlattice-word-drill-settings',
  fallback: DEFAULT_SETTINGS,
  decode: normalizeSettings,
});

export const loadSettings = (): DrillSettings => settingsStore.read();
export const saveSettings = (settings: Omit<DrillSettings, 'version'>): void =>
  settingsStore.write({ ...settings, version: SETTINGS_VERSION });

/** 发音：浏览器自带语音（不需要任何外部服务），不可用时静默跳过 */
export function speakWord(en: string): boolean {
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') return false;
  try {
    const utter = new SpeechSynthesisUtterance(en);
    utter.lang = 'en-US';
    utter.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}

/** 朗读一段英文（短文背诵用）；与 speakWord 共用同一套浏览器语音，不可用时静默失败 */
export function speakText(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') return false;
  try {
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'en-US';
    utter.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}

/** 输入提示：首字母 + 长度（不直接泄露答案） */
export function hintOf(en: string): string {
  const clean = en.replace(/\s+/g, ' ');
  return `${clean[0] ?? ''}${'·'.repeat(Math.max(0, clean.length - 1))}（${clean.replace(/[^A-Za-z]/g, '').length} 个字母）`;
}

export interface DrillBackup {
  records: Record<string, WordRecord>;
  customBank: Word[];
  daily: DrillDaily;
  settings: DrillSettings;
}

/** 备份用：单词工坊的全部本机数据（练习记录 / 自定义词库 / 每日统计 / 设置）。 */
export function exportDrillBackup(): DrillBackup {
  return {
    records: loadRecords(),
    customBank: loadCustomWords(),
    daily: loadDaily(),
    settings: loadSettings(),
  };
}

function isDefaultSettings(settings: DrillSettings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof DrillSettings>)
    .every((key) => settings[key] === DEFAULT_SETTINGS[key]);
}

/** 恢复用：记录 / 词库 / 每日统计按身份键只补不覆盖；设置仅在本机仍是默认值时采用。 */
export function importDrillBackup(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const data = incoming as Partial<DrillBackup>;
  let added = 0;
  let kept = 0;

  const records = loadRecords();
  const freshRecords: Record<string, WordRecord> = {};
  if (data.records && typeof data.records === 'object' && !Array.isArray(data.records)) {
    for (const [word, record] of Object.entries(data.records as Record<string, unknown>)) {
      if (!record || typeof record !== 'object') continue;
      if (records[word]) {
        kept += 1;
        continue;
      }
      freshRecords[word] = record as WordRecord;
      added += 1;
    }
  }
  if (Object.keys(freshRecords).length > 0) saveRecords({ ...records, ...freshRecords });

  const bank = loadCustomWords();
  const seen = new Set(bank.map((w) => w.en.trim().toLowerCase()));
  const freshWords: Word[] = [];
  if (Array.isArray(data.customBank)) {
    for (const item of data.customBank) {
      if (!item || typeof item.en !== 'string' || typeof item.zh !== 'string') continue;
      const key = item.en.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        kept += 1;
        continue;
      }
      seen.add(key);
      freshWords.push({ en: item.en.trim(), zh: item.zh.trim() });
      added += 1;
    }
  }
  if (freshWords.length > 0) saveCustomWords([...bank, ...freshWords]);

  const daily = loadDaily();
  const freshDaily: DrillDaily = {};
  if (data.daily && typeof data.daily === 'object' && !Array.isArray(data.daily)) {
    for (const [day, record] of Object.entries(data.daily as Record<string, unknown>)) {
      if (!record || typeof record !== 'object') continue;
      if (daily[day]) {
        kept += 1;
        continue;
      }
      freshDaily[day] = record as DayStudy;
      added += 1;
    }
  }
  if (Object.keys(freshDaily).length > 0) saveDaily({ ...daily, ...freshDaily });

  if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    const current = loadSettings();
    if (isDefaultSettings(current)) {
      const next = normalizeSettings(data.settings, current);
      if (!isDefaultSettings(next)) {
        saveSettings(next);
        added += 1;
      }
    } else {
      kept += 1;
    }
  }

  return { added, kept };
}
