/**
 * 模拟考试：限时整卷 → 交卷自动评分 → 成绩报告（分章节得分 + 用时）。
 *
 * 与 `core/qbankCompose.ts` 的关系：组卷复用它的加权随机（错题/到期加权），
 * 本模块只加三件练习模式没有的东西：
 *   1. 限时（`minutes`）与「用了几分钟」的统计；
 *   2. 整卷判分（一次交卷、按题给对错，不做逐题即时反馈）；
 *   3. 成绩报告的数据结构（分章节正确率、薄弱章节）。
 *
 * 为什么不把判分逻辑写进视图：报告要能单测（判分是最容易写错、也最该被钉死的部分）。
 * 这里全部是纯函数，不读存储、不碰 DOM；考试历史的持久化在 `core/examHistory.ts`。
 */
import { isCorrectPick, type QuizBank, type QuizQuestion } from './qbank';
import { composeQuestions, type ComposeOrder, type ComposeScope, type ComposeRules } from './qbankCompose';
import type { StatsMap } from './qbankStats';
import type { StarMap } from './qbankStarred';

export interface ExamConfig {
  /** 题量；0 = 候选池里全部 */
  count: number;
  /** 限时（分钟）；0 = 不限时 */
  minutes: number;
  scope: ComposeScope;
  order: ComposeOrder;
  /** 只抽这些章节；空数组 = 全部 */
  chapters: string[];
}

export const DEFAULT_EXAM_CONFIG: ExamConfig = {
  count: 50,
  minutes: 60,
  scope: 'all',
  order: 'shuffle',
  chapters: [],
};

/** 及格线（百分制）。只用于成绩页的一句判定，不拦任何操作。 */
export const EXAM_PASS = 60;

export interface ExamChapterScore {
  chapter: string;
  total: number;
  correct: number;
  /** 0~1；total 为 0 时为 0 */
  accuracy: number;
}

export interface ExamResult {
  id: string;
  bankName: string;
  startedAt: number;
  finishedAt: number;
  /** 实际用时（毫秒），不超过限时（看题看超了也只按限时算） */
  usedMs: number;
  /** 限时（毫秒）；0 = 不限时 */
  timeLimitMs: number;
  total: number;
  correct: number;
  /** 百分制成绩 0~100 */
  score: number;
  perChapter: ExamChapterScore[];
  /** 答错（含未作答）的题目 id */
  wrongIds: string[];
}

/** 百分制成绩；total 为 0 时返回 0（没有会的题不该显示 NaN 分） */
export function score100(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

/**
 * 整卷判分。`answers[i]` 是第 i 题勾选的选项下标；`null` / 空数组 = 未作答，算错。
 * 简答题（recall）不参与自动判分——考试只组选择题（见 buildExamPaper 的 types 过滤），
 * 所以这里拿到的题基本都有可判定的正确项；真遇到 recall（答案 -1）也按错处理而不是崩掉。
 */
export function gradeExam(
  questions: QuizQuestion[],
  answers: Array<number[] | null>,
): { total: number; correct: number; wrongIds: string[] } {
  let correct = 0;
  const wrongIds: string[] = [];
  questions.forEach((q, i) => {
    const picked = answers[i] ?? [];
    if (picked.length > 0 && isCorrectPick(q, picked)) correct += 1;
    else wrongIds.push(q.id);
  });
  return { total: questions.length, correct, wrongIds };
}

/** 分章节得分：按题目的主章节（`chapter`）归组，没标章节的归到空串（界面显示「未标章节」）。 */
export function chapterScores(questions: QuizQuestion[], answers: Array<number[] | null>): ExamChapterScore[] {
  const groups = new Map<string, { total: number; correct: number }>();
  questions.forEach((q, i) => {
    const key = q.chapter ?? '';
    const g = groups.get(key) ?? { total: 0, correct: 0 };
    g.total += 1;
    const picked = answers[i] ?? [];
    if (picked.length > 0 && isCorrectPick(q, picked)) g.correct += 1;
    groups.set(key, g);
  });
  return [...groups]
    .map(([chapter, g]) => ({
      chapter,
      total: g.total,
      correct: g.correct,
      accuracy: g.total > 0 ? g.correct / g.total : 0,
    }))
    // 正确率低的排前面：成绩页最该先看到的是「哪一章垮了」
    .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total);
}

/** 按组卷配置抽一份考卷：**只选选择题**——简答题无法自动判分，混进整卷会让分数不可信。 */
export function buildExamPaper(
  bank: QuizBank,
  config: ExamConfig,
  stats: StatsMap,
  now = Date.now(),
  rnd: () => number = Math.random,
  stars: StarMap = {},
): QuizQuestion[] {
  const rules: ComposeRules = {
    count: config.count,
    chapters: config.chapters,
    types: ['choice'],
    scope: config.scope,
    order: config.order,
  };
  return composeQuestions(bank, rules, stats, now, rnd, stars);
}

/** 组装一份考试成绩。`finishedAt - startedAt` 实测用时；有上限时封顶到限时。 */
export function buildExamResult(
  bankName: string,
  questions: QuizQuestion[],
  answers: Array<number[] | null>,
  startedAt: number,
  finishedAt: number,
  timeLimitMs: number,
): ExamResult {
  const { total, correct, wrongIds } = gradeExam(questions, answers);
  const rawUsed = Math.max(0, finishedAt - startedAt);
  const usedMs = timeLimitMs > 0 ? Math.min(rawUsed, timeLimitMs) : rawUsed;
  return {
    id: `${finishedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    bankName,
    startedAt,
    finishedAt,
    usedMs,
    timeLimitMs,
    total,
    correct,
    score: score100(correct, total),
    perChapter: chapterScores(questions, answers),
    wrongIds,
  };
}

/** 薄弱章节：正答率最低的 n 章（跳过只有 1 题的章节——单题正确率没有统计意义）。 */
export function weakChapters(result: ExamResult, n = 3): ExamChapterScore[] {
  return result.perChapter.filter((c) => c.total >= 2 && c.accuracy < 0.6).slice(0, n);
}

/** 毫秒 → `MM:SS` / `H:MM:SS`（倒计时、用时都走这一个格式，界面不必各写一套）。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 与同题库上一次考试的分差（本次 − 上次）。没有历史时返回 null。 */
export function scoreDelta(current: ExamResult, history: ExamResult[]): number | null {
  const prev = history.find((r) => r.bankName === current.bankName && r.id !== current.id);
  return prev ? current.score - prev.score : null;
}
