import { describe, expect, it } from 'vitest';
import {
  ENTROPY_CAPACITY,
  TREND_LABELS,
  pressureBuckets,
  pressureLevel,
  pressureLine,
  pressureMetrics,
  reviewPressure,
  todayNet,
  trendOf,
  type PressureBuckets,
} from '../reviewPressure';
import type { MistakeMap } from '../mistakes';

const DAY = 86_400_000;

function at(now: number, offsetDays: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetDays * DAY;
}

function rec(dueInDays: number, extra: Partial<Record<string, number>> = {}, now = Date.now()) {
  return { path: 'n.md', chapter: 'c', title: 't', count: 1, lastFailedAt: 0, dueAt: at(now, dueInDays), ...extra };
}

describe('reviewPressure', () => {
  it('空表是 empty，不除零', () => {
    const m = pressureMetrics({ today: 0, tomorrow: 0, week: 0 });
    expect(m.peak).toBe(0);
    expect(m.entropyPercent).toBe(0);
    expect(m.todayShare).toBe(0);
    expect(pressureLevel(m)).toBe('empty');
    expect(pressureLine(m)).toContain('已清空');
  });

  it('加权公式与归一化', () => {
    const m = pressureMetrics({ today: 24, tomorrow: 0, week: 24 });
    expect(m.weighted).toBeCloseTo(24 * 0.5 + 24 * 0.2, 6);
    expect(m.entropy).toBeCloseTo((24 * 0.5 + 24 * 0.2) / ENTROPY_CAPACITY, 6);
    expect(m.peak).toBe(24);
    expect(m.remainingWindow).toBe(0);
  });

  it('熵到 85% 是 high，50% 是 medium', () => {
    // 24*.5 + 24*.3 + 48*.2 = 12 + 7.2 + 9.6 = 28.8 → 60%
    expect(pressureLevel(pressureMetrics({ today: 24, tomorrow: 24, week: 48 }))).toBe('medium');
    // 50*.5 + 50*.3 + 50*.2 = 50 > 48 → clamp 到 100%
    expect(pressureLevel(pressureMetrics({ today: 50, tomorrow: 50, week: 50 }))).toBe('high');
  });

  it('today 含逾期，tomorrow 只算明天那一天，week 是 7 天窗口', () => {
    const now = Date.now();
    const map = {
      'a.md': rec(-5, {}, now),
      'b.md': rec(0, {}, now),
      'c.md': rec(1, {}, now),
      'd.md': rec(3, {}, now),
      'e.md': rec(9, {}, now),
    } as unknown as MistakeMap;
    const b = pressureBuckets(now, map);
    expect(b.today).toBe(2);
    expect(b.tomorrow).toBe(1);
    expect(b.week).toBe(4);
  });

  it('已归档不计入', () => {
    const now = Date.now();
    const map = { 'a.md': rec(0, { stage: 3 }, now) } as unknown as MistakeMap;
    expect(pressureBuckets(now, map)).toEqual({ today: 0, tomorrow: 0, week: 0 } as PressureBuckets);
  });

  it('净减少与趋势四态', () => {
    expect(trendOf(20, 20)).toBe('accelerating');
    expect(trendOf(3, 20)).toBe('improving');
    expect(trendOf(0, 20)).toBe('stable');
    expect(trendOf(-1, 20)).toBe('worsening');
    expect(TREND_LABELS.worsening).toBe('积压增加');
  });

  it('todayNet = 今日归档 - 今日新增失败', () => {
    const now = Date.now();
    const map = {
      'a.md': rec(9, { stage: 3, lastAdvanceAt: now, lastFailedAt: 0 }, now),
      'b.md': rec(0, { stage: 0, lastFailedAt: now }, now),
    } as unknown as MistakeMap;
    expect(todayNet(now, map)).toBe(0);
  });

  it('reviewPressure 一次给出指标、文案与趋势', () => {
    const now = Date.now();
    const map = { 'a.md': rec(0, {}, now) } as unknown as MistakeMap;
    const r = reviewPressure(now, map);
    expect(r.metrics.today).toBe(1);
    expect(r.line).toContain('今天 1 题');
    expect(['accelerating', 'improving', 'stable', 'worsening']).toContain(r.trend);
  });
});