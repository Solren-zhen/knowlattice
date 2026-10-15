// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { QuizBank } from '../qbank';
import {
  dailyQuestions, dailyRecord, dailyStreak, DAILY_COUNT, exportDaily,
  importDaily, isDailyDone, last7Daily, mulberry32, recordDailyProgress, seedOf, todayKey,
} from '../dailyPractice';

function bankWith(n: number): QuizBank {
  return {
    name: 'B', importedAt: 0,
    questions: Array.from({ length: n }, (_, i) => ({
      id: `q${i}`, type: 'choice' as const, stem: `s${i}`, options: ['A', 'B'], answer: 0, answerText: 'A',
    })),
  };
}

beforeEach(() => localStorage.clear());

describe('dailyPractice · 确定性抽题', () => {
  it('同一天同一题库抽到同一套（顺序与题号都一致）', () => {
    const b = bankWith(100);
    const a1 = dailyQuestions(b, '2026-10-13', DAILY_COUNT, {}).map((q) => q.id);
    const a2 = dailyQuestions(b, '2026-10-13', DAILY_COUNT, {}).map((q) => q.id);
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(DAILY_COUNT);
    expect(new Set(a1).size).toBe(DAILY_COUNT); // 无重复
  });

  it('换一天就会换一套题', () => {
    const b = bankWith(100);
    const a = dailyQuestions(b, '2026-10-13', DAILY_COUNT, {}).map((q) => q.id);
    const c = dailyQuestions(b, '2026-10-14', DAILY_COUNT, {}).map((q) => q.id);
    expect(a).not.toEqual(c);
  });

  it('seedOf 稳定、mulberry32 可复现', () => {
    expect(seedOf('abc')).toBe(seedOf('abc'));
    expect(seedOf('abc')).not.toBe(seedOf('abd'));
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('池子不够时按实际题量返回', () => {
    expect(dailyQuestions(bankWith(5), '2026-10-13', DAILY_COUNT, {})).toHaveLength(5);
  });
});

describe('dailyPractice · 进度与连续打卡', () => {
  it('todayKey 输出本地日历日', () => {
    expect(todayKey(new Date(2026, 9, 13, 23, 30))).toBe('2026-10-13');
  });

  it('做满目标才算法「完成」，重做不倒退进度', () => {
    recordDailyProgress('2026-10-13', 'B', 20, 5);
    expect(dailyRecord('2026-10-13')).toMatchObject({ bank: 'B', total: 20, done: 5 });
    expect(isDailyDone('2026-10-13')).toBe(false);
    recordDailyProgress('2026-10-13', 'B', 20, 20);
    expect(isDailyDone('2026-10-13')).toBe(true);
    recordDailyProgress('2026-10-13', 'B', 20, 3); // 重做开始时进度较小
    expect(dailyRecord('2026-10-13')!.done).toBe(20); // 不倒退
  });

  it('连续天数：今天没完成则从昨天起算，断一天就停', () => {
    recordDailyProgress('2026-10-13', 'B', 5, 5);
    recordDailyProgress('2026-10-12', 'B', 5, 5);
    recordDailyProgress('2026-10-10', 'B', 5, 5); // 断了 10-11
    expect(dailyStreak('2026-10-13')).toBe(2);
    expect(dailyStreak('2026-10-11')).toBe(1); // 当天没做→从 10-10 起算
    expect(dailyStreak('2026-10-09')).toBe(0); // 10-09/10-08 都没做
  });

  it('近 7 天快照长度固定为 7', () => {
    recordDailyProgress('2026-10-13', 'B', 5, 5);
    const week = last7Daily('2026-10-13');
    expect(week).toHaveLength(7);
    expect(week[6].day).toBe('2026-10-13');
    expect(week[6].done).toBe(true);
  });

  it('导出/恢复：同日取较大进度', () => {
    recordDailyProgress('2026-10-13', 'B', 20, 10);
    const snapshot = exportDaily();
    const n = importDaily({ ...snapshot, '2026-10-13': { bank: 'B', total: 20, done: 3 } });
    expect(n).toBe(1);
    expect(dailyRecord('2026-10-13')!.done).toBe(10);
  });
});
