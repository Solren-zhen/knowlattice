/**
 * AI 生成题目的自动导入
 *
 * 场景：AI 对话中生成了题目，一键导入题库，自动关联当前笔记。
 *
 * 支持格式：
 * 1. 标准格式（带序号）：
 *    【题1】题干文本
 *    A. 选项1
 *    B. 选项2
 *    答案：B
 *    解析：解析文本
 *
 * 2. Markdown 列表格式：
 *    1. 题干文本
 *    - A. 选项1
 *    - B. 选项2
 *    - 答案：B
 *    - 解析：解析文本
 *
 * 3. 简答题：
 *    【题1】题干文本
 *    答案：答案文本
 */

import type { QuizQuestion } from './qbank';

/**
 * 题目 id：不引第三方依赖。此前用的 nanoid 并没有写进 package.json，只是被 vite/postcss
 * 传递依赖提升到 node_modules 根，换包管理器或依赖树一变就会断——这里改用 Web Crypto，
 * 任何上下文（含非安全上下文）都有，长度与既有 nanoid(10) 对齐，存量 id 不受影响。
 */
function newQuestionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(36).padStart(2, '0');
  return out.slice(0, 10);
}

export interface ParsedAiQuestion {
  stem: string;
  options: string[];
  answer: number;
  answerText: string;
  explanation?: string;
}

export interface AiQuestionImportOptions {
  /** 当前章节（从笔记 frontmatter 获取）*/
  chapter?: string;
  /** 当前笔记路径（自动关联）*/
  notePath?: string;
  /** 题库名称（默认 "AI 生成题库"）*/
  bankName?: string;
}

/**
 * 解析 AI 回复中的题目
 *
 * @param aiResponse AI 的完整回复
 * @returns 解析出的题目列表
 */
export function parseAiQuestions(aiResponse: string): ParsedAiQuestion[] {
  const questions: ParsedAiQuestion[] = [];

  // 按【题N】或数字序号分段
  const segments = splitIntoQuestions(aiResponse);

  for (const segment of segments) {
    const question = parseQuestionSegment(segment);
    if (question) {
      questions.push(question);
    }
  }

  return questions;
}

/**
 * 将 AI 回复分割成独立的题目段落
 */
function splitIntoQuestions(text: string): string[] {
  const segments: string[] = [];

  // 匹配【题N】、【第N题】、N. 等标记
  const questionMarkers = /(?:^|\n)(?:【题\d+】|【第\d+题】|\d+[.、])\s*/g;

  const matches = Array.from(text.matchAll(questionMarkers));

  if (matches.length === 0) {
    // 没有明确标记，可能是单题或整段都是题目
    return [text.trim()];
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    segments.push(text.slice(start, end).trim());
  }

  return segments;
}

/**
 * 解析单个题目段落
 */
function parseQuestionSegment(segment: string): ParsedAiQuestion | null {
  const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) return null;

  // 第一行是题干
  let stem = lines[0].replace(/^[\d.、】]+\s*/, '').trim();

  // 提取选项
  const options: string[] = [];
  let answerLine = '';
  let explanationLine = '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // 匹配选项：A. / A、/ - A. 等格式
    const optionMatch = /^(?:-\s*)?([A-Z])[.、]\s*(.+)$/.exec(line);
    if (optionMatch) {
      options.push(optionMatch[2].trim());
      continue;
    }

    // 匹配答案：答案：B / 正确答案：B
    const answerMatch = /^(?:正确)?答案[：:]\s*(.+)$/.exec(line);
    if (answerMatch) {
      answerLine = answerMatch[1].trim();
      continue;
    }

    // 匹配解析：解析：... / 解释：...
    const explanationMatch = /^(?:解析|解释|说明)[：:]\s*(.+)$/.exec(line);
    if (explanationMatch) {
      explanationLine = explanationMatch[1].trim();
      // 解析可能多行，把后续行也拼上
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].match(/^(?:正确)?答案[：:]/)) {
          explanationLine += ' ' + lines[j];
        } else {
          break;
        }
      }
      break;
    }
  }

  // 确定答案索引
  let answer = 0;
  let answerText = '';

  if (options.length > 0) {
    // 选择题：解析答案字母
    answer = parseAnswerIndex(answerLine, options);
    answerText = options[answer] || '';
  } else {
    // 简答题：答案就是文本
    answerText = answerLine;
  }

  if (!stem) return null;

  return {
    stem,
    options,
    answer,
    answerText,
    explanation: explanationLine || undefined,
  };
}

/**
 * 解析答案标识（A / B / 选项文本）到索引
 */
function parseAnswerIndex(answerText: string, options: string[]): number {
  if (!answerText) return 0;

  // 提取首个字母（B、答案B、选项B 都能识别）
  const letterMatch = /([A-Z])/.exec(answerText);
  if (letterMatch) {
    const letter = letterMatch[1];
    const index = letter.charCodeAt(0) - 'A'.charCodeAt(0);
    if (index >= 0 && index < options.length) {
      return index;
    }
  }

  // 尝试匹配选项原文
  for (let i = 0; i < options.length; i++) {
    if (answerText.includes(options[i])) {
      return i;
    }
  }

  return 0;
}

/**
 * 将解析出的题目转换为 QuizQuestion 格式
 */
export function convertToQuizQuestions(
  parsed: ParsedAiQuestion[],
  options: AiQuestionImportOptions = {}
): QuizQuestion[] {
  const { chapter, notePath } = options;

  return parsed.map((q) => {
    const id = newQuestionId();
    const type = q.options.length > 0 ? 'choice' : 'recall';
    const noteTitle = notePath ? extractNoteTitle(notePath) : undefined;

    return {
      id,
      type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      answerText: q.answerText,
      explanation: q.explanation,
      chapter,
      note: noteTitle,
    } as QuizQuestion;
  });
}

/**
 * 从笔记路径提取标题（去掉扩展名）
 * 例如：notes/心肌梗死.md → 心肌梗死
 */
function extractNoteTitle(path: string): string {
  const filename = path.split('/').pop() || path;
  return filename.replace(/\.md$/, '');
}

/**
 * 一键导入：解析 + 转换 + 返回导入结果
 */
export function importAiQuestions(
  aiResponse: string,
  options: AiQuestionImportOptions = {}
): { questions: QuizQuestion[]; count: number } {
  const parsed = parseAiQuestions(aiResponse);
  const questions = convertToQuizQuestions(parsed, options);

  return {
    questions,
    count: questions.length,
  };
}

/**
 * 检测文本中是否包含题目（用于 UI 显示"导入题库"按钮）
 */
export function containsQuestions(text: string): boolean {
  // 包含【题】或数字序号 + 选项标记 + 答案标记
  const hasQuestionMarker = /【题\d+】|【第\d+题】/.test(text);
  const hasOptions = /\n\s*[A-Z][.、]\s*.+/.test(text);
  const hasAnswer = /答案[：:]\s*[A-Z]/.test(text);

  return hasQuestionMarker || (hasOptions && hasAnswer);
}
