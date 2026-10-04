/**
 * 题库自动组题：规则过滤 + **加权随机**抽取。
 *
 * 与 `core/qbank.ts:pickQuestions` 的区别：那个是纯 Fisher-Yates，不传 n 就返回全部
 * ——「开始练习」= 把整库洗一遍，825 题必须全做完。这里回答的是「这一轮该做哪 20 题」。
 *
 * 权重只由三条**真实存在**的信号算出来（见 weightOf），没有一条是编的：
 * 错题次数来自 core/qbankStats.ts 的逐题历史，到期时间来自 FSRS 排程，其余一律不猜。
 * 刻意不做 IRT/CAT（题库没有难度标定数据，标定本身要几千次真实作答）也不做遗传算法组卷
 * （「N 题不重复 + 按章节配比」用加权随机就够，上进化算法是过度工程）。
 */
import type { QuizBank, QuizQuestion } from './qbank';
import { isDue, statOf, type QStat, type StatsMap } from './qbankStats';

export type ComposeScope = 'all' | 'new' | 'wrong' | 'due';
export type ComposeOrder = 'shuffle' | 'chapter' | 'interleave';
export type ComposeType = 'choice' | 'recall';

export interface ComposeRules {
  /** 抽几题；0 = 全部 */
  count: number;
  /** 只抽这些章节（`chapter` 字段原文）；空数组 = 全部章节 */
  chapters: string[];
  /** 只抽这些题型；空数组 = 全部题型 */
  types: ComposeType[];
  scope: ComposeScope;
  order: ComposeOrder;
}

export const DEFAULT_RULES: ComposeRules = {
  count: 20,
  chapters: [],
  types: [],
  scope: 'all',
  order: 'shuffle',
};

const DAY = 86_400_000;

/**
 * 一道题在加权随机里的权重。
 *   1. 错题加权：错过 n 次 → ×(1 + 2n)。错一次权重三倍，错三次七倍。
 *   2. FSRS 到期：已到期 → ×(1 + 逾期天数/10)，逾期 30 天封顶（×4）；
 *      未到期 → ×0.25。压下去但**不清零**，否则还没到期的题永远抽不到。
 *   3. 最近做过：×1/(1 + 距上次天数/7)，刚答完的题不会立刻又冒出来。
 * 没做过的题权重恒为 1：既不该被压（它们需要第一次曝光），也不该被过度抬
 * （否则新导入的大题库会把错题挤掉）。
 *
 * 地板 0.02：保证任何题都还有机会出现。加权随机不是 Top-N——每轮都抽同一批错题，
 * 会让人只练那几道，反而漏掉其余薄弱点。
 */
export function weightOf(stat: QStat | undefined, now: number): number {
  if (!stat) return 1;
  const overdue = (now - stat.due) / DAY;
  const since = Math.max(0, (now - stat.lastReview) / DAY);
  let w = 1 + 2 * stat.wrong;
  w *= overdue >= 0 ? 1 + Math.min(overdue, 30) / 10 : 0.25;
  w *= 1 / (1 + Math.min(since, 14) / 7);
  return Math.max(w, 0.02);
}

/**
 * 加权随机抽 k 题（Efraimidis–Spirakis 的 A-Res：每个元素取 `rnd()^(1/w)` 再取最大的 k 个）。
 * 一次遍历 + 一次排序，比「反复轮盘赌再删除」简单，且是精确的无放回加权抽样。
 * `rnd` 可注入，便于测试断言分布而不是断言随机数。
 */
export function weightedPick(
  pool: QuizQuestion[],
  weight: (q: QuizQuestion) => number,
  k: number,
  rnd: () => number = Math.random,
): QuizQuestion[] {
  const keyed = pool.map((q) => ({ q, key: Math.pow(rnd(), 1 / weight(q)) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, Math.max(0, k)).map((x) => x.q);
}

/**
 * 章节名的自然序：「第6章」排在「第10章」前面。
 * 直接 localeCompare 会把「第10章」排到「第2章」前面（逐字符比较），
 * 而「按章节顺序」是用户能一眼看出对错的排序。
 */
export function chapterCompare(a: string, b: string): number {
  const chunks = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const ax = chunks(a);
  const bx = chunks(b);
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numX = /^\d/.test(x);
    const numY = /^\d/.test(y);
    if (numX && numY) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 按规则过滤出候选池 */
export function filterPool(
  questions: QuizQuestion[],
  rules: ComposeRules,
  stats: StatsMap,
  bank: string,
  now = Date.now(),
): QuizQuestion[] {
  const chapters = new Set(rules.chapters);
  const types = new Set(rules.types);
  return questions.filter((q) => {
    if (chapters.size && !chapters.has(q.chapter ?? '')) return false;
    if (types.size && !types.has(q.type)) return false;
    const s = statOf(stats, bank, q.id);
    switch (rules.scope) {
      case 'new':
        return !s;
      case 'wrong':
        return !!s && s.wrong > 0;
      case 'due':
        return !!s && isDue(s, now);
      default:
        return true;
    }
  });
}

/** 一轮组题：过滤 → 加权随机 → 排序。`count = 0` 表示全要（仍按权重顺序，错题在前） */
export function composeQuestions(
  bank: QuizBank,
  rules: ComposeRules,
  stats: StatsMap,
  now = Date.now(),
  rnd: () => number = Math.random,
): QuizQuestion[] {
  const pool = filterPool(bank.questions, rules, stats, bank.name, now);
  const k = rules.count > 0 ? Math.min(rules.count, pool.length) : pool.length;
  const picked = weightedPick(pool, (q) => weightOf(statOf(stats, bank.name, q.id), now), k, rnd);
  if (rules.order === 'chapter') return sortByChapter(picked);
  if (rules.order === 'interleave') return interleaveByChapter(picked, rnd);
  return picked;
}

export function sortByChapter(questions: QuizQuestion[]): QuizQuestion[] {
  return [...questions].sort(
    (a, b) => chapterCompare(a.chapter ?? '', b.chapter ?? '') || chapterCompare(a.stem, b.stem),
  );
}

/**
 * 按章节交错排列：同一章节的题尽量不连续出现，章节内部保持入参的相对顺序。
 *
 * 为什么交错：顺序练习时人会顺着上一题的思路惯性做下去，相似知识点之间的边界被糊掉；
 * 交错强迫每道题都重新判断「这题该用哪条知识」，这正是它能提升辨别力的原因。
 *
 * 做法：先按 `chapter` 分桶（无 chapter 的归入 ''），每轮从「剩余最多、且与上一题不同章」
 * 的桶里取一题。取剩余最多的桶不是偏好——若先取小桶，最后大桶会剩一堆只能连着出；
 * 只有当某章题数超过其余各章总和时才会出现同章相邻，这是数学上无法避免的，不硬凑。
 * `rnd` 只在「剩余数相同的候选桶」之间取舍（默认 Math.random），用来打散每轮顺序，
 * 同时不破坏上述不连续保证；传固定 rnd 即可复现。只重排，不增删题目。
 */
export function interleaveByChapter(
  questions: QuizQuestion[],
  rnd: () => number = Math.random,
): QuizQuestion[] {
  // chapter 名在编译期不可知，且需要按首次出现顺序稳定迭代 → 动态键的 Map
  const buckets = new Map<string, QuizQuestion[]>();
  for (const q of questions) {
    const key = q.chapter ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(q);
    else buckets.set(key, [q]);
  }
  // 只保留章节名与读取游标：桶内保持入参相对顺序，取一题即游标后移
  interface ChapterBucket { chapter: string; items: QuizQuestion[]; at: number }
  const groups: ChapterBucket[] = [...buckets.entries()].map(([chapter, items]) => ({ chapter, items, at: 0 }));
  /** 取剩余最多的桶的下一题；剩余数相同则用 rnd 挑，保证结果可复现。
   *  `skip` 用于避开上一题的章节，allowSame=true 时不做该过滤（无解时的兜底）。 */
  const takeBiggest = (skip: string | null, allowSame: boolean): QuizQuestion | null => {
    let max = 0;
    let picks: ChapterBucket[] = [];
    for (const g of groups) {
      if (!allowSame && g.chapter === skip) continue;
      const left = g.items.length - g.at;
      if (left <= 0) continue;
      if (left > max) { max = left; picks = [g]; }
      else if (left === max) picks.push(g);
    }
    if (!picks.length) return null;
    const g = picks[Math.min(picks.length - 1, Math.floor(rnd() * picks.length))];
    return g.items[g.at++];
  };
  const out: QuizQuestion[] = [];
  let last: string | null = null;
  while (out.length < questions.length) {
    // 优先避开上一题的章节；若剩下的全在同一章（无解）再退回去取，避免死循环
    const q: QuizQuestion | null = takeBiggest(last, false) ?? takeBiggest(null, true);
    if (!q) break;
    out.push(q);
    last = q.chapter ?? '';
  }
  return out;
}

/** 章节清单（组题弹窗用）：按自然序，带每章题数 */
export function chapterCounts(questions: QuizQuestion[]): Array<{ chapter: string; count: number }> {
  const m = new Map<string, number>();
  for (const q of questions) {
    const c = q.chapter ?? '';
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m]
    .map(([chapter, count]) => ({ chapter, count }))
    .sort((a, b) => chapterCompare(a.chapter, b.chapter));
}
