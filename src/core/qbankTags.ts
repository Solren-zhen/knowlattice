/**
 * 题目分级标签：新题 / 易错 / 在学 / 已掌握 + 高频考点。
 *
 * 全部来自**真实存在的信号**，没有一条是编的：
 *   · 状态标签来自逐题历史（core/qbankStats 的 reps / wrong）；
 *   · 难度来自 FSRS 自己算出的 difficulty（1~10，是模型对这道题难度的估计）；
 *   · 高频来自「所在章节的题量」——同一考点出题越多，越值得优先刷，
 *     这是题库本身就能给出的信号，不需要外部「考频表」。
 *
 * 阈值集中在这里、可单测；界面只负责把标签画出来。
 */
import { type QuizBank, type QuizQuestion } from './qbank';
import type { QStat, StatsMap } from './qbankStats';

export type QTag = 'new' | 'weak' | 'learning' | 'solid' | 'highfreq';

export const Q_TAG_LABELS: Record<QTag, string> = {
  new: '新题',
  weak: '易错',
  learning: '在学',
  solid: '已掌握',
  highfreq: '高频',
};

/** 状态标签（不含高频；高频是叠加维度）。 */
export type QStatusTag = Exclude<QTag, 'highfreq'>;

/** 正确率的下界：样本少于这一步数不给「易错/已掌握」结论（1 次对错说明不了什么）。 */
export const TAG_MIN_REPS = 2;
export const WEAK_ACCURACY = 0.6;
export const SOLID_MIN_REPS = 2;

export function accuracyOf(stat: QStat | undefined): number {
  if (!stat || stat.reps <= 0) return 0;
  return Math.max(0, stat.reps - stat.wrong) / stat.reps;
}

/** 单题状态标签。没做过 = 新题；错过且正确率低 = 易错；全对且做过 ≥2 次 = 已掌握；其余 = 在学。 */
export function statusTagOf(stat: QStat | undefined): QStatusTag {
  if (!stat || stat.reps <= 0) return 'new';
  const acc = accuracyOf(stat);
  if (stat.wrong > 0 && acc < WEAK_ACCURACY) return 'weak';
  if (stat.wrong === 0 && stat.reps >= SOLID_MIN_REPS) return 'solid';
  return 'learning';
}

export type DifficultyBand = 'easy' | 'medium' | 'hard' | 'unknown';

export const DIFFICULTY_LABELS: Record<DifficultyBand, string> = {
  easy: '简单',
  medium: '适中',
  hard: '困难',
  unknown: '未评估',
};

/** FSRS difficulty（1~10）→ 难度档。没做过 = 未评估。 */
export function difficultyBand(stat: QStat | undefined): DifficultyBand {
  if (!stat || stat.reps <= 0) return 'unknown';
  if (stat.difficulty <= 3) return 'easy';
  if (stat.difficulty <= 6) return 'medium';
  return 'hard';
}

export interface TagContext {
  /** 章节 → 题量（无章节的归到 ''，不新开档位） */
  chapterCount: Map<string, number>;
  /** 「高频」阈值：章节题量的 75 分位，且不低于 MIN_HIGH_FREQ */
  highFreqMin: number;
}

/** 高频阈值下限：章节只有三五道题时不该叫「高频考点」 */
export const MIN_HIGH_FREQ = 5;

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/** 预计算标签上下文（每个题库算一次，避免逐个题目重算分布）。 */
export function buildTagContext(bank: QuizBank): TagContext {
  const chapterCount = new Map<string, number>();
  for (const q of bank.questions) {
    const key = q.chapter ?? '';
    chapterCount.set(key, (chapterCount.get(key) ?? 0) + 1);
  }
  const counts = [...chapterCount.values()].sort((a, b) => a - b);
  // 75 分位：题量最多的那一档章节算「高频」。单章节题库永远达不到（也就不会全标成高频）。
  const highFreqMin = Math.max(MIN_HIGH_FREQ, percentile(counts, 0.75));
  return { chapterCount, highFreqMin };
}

/** 这道题是否属于高频章节。 */
export function isHighFreq(q: QuizQuestion, ctx: TagContext): boolean {
  return (ctx.chapterCount.get(q.chapter ?? '') ?? 0) >= ctx.highFreqMin;
}

/** 题目的全部标签：状态标签 + 视情况叠加的「高频」。 */
export function tagsOf(q: QuizQuestion, stat: QStat | undefined, ctx: TagContext): QTag[] {
  const tags: QTag[] = [statusTagOf(stat)];
  if (isHighFreq(q, ctx)) tags.push('highfreq');
  return tags;
}

/** 按标签统计本题库题数（题库列表 / 高频考点页用）。 */
export function tagCounts(bank: QuizBank, stats: StatsMap): Record<QTag, number> {
  const ctx = buildTagContext(bank);
  const per = stats[bank.name] ?? {};
  const out: Record<QTag, number> = { new: 0, weak: 0, learning: 0, solid: 0, highfreq: 0 };
  for (const q of bank.questions) {
    out[statusTagOf(per[q.id])] += 1;
    if (isHighFreq(q, ctx)) out.highfreq += 1;
  }
  return out;
}

/** 难度分布（按逐题记录里的 FSRS difficulty）。没做过的计入 unknown。 */
export function difficultyCounts(bank: QuizBank, stats: StatsMap): Record<DifficultyBand, number> {
  const per = stats[bank.name] ?? {};
  const out: Record<DifficultyBand, number> = { easy: 0, medium: 0, hard: 0, unknown: 0 };
  for (const q of bank.questions) out[difficultyBand(per[q.id])] += 1;
  return out;
}

/** 题量最多的章节（高频考点排行）：附带该章易错题数。 */
export function highFreqChapters(
  bank: QuizBank,
  stats: StatsMap,
  top = 8,
): Array<{ chapter: string; total: number; weak: number }> {
  const per = stats[bank.name] ?? {};
  const agg = new Map<string, { total: number; weak: number }>();
  for (const q of bank.questions) {
    const key = q.chapter ?? '';
    const g = agg.get(key) ?? { total: 0, weak: 0 };
    g.total += 1;
    if (statusTagOf(per[q.id]) === 'weak') g.weak += 1;
    agg.set(key, g);
  }
  return [...agg]
    .map(([chapter, g]) => ({ chapter, ...g }))
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}
