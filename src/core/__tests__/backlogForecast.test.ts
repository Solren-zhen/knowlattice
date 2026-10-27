import { describe, expect, it } from 'vitest';
import {
  backlogSeries,
  forecastBacklog,
  forecastLine,
  netByDay,
  type DailyNet,
} from '../backlogForecast';
import type { MistakeMap } from '../mistakes';

const DAY = 86_400_000;

function nets(values: number[]): DailyNet[] {
  return values.map((net, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), net }));
}

describe('backlogForecast', () => {
  it('历史积压从当前值往回倒推', () => {
    const out = backlogSeries(nets([0, -2, 1]), 10);
    // net 是「净清量」：今天清 1 → 昨天积压 11；再往前那天净增 2 → 更早 9
    expect(out[2]).toBe(10);
    expect(out[1]).toBe(11);
    expect(out[0]).toBe(9);
  });

  it('倒推夹在 0 以上', () => {
    // 那天净增的量大于当前积压时，更早的积压夹到 0 而不是负数
    expect(backlogSeries(nets([0, -50]), 3)).toEqual([0, 3]);
  });

  it('逐日净变化认晋级为清、失败为增', () => {
    const now = Date.now();
    const map: MistakeMap = {
      'a.md': { path: 'a.md', chapter: 'c', title: 't', count: 1, lastFailedAt: now, stage: 0, lastAdvanceAt: 0, dueAt: now },
      'b.md': { path: 'b.md', chapter: 'c', title: 't', count: 1, lastFailedAt: 0, stage: 1, lastAdvanceAt: now - DAY, dueAt: now },
    };
    const out = netByDay(now, map, 3);
    expect(out).toHaveLength(3);
    expect(out[2].net).toBe(-1);
    expect(out[1].net).toBe(1);
    expect(out[0].net).toBe(0);
  });

  it('净清节奏推出清空天数与更宽的区间', () => {
    const f = forecastBacklog(nets([-2, -2, -2]), 10);
    expect(f.dailyRate).toBe(2);
    expect(f.clearDays).toBe(5);
    expect(f.points[0].value).toBe(8);
    expect(f.points[6].value).toBe(0);
    // 步数越远区间越宽
    const first = f.points[0].upper - f.points[0].lower;
    const last = f.points[6].upper - f.points[6].lower;
    expect(last).toBeGreaterThan(first);
    expect(forecastLine(f)).toContain('约 4–9 天');
  });

  it('在堆时如实说清不空', () => {
    const f = forecastBacklog(nets([3, 3, 3]), 10);
    expect(f.meanNet).toBe(3);
    expect(forecastLine(f)).toContain('清不空');
  });

  it('积压为零时天数为 0 且文案直接给清空', () => {
    const f = forecastBacklog(nets([0, 0]), 0);
    expect(f.clearDays).toBe(0);
    expect(f.clearRange).toEqual([0, 0]);
    expect(forecastLine(f)).toBe('积压已清空。');
  });
});
