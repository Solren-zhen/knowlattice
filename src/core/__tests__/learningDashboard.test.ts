import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';
import type { ReviewCard } from '../srsCards';
import { generateWeeklyReport } from '../learningDashboard';

/** 造一条逐题记录：只写关心的字段，其余按「还没复习过」的默认值 */
function qstat(patch: Partial<QStat> = {}): QStat {
  return {
    due: 0,
    stability: 0,
    difficulty: 0,
    elapsed: 0,
    scheduled: 0,
    steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: 0,
    wrong: 0,
    ...patch,
  };
}

describe('learningDashboard', () => {
  const baseDate = '2026-10-18'; // 周六

  // 模拟数据
  const weekStart = new Date('2026-10-12').getTime(); // 周一

  const mockNewNotes = [
    { path: 'notes/心衰.md', createdAt: weekStart + 1000 },
    { path: 'notes/心梗.md', createdAt: weekStart + 2000 },
    { path: 'notes/心律失常.md', createdAt: weekStart + 3000 },
  ];

  const mockReviews = [
    { cardKey: 'card1', rating: 4, at: weekStart + 1000 }, // 容易
    { cardKey: 'card2', rating: 3, at: weekStart + 2000 }, // 好
    { cardKey: 'card3', rating: 2, at: weekStart + 3000 }, // 困难
    { cardKey: 'card4', rating: 1, at: weekStart + 4000 }, // 重来
  ];

  const mockQuizzes = [
    { qid: 'q1', correct: true, at: weekStart + 1000 },
    { qid: 'q2', correct: false, at: weekStart + 2000 },
    { qid: 'q3', correct: true, at: weekStart + 3000 },
    { qid: 'q4', correct: true, at: weekStart + 4000 },
    { qid: 'q5', correct: false, at: weekStart + 5000 },
  ];

  const mockFocusSessions = [
    { startAt: weekStart + 1000, endAt: weekStart + 26 * 60 * 1000 }, // 25 分钟
    { startAt: weekStart + 100000, endAt: weekStart + 100000 + 25 * 60 * 1000 },
  ];

  // 逐题记录（题库 → qid → QStat）。薄弱点看的是 QStat.wrong，不是笔记级错题本
  const mockStats: StatsMap = {
    测试库: {
      q10: qstat({ wrong: 3 }), // 心血管
      q11: qstat({ wrong: 2 }), // 心血管（<3，不统计）
      q12: qstat({ wrong: 12 }), // 呼吸系统（最严重）
    },
  };

  const mockQuestions = new Map<string, QuizQuestion>([
    [
      'q10',
      {
        id: 'q10',
        type: 'choice',
        stem: '题干',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        chapter: '心血管系统',
      },
    ],
    [
      'q11',
      {
        id: 'q11',
        type: 'choice',
        stem: '题干',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        chapter: '心血管系统',
      },
    ],
    [
      'q12',
      {
        id: 'q12',
        type: 'choice',
        stem: '题干',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        chapter: '呼吸系统',
      },
    ],
  ]);

  const mockDueCards: ReviewCard[] = [
    {
      key: 'card10',
      path: 'notes/心衰.md',
      noteTitle: '心力衰竭',
      heading: '定义',
      body: '...',
      hints: [],
    },
    {
      key: 'card11',
      path: 'notes/心梗.md',
      noteTitle: '心肌梗死',
      heading: '诊断',
      body: '...',
      hints: [],
    },
  ];

  describe('generateWeeklyReport', () => {
    it('生成完整周报', () => {
      const report = generateWeeklyReport({
        endDate: baseDate,
        newNotes: mockNewNotes,
        reviewRecords: mockReviews,
        quizRecords: mockQuizzes,
        stats: mockStats,
        allQuestions: mockQuestions,
        dueCards: mockDueCards,
        incompleteTasks: 0,
        focusSessions: mockFocusSessions,
      });

      // 周区间
      expect(report.weekRange.start).toBe('2026-10-12'); // 周一
      expect(report.weekRange.end).toBe('2026-10-18'); // 周日

      // 时间统计
      expect(report.timeStats.noteMinutes).toBe(90); // 3 篇 * 30 分钟
      expect(report.timeStats.reviewMinutes).toBe(6); // 4 张 * 1.5 分钟
      expect(report.timeStats.quizMinutes).toBe(10); // 5 题 * 2 分钟
      expect(report.timeStats.focusMinutes).toBe(51); // 两个番茄钟（25 + 25，四舍五入）
      expect(report.timeStats.totalMinutes).toBe(157);

      // 掌握度统计
      expect(report.masteryStats.newNotes).toBe(3);
      expect(report.masteryStats.reviewedCards).toBe(4);
      expect(report.masteryStats.reviewAccuracy).toBe(0.5); // 2/4（rating >= 3）
      expect(report.masteryStats.quizCount).toBe(5);
      expect(report.masteryStats.quizAccuracy).toBe(0.6); // 3/5

      // 薄弱点
      expect(report.weakPoints.length).toBeGreaterThan(0);
      expect(report.weakPoints[0].name).toBe('呼吸系统'); // 错 12 次，最严重
      expect(report.weakPoints[0].mistakeCount).toBe(12);

      // 建议
      expect(report.suggestions.length).toBeGreaterThan(0);
      expect(report.suggestions[0].type).toBe('review');
      expect(report.suggestions[0].count).toBe(2); // 2 张待复习
    });

    it('处理空数据', () => {
      const report = generateWeeklyReport({
        endDate: baseDate,
      });

      expect(report.timeStats.totalMinutes).toBe(0);
      expect(report.masteryStats.newNotes).toBe(0);
      expect(report.weakPoints).toEqual([]);
      expect(report.suggestions).toEqual([]);
      // dueCards 是实时量，由调用方传入；没传就是 0
      expect(report.dueCards).toBe(0);
    });

    it('只统计本周数据', () => {
      const lastWeekNote = { path: 'notes/old.md', createdAt: weekStart - 100000 };

      const report = generateWeeklyReport({
        endDate: baseDate,
        newNotes: [...mockNewNotes, lastWeekNote],
      });

      expect(report.masteryStats.newNotes).toBe(3); // 不包括上周的
    });

    it('薄弱点按严重程度排序', () => {
      const report = generateWeeklyReport({
        endDate: baseDate,
        stats: mockStats,
        allQuestions: mockQuestions,
      });

      expect(report.weakPoints[0].mistakeCount).toBeGreaterThanOrEqual(
        report.weakPoints[1]?.mistakeCount || 0
      );
    });

    it('生成练习建议', () => {
      const report = generateWeeklyReport({
        endDate: baseDate,
        stats: mockStats,
        allQuestions: mockQuestions,
        dueCards: [], // 无待复习卡片，确保练习建议能够生成
      });

      const quizSuggestion = report.suggestions.find((s) => s.type === 'quiz');
      expect(quizSuggestion).toBeDefined();
      expect(quizSuggestion?.text).toContain('呼吸系统'); // 最严重的薄弱点
    });

    it('生成任务提醒', () => {
      const report = generateWeeklyReport({
        endDate: baseDate,
        incompleteTasks: 3, // 未完成
      });

      const taskSuggestion = report.suggestions.find((s) => s.type === 'task');
      expect(taskSuggestion).toBeDefined();
      expect(taskSuggestion?.count).toBe(3);
    });

    it('计算改正错题数', () => {
      const quizzesWithFix = [
        ...mockQuizzes,
        { qid: 'q10', correct: true, at: weekStart + 10000 }, // 本周答对了之前的错题
      ];

      const report = generateWeeklyReport({
        endDate: baseDate,
        quizRecords: quizzesWithFix,
        stats: mockStats,
      });

      expect(report.masteryStats.fixedMistakes).toBe(1);
    });

    it('复习正确率影响薄弱点严重程度', () => {
      const reviewsWithLowAccuracy = [
        { cardKey: 'notes/呼吸系统.md', rating: 1, at: weekStart + 1000 },
        { cardKey: 'notes/呼吸系统.md', rating: 2, at: weekStart + 2000 },
        { cardKey: 'notes/呼吸系统.md', rating: 1, at: weekStart + 3000 },
      ];

      const report = generateWeeklyReport({
        endDate: baseDate,
        stats: mockStats,
        allQuestions: mockQuestions,
        reviewRecords: reviewsWithLowAccuracy,
      });

      const respiratoryWeakPoint = report.weakPoints.find((w) => w.name === '呼吸系统');
      expect(respiratoryWeakPoint?.reviewAccuracy).toBeLessThan(0.5);
      expect(respiratoryWeakPoint?.severity).toBeGreaterThanOrEqual(2); // 高严重程度（错题 8 + 复习差）
    });
  });
});
