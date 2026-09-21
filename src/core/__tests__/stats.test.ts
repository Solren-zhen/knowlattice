import { beforeEach, describe, expect, it } from 'vitest';
import { last7, markStudy, streak, studyDays, exportDays, importDays, heatmap } from '../stats';

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
    localStorage.setItem('knowlattice-days', JSON.stringify({ [yesterday]: 2 }));
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
    localStorage.setItem('knowlattice-days', JSON.stringify({ b: 1, a: 2 }));
    expect(studyDays()).toEqual(['a', 'b']);
  });

  it('损坏数据回退为空', () => {
    localStorage.setItem('knowlattice-days', 'not-json');
    expect(studyDays()).toEqual([]);
    expect(streak()).toBe(0);
  });

  it('exportDays 导出后清空再导入，打卡与连续天数都能回来', () => {
    markStudy();
    const dumped = exportDays();
    expect(dumped[localDate()]).toBe(1);
    localStorage.clear();
    expect(streak()).toBe(0);
    expect(importDays(dumped)).toBe(1);
    expect(streak()).toBe(1);
  });

  it('importDays 同日取较大值：重复导入同一份备份不会把次数翻倍', () => {
    localStorage.setItem('knowlattice-days', JSON.stringify({ '2024-01-01': 5 }));
    importDays({ '2024-01-01': 2, '2024-01-02': 3 });
    expect(exportDays()).toEqual({ '2024-01-01': 5, '2024-01-02': 3 });
  });

  it('importDays 忽略非数字/非正数/非对象输入', () => {
    expect(importDays(null)).toBe(0);
    expect(importDays('2024-01-01')).toBe(0);
    expect(importDays({ '2024-01-01': 'x', '2024-01-02': -1, '2024-01-03': 0 })).toBe(0);
    expect(importDays({ '2024-01-03': 2 })).toBe(1);
    expect(exportDays()).toEqual({ '2024-01-03': 2 });
  });
});

describe('打卡热力图', () => {
  // 2026-09-21 是周一，所以每列行首都是周一，断言不用猜星期几
  it('铺成 weeks 列 × 7 行，末尾一列以今天为周一开头，未来几天标 future', () => {
    const grid = heatmap('2026-09-21', 3);
    expect(grid).toHaveLength(3);
    expect(grid.every((col) => col.length === 7)).toBe(true);
    expect(grid[0][0].day).toBe('2026-09-07');
    expect(grid[2][0].day).toBe('2026-09-21');
    expect(grid[2][0].future).toBe(false);
    expect(grid[2][1].future).toBe(true); // 周二还没到
    expect(grid[2][6].future).toBe(true);
  });

  it('计数来自存储（今天在最后一列，前一天的周日在上一列末行）', () => {
    localStorage.setItem('knowlattice-days', JSON.stringify({ '2026-09-21': 4, '2026-09-20': 1 }));
    const grid = heatmap('2026-09-21', 2);
    expect(grid[1][0]).toMatchObject({ day: '2026-09-21', count: 4, future: false });
    expect(grid[0][6]).toMatchObject({ day: '2026-09-20', count: 1, future: false });
    expect(grid[1][6]).toMatchObject({ day: '2026-09-27', count: 0, future: true });
  });
});
