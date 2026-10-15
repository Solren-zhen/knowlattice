import { describe, expect, it } from 'vitest';
import {
  TREND_BOX,
  pointAtX,
  trendAreaPath,
  trendLinePath,
  trendMax,
  trendShortDay,
  trendTotals,
  trendX,
  trendY,
  type TrendPoint,
} from '../trend';

const P = (day: string, count: number, minutes = count * 25): TrendPoint => ({ day, count, minutes });
/** 7 个点：0,1,2,3,4,5,6 */
const week = ['10-06', '10-07', '10-08', '10-09', '10-10', '10-11', '10-12'].map((d, i) => P(d, i));

describe('trendMax', () => {
  it('取最大值；全 0 时给 1（避免除零把线压成 NaN）', () => {
    expect(trendMax(week)).toBe(6);
    expect(trendMax([P('2026-10-01', 0), P('2026-10-02', 0)])).toBe(1);
    expect(trendMax([])).toBe(1);
  });
});

describe('trendX', () => {
  it('首末点各留一个 padX，其余均匀分布', () => {
    expect(trendX(0, 7, TREND_BOX)).toBe(TREND_BOX.padX);
    expect(trendX(6, 7, TREND_BOX)).toBe(TREND_BOX.width - TREND_BOX.padX);
    expect(trendX(3, 7, TREND_BOX)).toBeCloseTo((TREND_BOX.padX + TREND_BOX.width - TREND_BOX.padX) / 2, 6);
  });

  it('只有一天时居中（不是贴左边）', () => {
    expect(trendX(0, 1, TREND_BOX)).toBeCloseTo(TREND_BOX.width / 2, 6);
  });

  it('越界下标被钳制，不会画到框外', () => {
    expect(trendX(-5, 7, TREND_BOX)).toBe(TREND_BOX.padX);
    expect(trendX(99, 7, TREND_BOX)).toBe(TREND_BOX.width - TREND_BOX.padX);
  });
});

describe('trendY', () => {
  it('最大值贴顶（padTop），0 贴基线', () => {
    expect(trendY(6, 6, TREND_BOX)).toBeCloseTo(TREND_BOX.padTop, 6);
    expect(trendY(0, 6, TREND_BOX)).toBeCloseTo(TREND_BOX.height - TREND_BOX.padBottom, 6);
  });

  it('超过上限的值被钳到顶（不至于画出框）', () => {
    expect(trendY(99, 6, TREND_BOX)).toBeCloseTo(TREND_BOX.padTop, 6);
  });
});

describe('趋势路径', () => {
  it('折线以 M 开头，段数与点数对应', () => {
    const d = trendLinePath(week);
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/L/g)).toHaveLength(week.length - 1);
  });

  it('面积路径闭合，且回到基线', () => {
    const d = trendAreaPath(week);
    const baseline = TREND_BOX.height - TREND_BOX.padBottom;
    expect(d.endsWith('Z')).toBe(true);
    expect(d).toContain(String(baseline.toFixed(2)));
  });

  it('空数据返回空串（组件据此不画面积层）', () => {
    expect(trendLinePath([])).toBe('');
    expect(trendAreaPath([])).toBe('');
  });
});

describe('pointAtX（磁吸）', () => {
  const spacing = (TREND_BOX.width - TREND_BOX.padX * 2) / 6;

  it('正落在某个点上 → 就是它', () => {
    for (let i = 0; i < 7; i++) expect(pointAtX(trendX(i, 7, TREND_BOX), 7, TREND_BOX)).toBe(i);
  });

  it('两点之间取最近的（越过中点才换档）', () => {
    const a = trendX(2, 7, TREND_BOX);
    expect(pointAtX(a + spacing * 0.49, 7, TREND_BOX)).toBe(2);
    expect(pointAtX(a + spacing * 0.51, 7, TREND_BOX)).toBe(3);
  });

  it('中点归后一个点：与「越过中点才换」一致，不是四舍五入到偶数侧', () => {
    const a = trendX(2, 7, TREND_BOX);
    expect(pointAtX(a + spacing / 2, 7, TREND_BOX)).toBe(3);
  });

  it('拖出绘图区仍然落在端点上（不会越出数据范围）', () => {
    expect(pointAtX(-500, 7, TREND_BOX)).toBe(0);
    expect(pointAtX(9999, 7, TREND_BOX)).toBe(6);
  });

  it('只有一天时永远返回 0', () => {
    expect(pointAtX(0, 1, TREND_BOX)).toBe(0);
    expect(pointAtX(999, 1, TREND_BOX)).toBe(0);
  });
});

describe('trendShortDay', () => {
  it('取月-日；非标准格式原样返回', () => {
    expect(trendShortDay('2026-10-13')).toBe('10-13');
    expect(trendShortDay('03-13')).toBe('03-13');
    expect(trendShortDay('')).toBe('');
  });
});

describe('trendTotals', () => {
  it('合计周期与分钟（底部说明与无障碍标签共用这一份口径）', () => {
    expect(trendTotals(week)).toEqual({ count: 21, minutes: 525 });
    expect(trendTotals([])).toEqual({ count: 0, minutes: 0 });
  });
});
