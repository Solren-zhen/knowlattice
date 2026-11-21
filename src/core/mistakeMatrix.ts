/**
 * 章节 × 错因矩阵（P0-3）：把「哪一章差」和「为什么差」叠在同一张表上。
 *
 * 现状是两个独立的块：热力图只说哪章错得多（core/mistakes.chapterHeat），错因分布只说
 * 全库四类占比（reasonCounts）—— 于是「循环系统错了 12 题」看不出是没背下来还是概念混了，
 * 而这两者的下一步动作完全不同（前者回看原文，后者并列对照）。
 *
 * 正确率一栏来自 core/qbankStats.chapterMastery，按**章节名精确匹配**。错题章节来自笔记
 * frontmatter、掌握度来自题库 question.chapter，两套命名不一定对齐：对不上就留 null
 * （界面显示「—」），不猜、不做模糊匹配 —— 猜错会给出错误的复习建议。
 */
import { MISTAKE_REASONS, MISTAKE_REASON_LABELS, type MistakeMap, type MistakeReason } from './mistakes';
import type { ChapterMastery } from './qbankStats';

export type CauseKey = MistakeReason | 'unlabeled';

/** 列顺序固定（知识 → 混淆 → 审题 → 推理 → 未标注）：行内数字才能横向比 */
export const CAUSE_KEYS: CauseKey[] = [...MISTAKE_REASONS, 'unlabeled'];

export const CAUSE_LABELS: Record<CauseKey, string> = {
  ...MISTAKE_REASON_LABELS,
  unlabeled: '未标注',
};

/** 每一类错因对应的下一步动作：不是鼓励的话，是能立刻做的一件事 */
export const CAUSE_NEXT_STEP: Record<CauseKey, string> = {
  knowledge: '先回原文把概念背下来，再回来练',
  confusion: '把易混的两组并列抄在一起对照',
  careless: '放慢审题，先把否定词圈出来',
  reasoning: '按「症状 → 诊断 → 处理」把推理链写一遍',
  unlabeled: '给这几条错题标个错因，才看得出来主要问题',
};

export interface MatrixRow {
  /** 章节名；空串 = 笔记没写章节（界面显示「未标注章节」） */
  chapter: string;
  /** 这一章的错题条数（与热力图同口径：一条错题一票，不看累计答错次数） */
  mistakes: number;
  byCause: Record<CauseKey, number>;
  /** 条数最多的错因；平局按 CAUSE_KEYS 顺序取前者；一条都没标为 unlabeled；无错题为 null */
  topCause: CauseKey | null;
  /** 该章作答正确率；题库里没有同名章节（或没有作答记录）为 null */
  accuracy: number | null;
  /** 正确率背后的题数（0 表示没有统计） */
  seen: number;
  /** 一句话下一步建议；无错题为空串 */
  nextStep: string;
}

function emptyCauses(): Record<CauseKey, number> {
  const out = {} as Record<CauseKey, number>;
  for (const k of CAUSE_KEYS) out[k] = 0;
  return out;
}

export function mistakeMatrix(mistakes: MistakeMap, mastery: ChapterMastery[] = []): MatrixRow[] {
  // 掌握度按章节建索引：同名章节跨题库合并（seen/wrong 相加，正确率重算）
  const acc = new Map<string, { seen: number; wrong: number }>();
  for (const m of mastery) {
    const cur = acc.get(m.chapter) ?? { seen: 0, wrong: 0 };
    cur.seen += m.seen;
    cur.wrong += m.wrong;
    acc.set(m.chapter, cur);
  }

  const rows = new Map<string, MatrixRow>();
  for (const rec of Object.values(mistakes)) {
    const chapter = rec.chapter ?? '';
    let row = rows.get(chapter);
    if (!row) {
      const stat = acc.get(chapter);
      row = {
        chapter,
        mistakes: 0,
        byCause: emptyCauses(),
        topCause: null,
        accuracy: stat && stat.seen > 0 ? (stat.seen - stat.wrong) / stat.seen : null,
        seen: stat?.seen ?? 0,
        nextStep: '',
      };
      rows.set(chapter, row);
    }
    row.mistakes += 1;
    row.byCause[rec.reason ?? 'unlabeled'] += 1;
  }

  for (const row of rows.values()) {
    let top: CauseKey | null = null;
    let max = 0;
    for (const k of CAUSE_KEYS) {
      const n = row.byCause[k];
      // 严格大于：平局保留先出现的那个（CAUSE_KEYS 顺序固定，结果可复现）
      if (n > max) { max = n; top = k; }
    }
    row.topCause = row.mistakes > 0 ? (top ?? 'unlabeled') : null;
    row.nextStep = row.topCause ? CAUSE_NEXT_STEP[row.topCause] : '';
  }

  return [...rows.values()].sort(
    (a, b) => b.mistakes - a.mistakes || a.chapter.localeCompare(b.chapter, 'zh-Hans-CN', { numeric: true }),
  );
}

/** 表头用：错题总条数（与 mistakeMatrix 的 mistakes 求和同口径） */
export function matrixTotal(rows: MatrixRow[]): number {
  return rows.reduce((sum, r) => sum + r.mistakes, 0);
}
