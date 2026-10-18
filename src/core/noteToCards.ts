/**
 * 笔记 → 智能提取关键点 → 自动生成 SRS 卡片
 *
 * 场景：用户新建或更新笔记后，AI 分析内容并自动生成复习卡片
 */

import type { ReviewCard } from './srsCards';

export interface NoteKeyPoint {
  /** 关键点标题（如"心衰的定义"） */
  heading: string;
  /** 关键点内容（精炼的知识点） */
  content: string;
  /** 重要程度 1-3（3 最重要） */
  importance: 1 | 2 | 3;
  /** 提示词（帮助回忆） */
  hints: string[];
}

export interface NoteAnalysisResult {
  /** 笔记路径 */
  notePath: string;
  /** 笔记标题 */
  noteTitle: string;
  /** 提取的关键点 */
  keyPoints: NoteKeyPoint[];
  /** 生成的卡片 */
  generatedCards: ReviewCard[];
}

/**
 * 从笔记内容中提取关键点
 *
 * @param notePath 笔记文件路径
 * @param noteTitle 笔记标题
 * @param content 笔记 Markdown 内容
 * @returns 提取的关键点列表
 *
 * 实际项目中，这里会调用 AI API 进行智能分析
 * 本实现提供规则引擎作为 fallback
 */
export function extractKeyPoints(
  _notePath: string,
  noteTitle: string,
  content: string
): NoteKeyPoint[] {
  const keyPoints: NoteKeyPoint[] = [];

  // 规则 1: 提取二级标题作为潜在关键点
  const h2Regex = /^## (.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = h2Regex.exec(content)) !== null) {
    const heading = match[1].trim();
    const startIdx = match.index + match[0].length;
    const nextH2 = content.indexOf('\n## ', startIdx);
    const sectionContent = content
      .slice(startIdx, nextH2 === -1 ? undefined : nextH2)
      .trim();

    // 跳过空段落或太短的内容
    if (!sectionContent || sectionContent.length < 20) continue;

    // 判断重要程度
    let importance: 1 | 2 | 3 = 1;
    if (
      /定义|诊断标准|治疗方案|鉴别|机制|病因/.test(heading) ||
      sectionContent.includes('**重点**') ||
      sectionContent.includes('**关键**')
    ) {
      importance = 3;
    } else if (/临床表现|症状|检查|分类/.test(heading)) {
      importance = 2;
    }

    // 提取关键句作为 hints
    const hints = extractHints(sectionContent);

    keyPoints.push({
      heading,
      content: sectionContent.slice(0, 500), // 限制长度
      importance,
      hints,
    });
  }

  // 规则 2: 提取列表项（特别是数字列表）
  const listRegex = /^(?:\d+\.|[-*])\s+(.+)$/gm;
  const lists: string[] = [];
  while ((match = listRegex.exec(content)) !== null) {
    lists.push(match[1].trim());
  }

  // 如果有大量列表项，说明可能是重要知识点枚举
  if (lists.length >= 3 && lists.length <= 10) {
    keyPoints.push({
      heading: `${noteTitle}要点`,
      content: lists.slice(0, 10).join('\n'),
      importance: 2,
      hints: lists.slice(0, 3),
    });
  }

  return keyPoints;
}

/**
 * 从段落中提取提示词（hints）
 */
function extractHints(content: string): string[] {
  const hints: string[] = [];

  // 提取加粗文本
  const boldRegex = /\*\*([^*]+)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = boldRegex.exec(content)) !== null) {
    hints.push(match[1]);
  }

  // 提取关键术语（中文专业词汇模式）
  const termRegex = /([一-龥]{2,6}症|[一-龥]{2,6}征|[一-龥]{2,6}法|[一-龥]{2,6}素)/g;
  while ((match = termRegex.exec(content)) !== null) {
    if (!hints.includes(match[1])) {
      hints.push(match[1]);
    }
  }

  return hints.slice(0, 5); // 最多 5 个 hints
}

/**
 * 将关键点转换为 SRS 复习卡片
 *
 * @param notePath 笔记路径
 * @param noteTitle 笔记标题
 * @param keyPoints 关键点列表
 * @param minImportance 最低重要程度（默认 2，只为中高重要度生成卡片）
 * @returns 生成的卡片列表
 */
export function keyPointsToCards(
  notePath: string,
  noteTitle: string,
  keyPoints: NoteKeyPoint[],
  minImportance: 1 | 2 | 3 = 2
): ReviewCard[] {
  return keyPoints
    .filter((kp) => kp.importance >= minImportance)
    .map((kp) => ({
      key: `${notePath}#${kp.heading}`,
      path: notePath,
      noteTitle,
      heading: kp.heading,
      body: kp.content,
      hints: kp.hints,
    }));
}

/**
 * 完整流程：分析笔记 → 生成卡片
 *
 * @param notePath 笔记路径
 * @param noteTitle 笔记标题
 * @param content 笔记内容
 * @param options 配置项
 * @returns 分析结果（包含关键点和生成的卡片）
 */
export function analyzeNoteAndGenerateCards(
  notePath: string,
  noteTitle: string,
  content: string,
  options: {
    minImportance?: 1 | 2 | 3;
    /** 是否使用 AI 分析（默认 false，使用规则引擎） */
    useAI?: boolean;
  } = {}
): NoteAnalysisResult {
  const keyPoints = extractKeyPoints(notePath, noteTitle, content);

  const generatedCards = keyPointsToCards(
    notePath,
    noteTitle,
    keyPoints,
    options.minImportance
  );

  return {
    notePath,
    noteTitle,
    keyPoints,
    generatedCards,
  };
}

/**
 * 批量处理笔记（用于初次导入或全量生成）
 */
export function batchAnalyzeNotes(
  notes: Array<{ path: string; title: string; content: string }>,
  options?: { minImportance?: 1 | 2 | 3 }
): NoteAnalysisResult[] {
  return notes.map((note) =>
    analyzeNoteAndGenerateCards(note.path, note.title, note.content, options)
  );
}
