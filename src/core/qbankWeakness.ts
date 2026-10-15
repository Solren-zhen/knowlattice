/**
 * 薄弱点可视化：把逐章掌握度（core/qbankStats.chapterMastery）压成两组展示数据。
 *
 *   1. `systemMastery`  按**学科**汇总的正确率条——题库题目的 chapter 是 `学科·章节`
 *      （见 core/qbankNotes 的约定），按 `·` 切开第一段就是学科；拿它画「哪一科最弱」。
 *   2. `radarAxes`      给雷达图用的轴：挑题量最多（最有代表性）的若干章，值 = 正确率 0~1。
 *
 * 只在有作答记录的章上算（chapterMastery 已经是这个口径：没练过的不进样本，
 * 免得整章没练以 0% 出现，把「还没练」误报成「掌握差」）。
 */
import type { ChapterMastery } from './qbankStats';

/** `生理学·第6章 消化和吸收` → `生理学`；没有分隔符时整段当学科名。 */
export function systemOf(chapter: string): string {
  const idx = chapter.indexOf('·');
  if (idx <= 0) return chapter;
  return chapter.slice(0, idx);
}

export interface SystemMastery {
  system: string;
  seen: number;
  wrong: number;
  accuracy: number;
}

/** 按学科汇总掌握度，最差的排前面。 */
export function systemMastery(mastery: ChapterMastery[]): SystemMastery[] {
  const groups = new Map<string, { seen: number; wrong: number }>();
  for (const m of mastery) {
    const key = systemOf(m.chapter) || '未标注';
    const g = groups.get(key) ?? { seen: 0, wrong: 0 };
    g.seen += m.seen;
    g.wrong += m.wrong;
    groups.set(key, g);
  }
  return [...groups]
    .map(([system, g]) => ({
      system,
      seen: g.seen,
      wrong: g.wrong,
      accuracy: g.seen > 0 ? (g.seen - g.wrong) / g.seen : 0,
    }))
    .sort((a, b) => a.accuracy - b.accuracy || b.seen - a.seen);
}

export interface RadarAxis {
  label: string;
  /** 正确率 0~1 */
  value: number;
  seen: number;
}

/**
 * 雷达图轴：取样本最多的若干章（题做得越多越有代表性）。
 * 少于 3 个轴画不成雷达图，调用方按 axes.length < 3 退回成条形展示。
 */
export function radarAxes(mastery: ChapterMastery[], max = 8): RadarAxis[] {
  return [...mastery]
    .sort((a, b) => b.seen - a.seen)
    .slice(0, max)
    .map((m) => ({ label: systemOf(m.chapter) === m.chapter ? m.chapter : m.chapter.slice(m.chapter.indexOf('·') + 1), value: m.accuracy, seen: m.seen }));
}

/** 最弱的章（样本 ≥ minSeen 才有资格入选）。 */
export function weakestChapters(mastery: ChapterMastery[], minSeen = 3, n = 5): ChapterMastery[] {
  return mastery.filter((m) => m.seen >= minSeen).sort((a, b) => a.accuracy - b.accuracy).slice(0, n);
}

/** 把多个题库的逐章掌握度按同名章节合并（供跨库的学科汇总与雷达图使用）。 */
export function mergeMastery(entries: ChapterMastery[]): ChapterMastery[] {
  const groups = new Map<string, { seen: number; wrong: number }>();
  for (const m of entries) {
    const g = groups.get(m.chapter) ?? { seen: 0, wrong: 0 };
    g.seen += m.seen;
    g.wrong += m.wrong;
    groups.set(m.chapter, g);
  }
  return [...groups].map(([chapter, g]) => {
    const accuracy = g.seen > 0 ? (g.seen - g.wrong) / g.seen : 0;
    return { chapter, seen: g.seen, wrong: g.wrong, accuracy, weak: g.seen >= 3 && accuracy < 0.6 };
  });
}
