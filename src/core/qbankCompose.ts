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
import { chaptersOf, type QuizBank, type QuizQuestion } from './qbank';
import { isDue, statOf, type QStat, type StatsMap } from './qbankStats';
import { isStarred, type StarMap } from './qbankStarred';
import {
  difficultyBand, isHighFreq, statusTagOf, type DifficultyBand, type QStatusTag, type TagContext,
} from './qbankTags';

export type ComposeScope = 'all' | 'new' | 'wrong' | 'due' | 'starred';
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
  /**
   * 只抽这些状态标签（新题/易错/在学/已掌握）；空数组 = 不限。
   * 标签信号来自 core/qbankTags，与逐题历史同源，不额外编造数据。
   */
  tags?: QStatusTag[];
  /** 只抽这些难度档（FSRS difficulty 分档）；空数组 = 不限。'unknown' = 还没做过 */
  difficulty?: DifficultyBand[];
  /** 只抽高频考点章节（章节题量达 75 分位及以上）；需要传 TagContext 才生效 */
  highFreqOnly?: boolean;
}

export const DEFAULT_RULES: ComposeRules = {
  count: 20,
  chapters: [],
  types: [],
  scope: 'all',
  order: 'shuffle',
  tags: [],
  difficulty: [],
  highFreqOnly: false,
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
  stars: StarMap = {},
  tagCtx?: TagContext,
): QuizQuestion[] {
  const chapters = new Set(rules.chapters);
  const types = new Set(rules.types);
  const tagSet = new Set(rules.tags ?? []);
  const diffSet = new Set(rules.difficulty ?? []);
  // 成员判定：章节筛选问的是「这道题属不属于所选章节」，多章节题任一章节命中就该被选中
  // （热力图已经按 chaptersOf 把两章都算过，这里只看 chapter 会让另一章筛不到它）。
  // 没有 chapters 的题 chaptersOf 退回 [chapter]；两处都空时折成 [''] —— 与旧代码
  // `chapters.has(q.chapter ?? '')` 逐字等价（空章节仍作为「未标注」那一档参与筛选，不新开档位）。
  const inSelectedChapters = (q: QuizQuestion): boolean => {
    const keys = chaptersOf(q);
    return (keys.length ? keys : ['']).some((c) => chapters.has(c));
  };
  return questions.filter((q) => {
    if (chapters.size && !inSelectedChapters(q)) return false;
    if (types.size && !types.has(q.type)) return false;
    const s = statOf(stats, bank, q.id);
    // 考点标签 / 难度：只在真的选了才过滤（空集合 = 不限，与章节口径一致）
    if (tagSet.size && !tagSet.has(statusTagOf(s))) return false;
    if (diffSet.size && !diffSet.has(difficultyBand(s))) return false;
    if (rules.highFreqOnly && tagCtx && !isHighFreq(q, tagCtx)) return false;
    switch (rules.scope) {
      case 'new':
        return !s;
      case 'wrong':
        return !!s && s.wrong > 0;
      case 'due':
        return !!s && isDue(s, now);
      case 'starred':
        // 收藏与「做没做过」正交：没作答过的题只要是重点也照样出现（与 qbankStats 分开存的用意）
        return isStarred(stars, bank, q.id);
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
  stars: StarMap = {},
  tagCtx?: TagContext,
): QuizQuestion[] {
  const pool = filterPool(bank.questions, rules, stats, bank.name, now, stars, tagCtx);
  const k = rules.count > 0 ? Math.min(rules.count, pool.length) : pool.length;
  const picked = weightedPick(pool, (q) => weightOf(statOf(stats, bank.name, q.id), now), k, rnd);
  if (rules.order === 'chapter') return sortByChapter(picked);
  if (rules.order === 'interleave') return interleaveByChapter(picked, rnd);
  return picked;
}

export function sortByChapter(questions: QuizQuestion[]): QuizQuestion[] {
  // 展示（排序）：只决定先后，一题必须落在唯一的位置上 —— 多章节题按主章节排（chapter 已是 chapters[0]），不做成员展开
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
    // 展示（主章节桶）：交错要求**每题只落一个桶**（展开成多个桶会把同一题排两遍），所以按主章节分桶
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
      // 展示：比较的是上面那个「主章节桶」的名字，与分桶口径保持一致
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
    // 展示：记下上一题的主章节桶，供下一轮 skip 用（与分桶口径一致）
    last = q.chapter ?? '';
  }
  return out;
}

/** 章节清单（组题弹窗用）：按自然序，带每章题数（多章节题在每个所属章节里各计一次，口径同 filterPool 的筛选） */
export function chapterCounts(questions: QuizQuestion[]): Array<{ chapter: string; count: number }> {
  const m = new Map<string, number>();
  for (const q of questions) {
    // 成员判定（与 filterPool 的章节筛选同一口径）：多章节题在每个所属章节里各计一次。
    // 弹窗的章节 chip 就是从这里来的，只计主章节会让「跨章题的另一章节」在选择器里
    // 根本没有入口 —— 热力图按 chaptersOf 把那一章标成薄弱，用户却筛不到它，两边口径就对不上。
    // 没有 chapters 的题仍只计一次（chapter 为空则计到 '' 那一档），与旧行为逐字相同。
    const keys = chaptersOf(q);
    for (const c of keys.length ? keys : ['']) m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m]
    .map(([chapter, count]) => ({ chapter, count }))
    // 展示（排序）：对章节名做自然序排序，与成员判定无关
    .sort((a, b) => chapterCompare(a.chapter, b.chapter));
}
