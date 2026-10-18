import { describe, expect, it } from 'vitest';
import type { LearningStats } from '../achievementSystem';
import {
  checkAchievements,
  getAchievementSummary,
  getNearbyAchievements,
} from '../achievementSystem';

describe('achievementSystem', () => {
  const mockStats: LearningStats = {
    streakDays: 7,
    totalDays: 30,
    totalNotes: 50,
    totalCards: 100,
    reviewCount: 150,
    reviewAccuracy: 0.88,
    totalQuizzes: 120,
    quizAccuracy: 0.75,
    perfectCards: 30,
    maxDailyMinutes: 200,
    mistakesCorrected: 25,
  };

  describe('checkAchievements', () => {
    it('初次检查解锁符合条件的成就', () => {
      const result = checkAchievements(mockStats);

      expect(result.achievements.length).toBeGreaterThan(0);
      expect(result.newlyUnlocked.length).toBeGreaterThan(0);

      // 应该解锁 streak-3（连续 3 天）
      const streak3 = result.newlyUnlocked.find((a) => a.id === 'streak-3');
      expect(streak3).toBeDefined();
      expect(streak3?.unlocked).toBe(true);
      expect(streak3?.unlockedAt).toBeDefined();
    });

    it('解锁多个成就', () => {
      const result = checkAchievements(mockStats);

      // 应该解锁：
      // - streak-3, streak-7（连续学习）
      // - notes-10（笔记 10 篇）
      // - reviews-100（复习 100 次）
      // - quizzes-100（做题 100 道）
      // - challenge-all-round（全能学者）

      const unlockedIds = result.newlyUnlocked.map((a) => a.id);
      expect(unlockedIds).toContain('streak-3');
      expect(unlockedIds).toContain('streak-7');
      expect(unlockedIds).toContain('notes-10');
      expect(unlockedIds).toContain('reviews-100');
      expect(unlockedIds).toContain('quizzes-100');
    });

    it('保留之前已解锁的成就', () => {
      const firstCheck = checkAchievements(mockStats);

      // 第二次检查（使用相同 stats）
      const secondCheck = checkAchievements(mockStats, firstCheck.achievements);

      expect(secondCheck.newlyUnlocked.length).toBe(0); // 没有新解锁
      expect(secondCheck.achievements.filter((a) => a.unlocked).length).toBe(
        firstCheck.achievements.filter((a) => a.unlocked).length
      ); // 已解锁数量不变
    });

    it('为未解锁成就显示进度', () => {
      const result = checkAchievements(mockStats);

      const streak30 = result.achievements.find((a) => a.id === 'streak-30');
      expect(streak30?.unlocked).toBe(false);
      expect(streak30?.progress).toBeDefined();
      expect(streak30?.progress?.current).toBe(7); // 当前 7 天
      expect(streak30?.progress?.target).toBe(30); // 目标 30 天
    });

    it('新数据解锁新成就', () => {
      const firstCheck = checkAchievements(mockStats);

      // 提升数据
      const improvedStats: LearningStats = {
        ...mockStats,
        streakDays: 30, // 从 7 天提升到 30 天
      };

      const secondCheck = checkAchievements(improvedStats, firstCheck.achievements);

      // 应该解锁 streak-30
      expect(secondCheck.newlyUnlocked.length).toBeGreaterThan(0);
      const streak30 = secondCheck.newlyUnlocked.find((a) => a.id === 'streak-30');
      expect(streak30).toBeDefined();
    });
  });

  describe('成就评估逻辑', () => {
    it('连续学习成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        streakDays: 100,
      };

      const result = checkAchievements(stats);

      const streak100 = result.achievements.find((a) => a.id === 'streak-100');
      expect(streak100?.unlocked).toBe(true);
    });

    it('笔记里程碑成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        totalNotes: 100,
      };

      const result = checkAchievements(stats);

      const notes100 = result.achievements.find((a) => a.id === 'notes-100');
      expect(notes100?.unlocked).toBe(true);
    });

    it('复习次数成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        reviewCount: 500,
      };

      const result = checkAchievements(stats);

      const reviews500 = result.achievements.find((a) => a.id === 'reviews-500');
      expect(reviews500?.unlocked).toBe(true);
    });

    it('做题数量成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        totalQuizzes: 1000,
      };

      const result = checkAchievements(stats);

      const quizzes1000 = result.achievements.find((a) => a.id === 'quizzes-1000');
      expect(quizzes1000?.unlocked).toBe(true);
    });

    it('复习正确率成就（需满足最小样本量）', () => {
      const insufficientStats: LearningStats = {
        ...mockStats,
        reviewAccuracy: 0.95,
        reviewCount: 30, // 不足 50 次
      };

      const result1 = checkAchievements(insufficientStats);
      const accuracy90_1 = result1.achievements.find(
        (a) => a.id === 'review-accuracy-90'
      );
      expect(accuracy90_1?.unlocked).toBe(false); // 样本量不足

      const sufficientStats: LearningStats = {
        ...mockStats,
        reviewAccuracy: 0.92,
        reviewCount: 100, // 满足 50 次
      };

      const result2 = checkAchievements(sufficientStats);
      const accuracy90_2 = result2.achievements.find(
        (a) => a.id === 'review-accuracy-90'
      );
      expect(accuracy90_2?.unlocked).toBe(true); // 样本量足够且正确率达标
    });

    it('做题正确率成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        quizAccuracy: 0.85,
        totalQuizzes: 150,
      };

      const result = checkAchievements(stats);

      const quizAccuracy80 = result.achievements.find(
        (a) => a.id === 'quiz-accuracy-80'
      );
      expect(quizAccuracy80?.unlocked).toBe(true);
    });

    it('完美卡片成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        perfectCards: 60,
      };

      const result = checkAchievements(stats);

      const perfectCards50 = result.achievements.find(
        (a) => a.id === 'perfect-cards-50'
      );
      expect(perfectCards50?.unlocked).toBe(true);
    });

    it('错题改正成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        mistakesCorrected: 50,
      };

      const result = checkAchievements(stats);

      const mistakesCorrected = result.achievements.find(
        (a) => a.id === 'mistakes-corrected-50'
      );
      expect(mistakesCorrected?.unlocked).toBe(true);
    });

    it('单日学习时长成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        maxDailyMinutes: 300,
      };

      const result = checkAchievements(stats);

      const daily5hours = result.achievements.find((a) => a.id === 'daily-5hours');
      expect(daily5hours?.unlocked).toBe(true);
    });

    it('全能学者成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        totalNotes: 5,
        reviewCount: 10,
        totalQuizzes: 15,
      };

      const result = checkAchievements(stats);

      const allRound = result.achievements.find((a) => a.id === 'challenge-all-round');
      expect(allRound?.unlocked).toBe(true);
    });
  });

  describe('getAchievementSummary', () => {
    it('统计已解锁成就数量', () => {
      const result = checkAchievements(mockStats);
      const summary = getAchievementSummary(result.achievements);

      expect(summary.totalUnlocked).toBeGreaterThan(0);
      expect(summary.totalAchievements).toBeGreaterThan(0);
      expect(summary.totalUnlocked).toBeLessThanOrEqual(summary.totalAchievements);
    });

    it('按等级统计已解锁成就', () => {
      const result = checkAchievements(mockStats);
      const summary = getAchievementSummary(result.achievements);

      expect(summary.unlockedByTier).toBeDefined();
      expect(Object.keys(summary.unlockedByTier).length).toBe(5); // 5 个等级
    });

    it('返回最近解锁的成就', () => {
      const result = checkAchievements(mockStats);
      const summary = getAchievementSummary(result.achievements);

      expect(summary.recentUnlocked.length).toBeGreaterThan(0);
      expect(summary.recentUnlocked.length).toBeLessThanOrEqual(5); // 最多 5 个

      // 按时间倒序
      for (let i = 1; i < summary.recentUnlocked.length; i++) {
        expect(summary.recentUnlocked[i - 1].unlockedAt!).toBeGreaterThanOrEqual(
          summary.recentUnlocked[i].unlockedAt!
        );
      }
    });
  });

  describe('getNearbyAchievements', () => {
    it('返回接近解锁的成就（进度 >= 80%）', () => {
      const stats: LearningStats = {
        ...mockStats,
        streakDays: 25, // 30 的 83%
        totalNotes: 85, // 100 的 85%
      };

      const result = checkAchievements(stats);
      const nearby = getNearbyAchievements(result.achievements);

      expect(nearby.length).toBeGreaterThan(0);

      // 所有返回的成就进度应该 >= 80%
      for (const achievement of nearby) {
        const progress = achievement.progress!;
        expect(progress.current / progress.target).toBeGreaterThanOrEqual(0.8);
      }
    });

    it('按进度降序排序', () => {
      const stats: LearningStats = {
        ...mockStats,
        streakDays: 27, // 30 的 90%
        totalNotes: 82, // 100 的 82%
      };

      const result = checkAchievements(stats);
      const nearby = getNearbyAchievements(result.achievements);

      // 进度递减
      for (let i = 1; i < nearby.length; i++) {
        const progressPrev =
          nearby[i - 1].progress!.current / nearby[i - 1].progress!.target;
        const progressCurr = nearby[i].progress!.current / nearby[i].progress!.target;
        expect(progressPrev).toBeGreaterThanOrEqual(progressCurr);
      }
    });

    it('不包含已解锁的成就', () => {
      const result = checkAchievements(mockStats);
      const nearby = getNearbyAchievements(result.achievements);

      expect(nearby.every((a) => !a.unlocked)).toBe(true);
    });

    it('不包含进度 < 80% 的成就', () => {
      const stats: LearningStats = {
        ...mockStats,
        streakDays: 5, // 30 的 16.7%，不符合
      };

      const result = checkAchievements(stats);
      const nearby = getNearbyAchievements(result.achievements);

      const streak30 = nearby.find((a) => a.id === 'streak-30');
      expect(streak30).toBeUndefined(); // 不应出现
    });
  });

  describe('成就属性', () => {
    it('所有成就都有完整属性', () => {
      const result = checkAchievements(mockStats);

      for (const achievement of result.achievements) {
        expect(achievement.id).toBeTruthy();
        expect(achievement.name).toBeTruthy();
        expect(achievement.description).toBeTruthy();
        expect(achievement.type).toBeTruthy();
        expect(achievement.tier).toBeGreaterThanOrEqual(1);
        expect(achievement.tier).toBeLessThanOrEqual(5);
        expect(achievement.icon).toBeTruthy();
        expect(achievement.requirement).toBeTruthy();
      }
    });

    it('已解锁成就有解锁时间', () => {
      const result = checkAchievements(mockStats);

      const unlocked = result.achievements.filter((a) => a.unlocked);

      for (const achievement of unlocked) {
        expect(achievement.unlockedAt).toBeDefined();
        expect(achievement.unlockedAt).toBeGreaterThan(0);
      }
    });

    it('未解锁成就有进度信息', () => {
      const result = checkAchievements(mockStats);

      const locked = result.achievements.filter((a) => !a.unlocked);

      for (const achievement of locked) {
        if (achievement.progress) {
          expect(achievement.progress.current).toBeGreaterThanOrEqual(0);
          expect(achievement.progress.target).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('边缘情况', () => {
    it('处理全零数据', () => {
      const zeroStats: LearningStats = {
        streakDays: 0,
        totalDays: 0,
        totalNotes: 0,
        totalCards: 0,
        reviewCount: 0,
        reviewAccuracy: 0,
        totalQuizzes: 0,
        quizAccuracy: 0,
        perfectCards: 0,
        maxDailyMinutes: 0,
        mistakesCorrected: 0,
      };

      const result = checkAchievements(zeroStats);

      expect(result.achievements.length).toBeGreaterThan(0);
      expect(result.newlyUnlocked.length).toBe(0); // 无成就解锁
    });

    it('处理超高数据', () => {
      const extremeStats: LearningStats = {
        streakDays: 500,
        totalDays: 500,
        totalNotes: 1000,
        totalCards: 5000,
        reviewCount: 10000,
        reviewAccuracy: 0.99,
        totalQuizzes: 5000,
        quizAccuracy: 0.95,
        perfectCards: 500,
        maxDailyMinutes: 600,
        mistakesCorrected: 500,
      };

      const result = checkAchievements(extremeStats);

      // 应该解锁所有可评估的成就
      const unlocked = result.achievements.filter((a) => a.unlocked);
      expect(unlocked.length).toBeGreaterThan(10);
    });

    it('处理空的已解锁列表', () => {
      const result = checkAchievements(mockStats, []);

      expect(result.newlyUnlocked.length).toBeGreaterThan(0);
    });
  });
});
