/**
 * 做题错误 → 推荐相关笔记
 *
 * 场景：用户答错题目后，推荐与该题目相关的笔记，帮助复习知识点
 */

import type { QuizQuestion } from './qbank';

export interface NoteRecommendation {
  /** 笔记路径 */
  notePath: string;
  /** 笔记标题 */
  noteTitle: string;
  /** 匹配度 0-1（1 最匹配） */
  relevance: number;
  /** 匹配原因 */
  reason: string;
}

export interface MistakeNote {
  /** 题目 ID */
  qid: string;
  /** 推荐的笔记列表 */
  recommendations: NoteRecommendation[];
}

/**
 * 推荐只需要「题干 + 可选的章节 / 答案 / 解析」这一小组字段：
 * 题库里的 QuizQuestion 与错题本的 MistakeRecord 都能直接传，不必为前者造一个假题目对象。
 */
export interface MistakeSource {
  stem: string;
  chapter?: string;
  answerText?: string;
  explanation?: string;
}

/**
 * 笔记元数据（用于匹配）
 */
export interface NoteMetadata {
  path: string;
  title: string;
  /** 笔记内容（用于全文搜索） */
  content: string;
  /** 笔记涉及的章节/标签 */
  tags?: string[];
  /** 最后修改时间 */
  updatedAt?: number;
}

/**
 * 为错题推荐相关笔记
 *
 * @param question 错题
 * @param allNotes 所有笔记的元数据
 * @param maxRecommendations 最多推荐数量（默认 3）
 * @returns 推荐的笔记列表
 */
export function recommendNotesForMistake(
  question: MistakeSource,
  allNotes: NoteMetadata[],
  maxRecommendations = 3
): NoteRecommendation[] {
  const scored: Array<NoteRecommendation & { _score: number }> = [];

  for (const note of allNotes) {
    let score = 0;
    const reasons: string[] = [];

    // 规则 1: 章节匹配（权重最高）
    if (question.chapter && note.title.includes(question.chapter)) {
      score += 10;
      reasons.push(`标题包含章节"${question.chapter}"`);
    }

    // 闭包里 TS 不会保留上一行的类型收窄，先把可能为 undefined 的章节取出来
    const chapter = question.chapter;
    if (
      chapter &&
      note.tags?.some((tag) => tag.includes(chapter))
    ) {
      score += 8;
      reasons.push(`标签包含章节"${chapter}"`);
    }

    // 规则 2: 关键词匹配
    const keywords = extractKeywords(question.stem);
    for (const keyword of keywords) {
      if (note.title.includes(keyword)) {
        score += 3;
        reasons.push(`标题包含关键词"${keyword}"`);
      }
      if (note.content.includes(keyword)) {
        score += 1;
        reasons.push(`内容包含关键词"${keyword}"`);
      }
    }

    // 规则 3: 答案关键词匹配
    if (question.answerText) {
      const answerKeywords = extractKeywords(question.answerText);
      for (const keyword of answerKeywords) {
        if (note.content.includes(keyword)) {
          score += 2;
          reasons.push(`内容包含答案关键词"${keyword}"`);
        }
      }
    }

    // 规则 4: 解析匹配
    if (question.explanation) {
      const explanationKeywords = extractKeywords(question.explanation);
      for (const keyword of explanationKeywords) {
        if (note.content.includes(keyword)) {
          score += 2;
        }
      }
    }

    // 规则 5: 笔记新鲜度（最近更新的笔记略加分，且仅在已有其他匹配时才加分）
    if (note.updatedAt && score > 0) {
      const daysSinceUpdate =
        (Date.now() - note.updatedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 7) {
        score += 0.5;
        reasons.push('最近更新');
      }
    }

    // 只推荐有一定匹配度的笔记（必须有实质性匹配，不能只靠新鲜度）
    if (score >= 1) {
      scored.push({
        notePath: note.path,
        noteTitle: note.title,
        relevance: 0, // 稍后归一化
        reason: reasons.slice(0, 3).join('；'), // 最多 3 个原因
        _score: score,
      });
    }
  }

  // 按分数排序
  scored.sort((a, b) => b._score - a._score);

  // 归一化 relevance（最高分为 1.0）
  const maxScore = scored[0]?._score || 1;
  const recommendations = scored.slice(0, maxRecommendations).map((item) => ({
    notePath: item.notePath,
    noteTitle: item.noteTitle,
    relevance: Math.min(1, item._score / maxScore),
    reason: item.reason,
  }));

  return recommendations;
}

/**
 * 批量为错题推荐笔记
 *
 * @param mistakes 错题列表
 * @param allQuestions 所有题目的 Map
 * @param allNotes 所有笔记的元数据
 * @returns 每个错题的推荐列表
 */
export function batchRecommendNotes(
  mistakes: Array<{ qid: string; wrong: number }>,
  allQuestions: Map<string, QuizQuestion>,
  allNotes: NoteMetadata[]
): MistakeNote[] {
  return mistakes
    .map((m) => {
      const question = allQuestions.get(m.qid);
      if (!question) return null;

      const recommendations = recommendNotesForMistake(question, allNotes);

      return {
        qid: m.qid,
        recommendations,
      };
    })
    .filter((item): item is MistakeNote => item !== null && item.recommendations.length > 0);
}

/**
 * 提取文本中的关键词（中文）
 *
 * 简单实现：提取 2-6 字的中文词组
 * 生产环境可替换为 jieba 分词或 NLP 模型
 */
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];

  // 提取医学术语模式
  const termRegex =
    /([一-龥]{2,6}(?:病|症|征|综合征|功能|障碍|衰竭|梗死|炎症|感染|治疗|诊断))/g;
  let match: RegExpExecArray | null;

  while ((match = termRegex.exec(text)) !== null) {
    const keyword = match[1];
    if (!keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }

  // 提取一般名词（2-4 字）
  const nounRegex = /([一-龥]{2,4})/g;
  const seen = new Set(keywords);

  while ((match = nounRegex.exec(text)) !== null) {
    const keyword = match[1];
    if (!seen.has(keyword) && !/^[的了吗呢啊是在有和与或但而且]/.test(keyword)) {
      keywords.push(keyword);
      seen.add(keyword);
      if (keywords.length >= 10) break; // 限制数量
    }
  }

  return keywords.slice(0, 10);
}

/**
 * 为单次答题推荐笔记（用于实时推荐）
 *
 * @param qid 题目 ID
 * @param allQuestions 所有题目
 * @param allNotes 所有笔记
 * @returns 推荐笔记列表
 */
export function recommendNotesForQuiz(
  qid: string,
  allQuestions: Map<string, QuizQuestion>,
  allNotes: NoteMetadata[]
): NoteRecommendation[] {
  const question = allQuestions.get(qid);
  if (!question) return [];

  return recommendNotesForMistake(question, allNotes);
}
