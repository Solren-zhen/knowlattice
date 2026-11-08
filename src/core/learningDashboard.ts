/**
 * 综合学习仪表盘 —— 融合各模块数据
 *
 * 数据来源：
 * - 笔记：编辑时长、新建数量
 * - 复习：卡片复习数、正确率、到期卡片
 * - 题库：练习题数、正确率、错题数
 * - 任务：完成数
 * - 专注：番茄钟数、专注时长
 * - 学习打卡：连续天数、热力图
 */

import type { ReviewCard } from './srsCards';
import type { QuizQuestion } from './qbank';
import type { StatsMap } from './qbankStats';
import { last7 as getStudyLast7, streak as getStudyStreak } from './stats';

export interface TimeStats {
  /** 笔记编辑时长（分钟，估算）*/
  noteMinutes: number;
  /** 做题时长（分钟，估算）*/
  quizMinutes: number;
  /** 复习时长（分钟，估算）*/
  reviewMinutes: number;
  /** 专注时长（分钟，实际）*/
  focusMinutes: number;
  /** 总计 */
  totalMinutes: number;
}

export interface MasteryStats {
  /** 新学笔记数 */
  newNotes: number;
  /** 复习卡片数 */
  reviewedCards: number;
  /** 复习正确率（0-1）*/
  reviewAccuracy: number;
  /** 练习题目数 */
  quizCount: number;
  /** 题目正确率（0-1）*/
  quizAccuracy: number;
  /** 改正错题数 */
  fixedMistakes: number;
}

export interface WeakPoint {
  /** 知识点名称（章节或笔记）*/
  name: string;
  /** 错题数 */
  mistakeCount: number;
  /** 复习正确率（如果有复习记录）*/
  reviewAccuracy?: number;
  /** 严重程度（1-3，3 最严重）*/
  severity: number;
}

export interface Suggestion {
  type: 'review' | 'quiz' | 'task';
  /** 建议文本 */
  text: string;
  /** 数量（如 12 张卡片、20 道题）*/
  count: number;
}

export interface WeeklyReport {
  /** 周区间 */
  weekRange: { start: string; end: string };
  /** 时间投入 */
  timeStats: TimeStats;
  /** 知识掌握 */
  masteryStats: MasteryStats;
  /** 薄弱点（按严重程度排序）*/
  weakPoints: WeakPoint[];
  /** 今日建议 */
  suggestions: Suggestion[];
  /** 学习打卡 */
  streakDays: number;
  /** 近 7 天趋势 */
  last7Days: Array<{ day: string; count: number }>;
  /**
   * 生成报告时点有多少张卡片到期。
   * 这是**实时量**（此刻队列里到期几张），不是周统计量；报告本身拿不到卡片队列，
   * 所以由调用方通过 options.dueCards / options.dueCardCount 传进来。
   */
  dueCards: number;
}

/**
 * 生成周报（默认本周，也可指定日期）
 */
export function generateWeeklyReport(
  options: {
    /** 截止日期（默认今天）*/
    endDate?: string;
    /** 新建笔记列表（用于统计本周新建）*/
    newNotes?: Array<{ path: string; createdAt: number }>;
    /** 复习记录（用于统计复习数与正确率）*/
    reviewRecords?: Array<{ cardKey: string; rating: number; at: number }>;
    /** 答题记录（用于统计题数与正确率）*/
    quizRecords?: Array<{ qid: string; correct: boolean; at: number }>;
    /** 逐题记录（用于发现薄弱点）：题库 → qid → QStat */
    stats?: StatsMap;
    /** 所有题目（用于查找章节）*/
    allQuestions?: Map<string, QuizQuestion>;
    /** 待复习卡片（今日到期）*/
    dueCards?: ReviewCard[];
    /** 只关心「到期几张」时直接给数量，避免调用方为了一个 length 去取当前时间戳 */
    dueCardCount?: number;
    /** 未完成的任务数（用于「今天还有几项」建议；旧名 completedTasks 语义正好相反） */
    incompleteTasks?: number;
    /** 专注记录（番茄钟）*/
    focusSessions?: Array<{ startAt: number; endAt: number }>;
  } = {}
): WeeklyReport {
  const {
    endDate = localDate(),
    newNotes = [],
    reviewRecords = [],
    quizRecords = [],
    stats = {},
    allQuestions = new Map(),
    dueCards = [],
    dueCardCount,
    incompleteTasks = 0,
    focusSessions = [],
  } = options;

  // 计算本周起止
  const weekRange = getWeekRange(endDate);
  const weekStart = new Date(weekRange.start).getTime();
  const weekEnd = new Date(weekRange.end).getTime() + 24 * 3600 * 1000;

  // 筛选本周数据
  const weekNewNotes = newNotes.filter((n) => n.createdAt >= weekStart && n.createdAt < weekEnd);
  const weekReviews = reviewRecords.filter((r) => r.at >= weekStart && r.at < weekEnd);
  const weekQuizzes = quizRecords.filter((q) => q.at >= weekStart && q.at < weekEnd);
  const weekFocus = focusSessions.filter((f) => f.startAt >= weekStart && f.startAt < weekEnd);

  // 时间统计（估算 + 实际）
  const timeStats = calculateTimeStats(weekNewNotes, weekReviews, weekQuizzes, weekFocus);

  // 掌握度统计
  const masteryStats = calculateMasteryStats(
    weekNewNotes,
    weekReviews,
    weekQuizzes,
    collectWrongQids(stats)
  );

  // 薄弱点分析
  const weakPoints = analyzeWeakPoints(stats, allQuestions, reviewRecords);

  // 今日建议
  const dueCount = dueCardCount ?? dueCards.length;
  const suggestions = generateSuggestions(dueCards, weakPoints, incompleteTasks);

  // 学习打卡
  const streakDays = getStudyStreak();
  const last7Days = getStudyLast7();

  return {
    weekRange,
    timeStats,
    masteryStats,
    weakPoints,
    suggestions,
    streakDays,
    last7Days,
    dueCards: dueCount,
  };
}

/**
 * 收集「历史上答错过」的题目 ID（QStat.wrong > 0）。
 *
 * 为什么需要它：判断「本周改正的错题」要知道一道题**以前错过**。
 * QStat 只有 lastReview（上次复习时间），不记录上次是答对还是答错，
 * 所以不能用时间先后判断，改用「这道题历史上答错过没有」。
 */
function collectWrongQids(stats: StatsMap): Set<string> {
  const out = new Set<string>();
  for (const bank of Object.values(stats)) {
    for (const [qid, stat] of Object.entries(bank)) {
      if (stat.wrong > 0) out.add(qid);
    }
  }
  return out;
}

/**
 * 获取本周起止日期（周一到周日）
 */
function getWeekRange(endDate: string): { start: string; end: string } {
  const [y, m, d] = endDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = (date.getDay() + 6) % 7; // 周一 = 0

  // 周一
  const start = new Date(date);
  start.setDate(date.getDate() - dow);

  // 周日
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return {
    start: localDate(start),
    end: localDate(end),
  };
}

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 计算时间投入
 * - 笔记：按新建数 * 30 分钟估算
 * - 做题：按题数 * 2 分钟估算
 * - 复习：按卡片数 * 1.5 分钟估算
 * - 专注：实际时长
 */
function calculateTimeStats(
  newNotes: Array<{ path: string; createdAt: number }>,
  reviews: Array<{ cardKey: string; rating: number; at: number }>,
  quizzes: Array<{ qid: string; correct: boolean; at: number }>,
  focusSessions: Array<{ startAt: number; endAt: number }>
): TimeStats {
  const noteMinutes = newNotes.length * 30;
  const reviewMinutes = Math.round(reviews.length * 1.5);
  const quizMinutes = Math.round(quizzes.length * 2);
  const focusMinutes = focusSessions.reduce(
    (sum, f) => sum + (f.endAt - f.startAt) / 60000,
    0
  );

  return {
    noteMinutes,
    quizMinutes,
    reviewMinutes,
    focusMinutes: Math.round(focusMinutes),
    totalMinutes: noteMinutes + reviewMinutes + quizMinutes + Math.round(focusMinutes),
  };
}

/**
 * 计算掌握度统计
 */
function calculateMasteryStats(
  newNotes: Array<{ path: string; createdAt: number }>,
  reviews: Array<{ cardKey: string; rating: number; at: number }>,
  quizzes: Array<{ qid: string; correct: boolean; at: number }>,
  wrongQids: Set<string>
): MasteryStats {
  const reviewAccuracy =
    reviews.length > 0
      ? reviews.filter((r) => r.rating >= 3).length / reviews.length // 3=好, 4=容易
      : 0;

  const quizAccuracy =
    quizzes.length > 0 ? quizzes.filter((q) => q.correct).length / quizzes.length : 0;

  // 本周改正的错题：历史上答错过（wrong > 0）的题，本周答对了。
  // 注意判据：QStat 只有「上次复习时间」，无法判断「上次是不是答错」，
  // 所以这里用「这道题历史上答错过」而不是「上次答错的时间早于本次」。
  const fixedMistakes = quizzes.filter((q) => q.correct && wrongQids.has(q.qid)).length;

  return {
    newNotes: newNotes.length,
    reviewedCards: reviews.length,
    reviewAccuracy,
    quizCount: quizzes.length,
    quizAccuracy,
    fixedMistakes,
  };
}

/**
 * 分析薄弱点（错题 ≥ 3 的章节）
 */
function analyzeWeakPoints(
  stats: StatsMap,
  allQuestions: Map<string, QuizQuestion>,
  reviewRecords: Array<{ cardKey: string; rating: number; at: number }>
): WeakPoint[] {
  // 按章节统计错误总次数
  const chapterMistakes = new Map<string, number>();

  for (const bank of Object.values(stats)) {
    for (const [qid, stat] of Object.entries(bank)) {
      if (stat.wrong < 3) continue;
      const q = allQuestions.get(qid);
      if (!q || !q.chapter) continue;
      chapterMistakes.set(q.chapter, (chapterMistakes.get(q.chapter) || 0) + stat.wrong);
    }
  }

  // 转换为 WeakPoint 并排序
  const weakPoints: WeakPoint[] = [];

  for (const [name, mistakeCount] of chapterMistakes.entries()) {
    // 查找该章节相关的复习正确率
    const relatedReviews = reviewRecords.filter((r) =>
      r.cardKey.includes(name) || r.cardKey.includes(name.replace(/系统$/, ''))
    );

    const reviewAccuracy =
      relatedReviews.length > 0
        ? relatedReviews.filter((r) => r.rating >= 3).length / relatedReviews.length
        : undefined;

    // 严重程度：错题数 + 复习正确率
    let severity = 1;
    if (mistakeCount >= 5) severity = 2;
    if (mistakeCount >= 10) severity = 3;
    if (reviewAccuracy !== undefined && reviewAccuracy < 0.5) severity = Math.min(3, severity + 1);

    weakPoints.push({ name, mistakeCount, reviewAccuracy, severity });
  }

  // 按严重程度降序
  weakPoints.sort((a, b) => b.severity - a.severity || b.mistakeCount - a.mistakeCount);

  return weakPoints.slice(0, 5); // 最多 5 个
}

/**
 * 生成今日建议
 */
function generateSuggestions(
  dueCards: ReviewCard[],
  weakPoints: WeakPoint[],
  incompleteTasks: number
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  if (dueCards.length > 0) {
    suggestions.push({
      type: 'review',
      text: '今日待复习',
      count: dueCards.length,
    });
  }

  if (weakPoints.length > 0 && weakPoints[0].mistakeCount >= 3) {
    suggestions.push({
      type: 'quiz',
      text: `推荐练习：${weakPoints[0].name}`,
      count: 20, // 推荐 20 题
    });
  }

  if (incompleteTasks > 0) {
    suggestions.push({
      type: 'task',
      text: '未完成任务',
      count: incompleteTasks,
    });
  }

  return suggestions;
}
