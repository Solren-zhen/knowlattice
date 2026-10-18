/**
 * 错题自动生成复习卡片
 *
 * 场景：答错 3 次以上的题，自动生成复习卡片，定期复习直到掌握。
 *
 * 数据来源是**逐题记录 QStat**（core/qbankStats.ts，按「题库 → qid」组织），
 * 不是 core/mistakes.ts 的 MistakeRecord。两者不是一回事：
 *   - MistakeRecord 是**笔记级**错题本模型，按笔记路径取值（getMistake(path)），
 *     字段是 path / chapter / title / count / lastFailedAt —— 没有题目 ID 这个维度；
 *   - QStat 才是**题目级**的，字段含 wrong（累计答错次数，注释里写明是「错题加权的
 *     唯一依据」）与 lastReview，并以 qid 为键。
 * 本模块要判断的是「某一道题答错了几次」，所以必须用 QStat。
 *
 * 设计：
 * - 错题卡片与普通卡片共用 FSRS 调度（复用 srsCards.ts 逻辑）
 * - 卡片键格式：`qbank:<questionId>`（与笔记卡片键 `path` 或 `path#heading` 区分）
 * - 正面：题干（含图片）
 * - 背面：正确答案 + 解析 + 关联笔记链接（如果有）
 */

import type { QuizQuestion } from './qbank';
import type { ReviewCard } from './srsCards';
import type { QStat, StatsMap } from './qbankStats';

export interface MistakeCard extends ReviewCard {
  /** 来源题目 ID */
  questionId: string;
  /** 错误次数（取自 QStat.wrong） */
  mistakeCount: number;
  /**
   * 最近一次复习时间（取自 QStat.lastReview）。
   *
   * 注意口径：QStat 只记「上次复习时间」，不区分上次答对还是答错 ——
   * 所以这里**不是**「上次答错的时间」。原先叫 lastMistakeAt，名字与取值不符，已改名。
   */
  lastReviewedAt: number;
  /** 题干图片路径（如果有）*/
  image?: string;
}

/**
 * 判断一个错题是否应该生成复习卡片
 * - 错误次数 >= 3
 * - 还没有对应的卡片
 *
 * @param qid 题目 ID（QStat 以 qid 为键，所以单独传）
 * @param stat 该题的逐题记录
 */
export function shouldGenerateCard(
  qid: string,
  stat: QStat,
  existingCardKeys: Set<string>
): boolean {
  if (stat.wrong < 3) return false;
  const cardKey = `qbank:${qid}`;
  return !existingCardKeys.has(cardKey);
}

/**
 * 从错题生成复习卡片
 *
 * @param question 题目对象
 * @param stat 该题的逐题记录（错误次数与最近复习时间从它取）
 * @returns 复习卡片
 */
export function generateCardFromMistake(
  question: QuizQuestion,
  stat: QStat
): MistakeCard {
  const cardKey = `qbank:${question.id}`;

  // 正面：题干（去掉图片标记，图片单独处理）
  const heading = question.stem;

  // 背面：答案 + 解析 + 关联笔记
  let body = `**正确答案**：${question.answerText}\n\n`;

  if (question.explanation) {
    body += `**解析**：${question.explanation}\n\n`;
  }

  if (question.explanations && question.explanations.length > 0) {
    body += '**详细解析**：\n';
    for (const exp of question.explanations) {
      body += `- **${exp.source}**：${exp.text}\n`;
    }
    body += '\n';
  }

  if (question.note) {
    body += `**关联笔记**：[[${question.note}]]\n\n`;
  }

  body += `---\n_来自错题本（错 ${stat.wrong} 次）_`;

  return {
    key: cardKey,
    path: '', // 错题卡不属于任何笔记
    noteTitle: question.chapter || '题库练习',
    heading,
    body: body.trim(),
    hints: question.chapter ? [question.chapter] : [],
    questionId: question.id,
    mistakeCount: stat.wrong,
    lastReviewedAt: stat.lastReview,
    image: question.image,
  };
}

/**
 * 批量从错题生成复习卡片
 *
 * @param stats 逐题记录（题库 → qid → QStat）
 * @param questions 所有题目（用于查找题目详情）
 * @param existingCardKeys 已有的卡片键集合
 * @returns 新生成的卡片列表
 */
export function generateCardsFromMistakes(
  stats: StatsMap,
  questions: Map<string, QuizQuestion>,
  existingCardKeys: Set<string>
): MistakeCard[] {
  const cards: MistakeCard[] = [];

  for (const bank of Object.values(stats)) {
    for (const [qid, stat] of Object.entries(bank)) {
      if (!shouldGenerateCard(qid, stat, existingCardKeys)) continue;

      const question = questions.get(qid);
      if (!question) continue; // 题目可能被删除了

      cards.push(generateCardFromMistake(question, stat));
    }
  }

  return cards;
}

/**
 * 检查是否为错题卡片
 */
export function isMistakeCard(cardKey: string): boolean {
  return cardKey.startsWith('qbank:');
}

/**
 * 从错题卡片键提取题目 ID
 */
export function extractQuestionId(cardKey: string): string | null {
  if (!isMistakeCard(cardKey)) return null;
  return cardKey.slice('qbank:'.length);
}

/**
 * 获取可生成卡片的错题数量
 */
export function getGeneratableCount(
  stats: StatsMap,
  existingCardKeys: Set<string>
): number {
  let n = 0;
  for (const bank of Object.values(stats)) {
    for (const [qid, stat] of Object.entries(bank)) {
      if (shouldGenerateCard(qid, stat, existingCardKeys)) n++;
    }
  }
  return n;
}
