/**
 * 复习时展示关联题目
 *
 * 场景：用户复习某张卡片时，推荐相关题目进行练习巩固
 */

import type { ReviewCard } from './srsCards';
import type { QuizQuestion } from './qbank';

export interface RelatedQuiz {
  /** 题目 ID */
  qid: string;
  /** 匹配度 0-1（1 最匹配） */
  relevance: number;
  /** 匹配原因 */
  reason: string;
  /** 题目预览（题干前 50 字） */
  preview: string;
}

export interface CardWithRelatedQuizzes {
  /** 卡片信息 */
  card: ReviewCard;
  /** 相关题目列表 */
  relatedQuizzes: RelatedQuiz[];
}

/**
 * 为复习卡片推荐相关题目
 *
 * @param card 复习卡片
 * @param allQuestions 所有题目 Map
 * @param maxRecommendations 最多推荐数量（默认 3）
 * @returns 相关题目列表
 */
export function findRelatedQuizzes(
  card: ReviewCard,
  allQuestions: Map<string, QuizQuestion>,
  maxRecommendations = 3
): RelatedQuiz[] {
  const scored: Array<RelatedQuiz & { _score: number }> = [];

  for (const [qid, question] of allQuestions) {
    let score = 0;
    const reasons: string[] = [];

    // 规则 1: 章节匹配（从笔记标题推断章节）
    if (question.chapter) {
      if (card.noteTitle?.includes(question.chapter)) {
        score += 10;
        reasons.push(`笔记标题匹配章节"${question.chapter}"`);
      }

      if (card.heading.includes(question.chapter)) {
        score += 8;
        reasons.push(`卡片标题匹配章节"${question.chapter}"`);
      }
    }

    // 规则 2: 关键词匹配（卡片 heading）
    const headingKeywords = extractKeywords(card.heading);
    for (const keyword of headingKeywords) {
      if (question.stem.includes(keyword)) {
        score += 3;
        reasons.push(`题干包含"${keyword}"`);
      }

      if (question.explanation?.includes(keyword)) {
        score += 2;
      }
    }

    // 规则 3: 关键词匹配（卡片 body）
    const bodyKeywords = extractKeywords(card.body);
    for (const keyword of bodyKeywords) {
      if (question.stem.includes(keyword)) {
        score += 2;
      }

      if (question.answerText?.includes(keyword)) {
        score += 2;
        reasons.push(`答案包含"${keyword}"`);
      }
    }

    // 规则 4: hints 匹配
    if (card.hints) {
      for (const hint of card.hints) {
        if (question.stem.includes(hint)) {
          score += 4;
          reasons.push(`题干包含提示词"${hint}"`);
        }
      }
    }

    // 只推荐有一定匹配度的题目
    if (score >= 2) {
      scored.push({
        qid,
        relevance: 0, // 稍后归一化
        reason: reasons.slice(0, 2).join('；'),
        preview: question.stem.slice(0, 50) + (question.stem.length > 50 ? '...' : ''),
        _score: score,
      });
    }
  }

  // 按分数排序
  scored.sort((a, b) => b._score - a._score);

  // 归一化 relevance
  const maxScore = scored[0]?._score || 1;
  const related = scored.slice(0, maxRecommendations).map((item) => ({
    qid: item.qid,
    relevance: Math.min(1, item._score / maxScore),
    reason: item.reason,
    preview: item.preview,
  }));

  return related;
}

/**
 * 批量为多张卡片查找相关题目
 *
 * @param cards 卡片列表
 * @param allQuestions 所有题目
 * @returns 每张卡片的相关题目
 */
export function batchFindRelatedQuizzes(
  cards: ReviewCard[],
  allQuestions: Map<string, QuizQuestion>
): CardWithRelatedQuizzes[] {
  return cards
    .map((card) => {
      const relatedQuizzes = findRelatedQuizzes(card, allQuestions);

      return {
        card,
        relatedQuizzes,
      };
    })
    .filter((item) => item.relatedQuizzes.length > 0);
}

/**
 * 提取关键词（复用自 mistakeNoteRecommendation，简化版）
 */
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];

  // 提取医学术语
  const termRegex =
    /([一-龥]{2,6}(?:病|症|征|综合征|功能|障碍|衰竭|梗死|炎症|感染|治疗|诊断|检查))/g;
  let match: RegExpExecArray | null;

  while ((match = termRegex.exec(text)) !== null) {
    const keyword = match[1];
    if (!keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }

  // 提取一般名词
  const nounRegex = /([一-龥]{2,4})/g;
  const seen = new Set(keywords);

  while ((match = nounRegex.exec(text)) !== null) {
    const keyword = match[1];
    if (!seen.has(keyword) && !/^[的了吗呢啊是在有和与或但而且]/.test(keyword)) {
      keywords.push(keyword);
      seen.add(keyword);
      if (keywords.length >= 8) break;
    }
  }

  return keywords.slice(0, 8);
}

/**
 * 为单张卡片快速查找题目（用于实时推荐）
 */
export function quickFindRelatedQuizzes(
  cardKey: string,
  allCards: Map<string, ReviewCard>,
  allQuestions: Map<string, QuizQuestion>,
  maxRecommendations = 3
): RelatedQuiz[] {
  const card = allCards.get(cardKey);
  if (!card) return [];

  return findRelatedQuizzes(card, allQuestions, maxRecommendations);
}
