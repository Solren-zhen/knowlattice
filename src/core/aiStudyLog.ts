/**
 * 学习日志：把 AI 陪练的成果写回知识库（对应「学习成果要落盘，不能只留在对话里」）。
 * - 一天一篇：学习日志/<YYYY-MM-DD>.md，一次学习 = 一个 `## <HH:MM> 主题` 小节
 * - 追加不覆盖：已有日志只往末尾加小节，用户手写的内容不动
 * - 目录是系统目录：srsCards.buildCards 会跳过，日志流水不会混进复习队列
 * 纯函数 + 参数校验，写盘仍走面板的提案确认流（与 propose_note_* 同一套）。
 */
import { serializeFrontmatter } from './parser';

/** 系统目录（不进复习队列、不是知识笔记）。与 srsCards 的 NON_CARD_PREFIXES 保持一致 */
export const STUDY_LOG_DIR = '学习日志';

export interface StudyLogEntry {
  /** 这次学习的主题（小节标题的一部分，一行） */
  topic: string;
  /** 薄弱点清单，每条一句话，建议带 [[双链]] */
  weakPoints: string[];
  /** 这次做了什么练习、结果如何（可选，如「3 题对 2 题，错在洋地黄中毒」） */
  drill?: string;
  /** 一句话小结（可选） */
  summary?: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 今天的日志路径（本地时区的日期） */
export function studyLogPath(now: Date): string {
  return `${STUDY_LOG_DIR}/${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.md`;
}

/** 时刻标签（小节标题用）：HH:MM */
function timeLabel(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 新建一篇空日志：frontmatter（tags 标记 学习日志，图谱/检索可识别）+ 说明行 */
export function emptyStudyLogDoc(now: Date): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const fm = serializeFrontmatter({
    aliases: [],
    tags: ['学习日志'],
    chapter: '',
    source: '',
    created: date,
    exam: [],
  });
  return `${fm}# 学习日志 ${date}\n`;
}

/**
 * 把一次学习追加为一个小节。existing 为空（没有这篇日志）就先建文档。
 * 小节标题 = `## <时刻> <主题>`；主题只取第一行、去 # 前缀，避免把标题撑成多行。
 */
export function appendStudyLogEntry(existing: string | undefined, entry: StudyLogEntry, now = new Date()): string {
  const topic = entry.topic.replace(/#{1,6}\s*/g, '').split('\n')[0].trim();
  const lines = [`## ${timeLabel(now)} ${topic}`, ''];
  for (const wp of entry.weakPoints) {
    const t = wp.trim();
    if (t) lines.push(`- 薄弱点：${t}`);
  }
  const drill = entry.drill?.trim();
  if (drill) lines.push(`- 练习：${drill}`);
  const summary = entry.summary?.trim();
  if (summary) lines.push(`- 小结：${summary}`);
  const section = lines.join('\n');
  const base = existing && existing.trim() ? existing.trimEnd() : emptyStudyLogDoc(now).trimEnd();
  return `${base}\n\n${section}\n`;
}

/**
 * 校验并整理模型给的 propose_study_log 参数。合法返回条目，不合法返回给模型的错误文案。
 * weakPoints 只收非空字符串并去重（模型爱把同一薄弱点换措辞写两遍）。
 */
export function studyLogEntryFromArgs(args: Record<string, unknown>): StudyLogEntry | string {
  const topic = String(args.topic ?? '').trim();
  if (!topic) return '错误：缺少 topic（这次学习的主题）。';
  const weakPoints = [...new Set(
    (Array.isArray(args.weak_points) ? args.weak_points : [])
      .map((w) => String(w).trim())
      .filter(Boolean)
  )];
  if (!weakPoints.length) return '错误：weak_points 为空。至少写一条薄弱点（这次哪里没掌握），可含 [[双链]]。';
  const drill = typeof args.drill === 'string' && args.drill.trim() ? args.drill.trim() : undefined;
  const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
  return { topic, weakPoints, drill, summary };
}
