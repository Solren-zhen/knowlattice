import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningStats } from '../achievementSystem';

/**
 * 成就的落盘与幂等：同一份统计连调两次，第二次不该再报「新解锁」。
 * 这条是 StrictMode 下 effect 跑两次、以及面板反复开关时界面不刷屏的前提。
 */

const KEY = 'knowlattice-achievements';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** 一份「什么都没有」的统计 */
const zero: LearningStats = {
  streakDays: 0,
  totalDays: 0,
  totalNotes: 0,
  totalCards: 0,
  masteredCards: 0,
  perfectCards: 0,
  reviewCount: 0,
  totalQuizzes: 0,
  quizAccuracy: 0,
  maxDailyMinutes: 0,
};

describe('syncAchievements', () => {
  it('全零统计不解锁任何成就，也不会写坏存储', async () => {
    const { syncAchievements, loadAchievements } = await import('../achievementStore');
    const state = syncAchievements(zero);
    expect(state.newlyUnlocked).toEqual([]);
    expect(state.summary.totalUnlocked).toBe(0);
    expect(state.summary.totalAchievements).toBeGreaterThan(0);
    // 仍会落盘（存的是「21 个都没解锁」的完整列表），下次读回来是同样长度
    expect(loadAchievements().length).toBe(state.summary.totalAchievements);
  });

  it('达到条件即解锁，并带上 unlockedAt', async () => {
    const { syncAchievements } = await import('../achievementStore');
    const state = syncAchievements({ ...zero, streakDays: 3 });
    const ids = state.newlyUnlocked.map((a) => a.id);
    expect(ids).toContain('streak-3');
    const got = state.achievements.find((a) => a.id === 'streak-3')!;
    expect(got.unlocked).toBe(true);
    expect(got.unlockedAt).toBeGreaterThan(0);
  });

  it('幂等：同一份统计第二次调用不再报新解锁', async () => {
    const { syncAchievements } = await import('../achievementStore');
    const first = syncAchievements({ ...zero, streakDays: 7 });
    expect(first.newlyUnlocked.length).toBeGreaterThan(0);

    const second = syncAchievements({ ...zero, streakDays: 7 });
    expect(second.newlyUnlocked).toEqual([]);
    // 已解锁数不变，且解锁时间被保留（不是重新盖成 now）
    expect(second.summary.totalUnlocked).toBe(first.summary.totalUnlocked);
    const before = first.achievements.find((a) => a.id === 'streak-7')!.unlockedAt;
    const after = second.achievements.find((a) => a.id === 'streak-7')!.unlockedAt;
    expect(after).toBe(before);
  });

  it('进度不回退：先解锁的成就，统计掉下去也保持解锁', async () => {
    const { syncAchievements } = await import('../achievementStore');
    syncAchievements({ ...zero, streakDays: 30 });
    const state = syncAchievements(zero); // 统计归零
    expect(state.achievements.find((a) => a.id === 'streak-30')!.unlocked).toBe(true);
  });

  it('nearby 只给未解锁且进度 ≥ 80% 的', async () => {
    const { syncAchievements } = await import('../achievementStore');
    // 笔记 8/10 → 80%，应当出现在 nearby 里
    const state = syncAchievements({ ...zero, totalNotes: 8 });
    expect(state.nearby.map((a) => a.id)).toContain('notes-10');
    expect(state.nearby.every((a) => !a.unlocked)).toBe(true);
  });

  it('存储损坏时按「从零开始」处理，不抛', async () => {
    localStorage.setItem(KEY, '{ 这不是 JSON');
    const { syncAchievements } = await import('../achievementStore');
    const state = syncAchievements({ ...zero, streakDays: 3 });
    expect(state.newlyUnlocked.map((a) => a.id)).toContain('streak-3');
  });

  it('resetAchievements 清空进度', async () => {
    const { syncAchievements, loadAchievements, resetAchievements } = await import('../achievementStore');
    syncAchievements({ ...zero, streakDays: 3 });
    expect(loadAchievements().some((a) => a.unlocked)).toBe(true);
    resetAchievements();
    expect(loadAchievements()).toEqual([]);
  });
});
