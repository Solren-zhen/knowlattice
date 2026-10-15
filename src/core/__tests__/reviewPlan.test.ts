import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDailyCap,
  daysUntilExam,
  DEFAULT_PLAN,
  effectiveDailyCap,
  isIsoDate,
  loadPlan,
  savePlan,
  sanitizePlan,
} from '../reviewPlan';

beforeEach(() => {
  localStorage.clear();
});

describe('reviewPlan · 日期校验', () => {
  it('只接受真实存在的 YYYY-MM-DD', () => {
    expect(isIsoDate('2026-10-05')).toBe(true);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-31')).toBe(false);
    expect(isIsoDate('2026-2-8')).toBe(false);
    expect(isIsoDate('2026/10/05')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
});

describe('reviewPlan · 清洗', () => {
  it('非法输入一律退回默认值', () => {
    expect(sanitizePlan(null)).toEqual(DEFAULT_PLAN);
    expect(sanitizePlan({ examDate: 'oops' }).examDate).toBe('');
    expect(sanitizePlan({ dailyCap: -5 }).dailyCap).toBe(0);
    expect(sanitizePlan({ dailyCap: Number.NaN }).dailyCap).toBe(0);
    expect(sanitizePlan({ dailyCap: 999999 }).dailyCap).toBe(0);
    expect(sanitizePlan({ dailyCap: 12.9 }).dailyCap).toBe(12);
  });

  it('考试名称截断到 40 字', () => {
    expect(sanitizePlan({ examLabel: 'x'.repeat(200) }).examLabel).toHaveLength(40);
  });
});

describe('reviewPlan · 存取', () => {
  it('存进去再读出来是同一份（已清洗）', () => {
    savePlan({ examDate: '2026-10-05', examLabel: '执医笔试', dailyCap: 20 });
    expect(loadPlan()).toEqual({ examDate: '2026-10-05', examLabel: '执医笔试', dailyCap: 20 });
  });

  it('损坏的存储不影响读取', () => {
    localStorage.setItem('knowlattice-review-plan', '{不是 json');
    expect(loadPlan()).toEqual(DEFAULT_PLAN);
  });

  it('默认不限制、未设考试日期', () => {
    expect(loadPlan()).toEqual({ examDate: '', examLabel: '', dailyCap: 0 });
  });
});

describe('reviewPlan · 距考试天数', () => {
  it('按本地日历日算，不受当天时刻影响', () => {
    // 10/05 下午 5 点看 10/06：应当是 1 天，而不是"不足 24 小时"的 0 天
    const now = new Date(2026, 9, 5, 17, 30);
    expect(daysUntilExam('2026-10-06', now)).toBe(1);
    expect(daysUntilExam('2026-10-05', now)).toBe(0);
    expect(daysUntilExam('2026-10-15', now)).toBe(10);
    expect(daysUntilExam('2026-10-01', now)).toBe(-4);
  });

  it('未设置或非法日期返回 null', () => {
    expect(daysUntilExam('')).toBeNull();
    expect(daysUntilExam('2026-13-01')).toBeNull();
  });
});

describe('reviewPlan · 每日上限', () => {
  const now = new Date(2026, 9, 5, 9, 0);

  it('未设上限时不干预', () => {
    expect(effectiveDailyCap({ ...DEFAULT_PLAN, dailyCap: 0 }, 500, now)).toBe(0);
  });

  it('设了上限但没设考试日期：用用户上限', () => {
    expect(effectiveDailyCap({ examDate: '', examLabel: '', dailyCap: 30 }, 500, now)).toBe(30);
  });

  it('考试当天或已过：不再收紧（临考不该拦人）', () => {
    expect(effectiveDailyCap({ examDate: '2026-10-05', examLabel: '', dailyCap: 30 }, 500, now)).toBe(30);
    expect(effectiveDailyCap({ examDate: '2026-09-01', examLabel: '', dailyCap: 30 }, 500, now)).toBe(30);
  });

  it('按剩余天数收紧（只收不放）', () => {
    // 10 天、500 张待清 → 日均 50；用户上限 30 → 取较小的 30
    expect(effectiveDailyCap({ examDate: '2026-10-15', examLabel: '', dailyCap: 30 }, 500, now)).toBe(30);
    // 10 天、50 张待清 → 日均 5；用户上限 30 → 收到 5
    expect(effectiveDailyCap({ examDate: '2026-10-15', examLabel: '', dailyCap: 30 }, 50, now)).toBe(5);
  });

  it('至少保留 1 张，避免把队列锁死', () => {
    // 9 天、1 张待清 → ceil(1/9)=1；不会变成 0（0 在调用方语义是"不限制"）
    expect(effectiveDailyCap({ examDate: '2026-10-14', examLabel: '', dailyCap: 30 }, 1, now)).toBe(1);
  });
});

describe('reviewPlan · 队列截断', () => {
  it('cap <= 0 时返回同一个引用（默认路径零代价）', () => {
    const q = [1, 2, 3];
    expect(applyDailyCap(q, 0)).toBe(q);
    expect(applyDailyCap(q, -1)).toBe(q);
  });

  it('队列不超上限时也返回同一引用', () => {
    const q = [1, 2, 3];
    expect(applyDailyCap(q, 3)).toBe(q);
    expect(applyDailyCap(q, 99)).toBe(q);
  });

  it('超上限时截断', () => {
    expect(applyDailyCap([1, 2, 3, 4], 2)).toEqual([1, 2]);
  });
});
