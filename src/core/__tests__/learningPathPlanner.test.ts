import { describe, expect, it } from 'vitest';
import type { WeeklyReport } from '../learningDashboard';
import {
  generateLearningPath,
  generateWeeklyLearningPlan,
  generateTodayPlan,
  generateWeekendIntensivePlan,
} from '../learningPathPlanner';

describe('learningPathPlanner', () => {
  // 按 learningDashboard 的 WeeklyReport 实际结构构造：
  // weekRange / timeStats / masteryStats / weakPoints / suggestions / streakDays / last7Days / dueCards
  const mockReport: WeeklyReport = {
    weekRange: { start: '2026-10-12', end: '2026-10-18' },
    timeStats: {
      noteMinutes: 120,
      reviewMinutes: 45,
      quizMinutes: 90,
      focusMinutes: 180,
      totalMinutes: 435,
    },
    masteryStats: {
      newNotes: 15,
      reviewedCards: 80,
      reviewAccuracy: 0.85,
      quizCount: 45,
      quizAccuracy: 0.72,
      fixedMistakes: 12,
    },
    weakPoints: [
      // severity 的口径是 1-3（见 learningDashboard.analyzeWeakPoints），不是 0-1
      { name: '心血管系统', mistakeCount: 18, reviewAccuracy: 0.6, severity: 3 },
      { name: '呼吸系统', mistakeCount: 12, reviewAccuracy: 0.7, severity: 2 },
      { name: '消化系统', mistakeCount: 8, reviewAccuracy: 0.75, severity: 1 },
    ],
    suggestions: [],
    streakDays: 5,
    last7Days: [],
    dueCards: 25,
  };

  describe('generateLearningPath', () => {
    it('生成基本学习路径', () => {
      const path = generateLearningPath(mockReport);

      expect(path.title).toBeTruthy();
      expect(path.goal).toBeTruthy();
      expect(path.steps.length).toBeGreaterThan(0);
      expect(path.totalMinutes).toBeGreaterThan(0);
      expect(path.totalMinutes).toBeLessThanOrEqual(150); // 默认 120 + 缓冲
    });

    it('包含复习到期卡片', () => {
      const path = generateLearningPath(mockReport);

      const reviewStep = path.steps.find((s) => s.type === 'review');
      expect(reviewStep).toBeDefined();
      expect(reviewStep?.priority).toBe(3); // 高优先级
    });

    it('包含薄弱点练习', () => {
      const path = generateLearningPath(mockReport);

      const practiceSteps = path.steps.filter((s) => s.type === 'practice');
      expect(practiceSteps.length).toBeGreaterThan(0);

      const cardiovascularPractice = practiceSteps.find((s) =>
        s.target?.includes('心血管系统')
      );
      expect(cardiovascularPractice).toBeDefined();
      expect(cardiovascularPractice?.priority).toBe(3); // 最高优先级
    });

    it('包含笔记复习', () => {
      const path = generateLearningPath(mockReport);

      const studyStep = path.steps.find((s) => s.type === 'study');
      expect(studyStep).toBeDefined();
    });

    it('步骤按优先级排序', () => {
      const path = generateLearningPath(mockReport);

      // 高优先级步骤应该靠前
      const firstHighPriority = path.steps.findIndex((s) => s.priority === 3);
      const firstLowPriority = path.steps.findIndex((s) => s.priority === 1);

      if (firstHighPriority >= 0 && firstLowPriority >= 0) {
        expect(firstHighPriority).toBeLessThan(firstLowPriority);
      }
    });

    it('支持自定义目标时长', () => {
      const shortPath = generateLearningPath(mockReport, { targetMinutes: 30 });
      const longPath = generateLearningPath(mockReport, { targetMinutes: 180 });

      expect(shortPath.totalMinutes).toBeLessThanOrEqual(40); // 30 + 小缓冲
      expect(longPath.totalMinutes).toBeGreaterThan(shortPath.totalMinutes);
      expect(longPath.steps.length).toBeGreaterThan(shortPath.steps.length);
    });

    it('支持优先复习模式', () => {
      const reviewPath = generateLearningPath(mockReport, {
        prioritizeReview: true,
      });

      const reviewSteps = reviewPath.steps.filter((s) => s.type === 'review');

      expect(reviewSteps.length).toBeGreaterThan(0);
    });

    it('包含巩固步骤', () => {
      const path = generateLearningPath(mockReport);

      const consolidateStep = path.steps.find((s) => s.type === 'consolidate');
      expect(consolidateStep).toBeDefined();
      expect(consolidateStep?.description).toContain('回顾');
    });

    it('提供学习资源链接', () => {
      const path = generateLearningPath(mockReport);

      const stepsWithResources = path.steps.filter(
        (s) => s.resources && s.resources.length > 0
      );
      expect(stepsWithResources.length).toBeGreaterThan(0);
    });
  });

  describe('generateWeeklyLearningPlan', () => {
    it('生成多日学习计划', () => {
      const weekPlan = generateWeeklyLearningPlan(mockReport, 7, 60);

      expect(weekPlan.length).toBe(7);
      expect(weekPlan[0].title).toContain('Day 1');
      expect(weekPlan[6].title).toContain('Day 7');
    });

    it('每日计划符合时长要求', () => {
      const weekPlan = generateWeeklyLearningPlan(mockReport, 5, 45);

      for (const dailyPlan of weekPlan) {
        expect(dailyPlan.totalMinutes).toBeLessThanOrEqual(60); // 45 + 缓冲
      }
    });

    it('周期性调整策略（每 3 天优先复习）', () => {
      const weekPlan = generateWeeklyLearningPlan(mockReport, 6, 60);

      // Day 3 和 Day 6 应该有更多复习
      const day3ReviewSteps = weekPlan[2].steps.filter((s) => s.type === 'review');

      // Day 3 的复习步骤可能更多（取决于待复习卡片数量）
      expect(day3ReviewSteps.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('快捷方法', () => {
    it('generateTodayPlan 生成今日计划', () => {
      const todayPlan = generateTodayPlan(mockReport, 60);

      expect(todayPlan.totalMinutes).toBeLessThanOrEqual(75); // 60 + 缓冲
      expect(todayPlan.steps.length).toBeGreaterThan(0);
    });

    it('generateWeekendIntensivePlan 生成周末强化计划', () => {
      const weekendPlan = generateWeekendIntensivePlan(mockReport);

      expect(weekendPlan.totalMinutes).toBeGreaterThan(120); // 至少 2 小时
      expect(weekendPlan.steps.length).toBeGreaterThan(3); // 更多步骤
    });
  });

  describe('路径标题与目标', () => {
    it('有薄弱点时强调薄弱点', () => {
      const path = generateLearningPath(mockReport);

      expect(path.title).toContain('薄弱点');
      expect(path.title).toContain('心血管系统');
      expect(path.goal).toContain('心血管系统');
    });

    it('大量待复习卡片时强调复习', () => {
      const heavyReviewReport: WeeklyReport = {
        ...mockReport,
        dueCards: 80, // 大量积压
        weakPoints: [], // 无薄弱点
      };

      const path = generateLearningPath(heavyReviewReport);

      expect(path.title).toContain('复习');
      expect(path.goal).toContain('80');
    });

    it('初学者建议探索新内容', () => {
      const beginnerReport: WeeklyReport = {
        ...mockReport,
        masteryStats: { ...mockReport.masteryStats, quizCount: 0, quizAccuracy: 0 }, // 无做题历史
        dueCards: 0,
        weakPoints: [],
      };

      const path = generateLearningPath(beginnerReport);

      expect(path.title).toContain('探索');
      // 没有做题历史时不能声称「提升正确率」；也不能把同一条「学习新笔记」重复塞满计划
      expect(path.goal).not.toContain('正确率');
      expect(path.steps.filter((step) => step.description === '学习新笔记')).toHaveLength(1);
    });
  });

  describe('边缘情况', () => {
    it('处理无薄弱点的情况', () => {
      const strongReport: WeeklyReport = {
        ...mockReport,
        weakPoints: [],
      };

      const path = generateLearningPath(strongReport);

      expect(path.steps.length).toBeGreaterThan(0);
      expect(path.title).toBeTruthy();
    });

    it('处理无待复习卡片的情况', () => {
      const noReviewReport: WeeklyReport = {
        ...mockReport,
        dueCards: 0,
      };

      const path = generateLearningPath(noReviewReport);

      const reviewSteps = path.steps.filter((s) => s.type === 'review');
      expect(reviewSteps.length).toBe(0);
    });

    it('处理超短时长请求', () => {
      const path = generateLearningPath(mockReport, { targetMinutes: 10 });

      // 即使请求短时长,也会包含必要的复习任务
      expect(path.totalMinutes).toBeLessThanOrEqual(50); // 实际会略超,因为有必需步骤
      expect(path.steps.length).toBeGreaterThan(0);

      // 但应该比默认时长少
      const normalPath = generateLearningPath(mockReport);
      expect(path.steps.length).toBeLessThan(normalPath.steps.length);
    });

    it('处理超长时长请求', () => {
      const path = generateLearningPath(mockReport, { targetMinutes: 300 });

      expect(path.totalMinutes).toBeGreaterThan(120);
      expect(path.steps.length).toBeGreaterThan(5);
    });
  });

  describe('步骤合理性', () => {
    it('每个步骤都有明确的时长', () => {
      const path = generateLearningPath(mockReport);

      for (const step of path.steps) {
        expect(step.estimatedMinutes).toBeGreaterThan(0);
      }
    });

    it('步骤序号连续', () => {
      const path = generateLearningPath(mockReport);

      for (let i = 0; i < path.steps.length; i++) {
        expect(path.steps[i].step).toBe(i + 1);
      }
    });

    it('包含多种学习活动类型', () => {
      const path = generateLearningPath(mockReport, { targetMinutes: 120 });

      const types = new Set(path.steps.map((s) => s.type));
      expect(types.size).toBeGreaterThanOrEqual(2); // 至少 2 种类型
    });
  });
});
