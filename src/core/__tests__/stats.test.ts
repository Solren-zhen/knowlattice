import { beforeEach, describe, expect, it } from 'vitest';
import { last7, markStudy, streak, studyDays } from '../stats';

beforeEach(() => localStorage.clear());

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('stats', () => {
  it('markStudy 记一次当天行为并累计次数', () => {
    markStudy();
    markStudy();
    expect(studyDays()).toEqual([localDate()]);
  });

  it('streak：今天没学则从昨天起算，不因当天未学清零', () => {
    const yesterday = localDate(new Date(Date.now() - 86_400_000));
    localStorage.setItem('medvault-days', JSON.stringify({ [yesterday]: 2 }));
    expect(streak()).toBe(1); // 仅昨天有 → 连续 1 天
    markStudy();
    expect(streak()).toBe(2); // 今天标记后 → 连续 2 天
  });

  it('last7 恒为 7 天、含今天，且按天递增', () => {
    markStudy();
    const days = last7();
    expect(days).toHaveLength(7);
    expect(days[6].day).toBe(localDate());
    expect(days[6].count).toBe(1);
    expect(days[0].day < days[6].day).toBe(true);
  });

  it('studyDays 排序返回', () => {
    localStorage.setItem('medvault-days', JSON.stringify({ b: 1, a: 2 }));
    expect(studyDays()).toEqual(['a', 'b']);
  });

  it('损坏数据回退为空', () => {
    localStorage.setItem('medvault-days', 'not-json');
    expect(studyDays()).toEqual([]);
    expect(streak()).toBe(0);
  });
});
