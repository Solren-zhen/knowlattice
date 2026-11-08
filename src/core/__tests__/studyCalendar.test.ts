import { beforeEach, describe, expect, it } from 'vitest';
import {
  DAY_NOTES_KEY,
  UNCATEGORIZED,
  dailyStats,
  fmtMinutes,
  loadDayNotes,
  monthCells,
  overallSummary,
  readDayNote,
  subjectColorMap,
  todayKey,
  trendDays,
  writeDayNote,
} from '../studyCalendar';
import type { PomodoroRecord } from '../pomodoro';

const rec = (day: string, minutes: number, subject?: string): PomodoroRecord => ({
  id: `${day}-${minutes}-${subject ?? 'x'}-${Math.random()}`,
  day,
  endedAt: 0,
  minutes,
  ...(subject ? { subject } : {}),
});

describe('studyCalendar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('月历固定 42 格，周一起始，标出本月与未来', () => {
    const cells = monthCells(2026, 10, [], '2026-10-10');
    expect(cells).toHaveLength(42);
    // 2026-10-01 是周四 → 网格从 9-28（周一）开始
    expect(cells[0].day).toBe('2026-09-28');
    expect(cells[0].inMonth).toBe(false);
    expect(cells[3].day).toBe('2026-10-01');
    expect(cells[3].inMonth).toBe(true);
    expect(cells.find((c) => c.day === '2026-10-10')?.future).toBe(false);
    expect(cells.find((c) => c.day === '2026-10-11')?.future).toBe(true);
  });

  it('按天汇总科目，缺科目的旧记录归入未分类', () => {
    const stats = dailyStats([
      rec('2026-10-01', 25, '数学'),
      rec('2026-10-01', 50, '数学'),
      rec('2026-10-01', 25, '英语'),
      rec('2026-10-01', 30),
    ]);
    const day = stats.get('2026-10-01');
    expect(day?.minutes).toBe(130);
    expect(day?.sessions).toBe(4);
    expect(day?.subjects).toEqual([
      { name: '数学', minutes: 75 },
      { name: UNCATEGORIZED, minutes: 30 },
      { name: '英语', minutes: 25 },
    ]);
  });

  it('趋势取最近 N 天并按天补零', () => {
    const rows = trendDays([rec('2026-10-01', 25, '数学'), rec('2026-10-03', 50, '英语')], '2026-10-03', 3);
    expect(rows.map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(rows.map((r) => r.minutes)).toEqual([25, 0, 50]);
  });

  it('趋势选「全部」时从最早记录铺到结束日', () => {
    const rows = trendDays([rec('2026-09-30', 10), rec('2026-10-02', 20)], '2026-10-02', 'all');
    expect(rows.map((r) => r.day)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('历史累计给出总时长、周期数与分科占比', () => {
    const s = overallSummary([rec('2026-10-01', 60, '数学'), rec('2026-10-02', 40, '英语'), rec('2026-10-02', 0)]);
    expect(s.totalMinutes).toBe(100);
    expect(s.totalSessions).toBe(2);
    expect(s.subjects).toEqual([
      { name: '数学', minutes: 60, pct: 60 },
      { name: '英语', minutes: 40, pct: 40 },
    ]);
  });

  it('科目配色按首次出现排定，互不撞色，未分类固定最后一槽', () => {
    const map = subjectColorMap([
      rec('2026-10-02', 25, '英语'),
      rec('2026-10-01', 25, '408'),
      rec('2026-10-03', 25, '408'),
      rec('2026-10-01', 25),
    ]);
    expect(map.get('408')).toBe(0);
    expect(map.get('英语')).toBe(1);
    expect(map.get(UNCATEGORIZED)).toBe(9);
    expect(new Set([...map.values()]).size).toBe(map.size);
  });

  it('时长格式化', () => {
    expect(fmtMinutes(0)).toBe('0m');
    expect(fmtMinutes(59)).toBe('59m');
    expect(fmtMinutes(60)).toBe('1h');
    expect(fmtMinutes(161)).toBe('2h41m');
  });

  it('每日一句话小结可写可读，空串即删除', () => {
    writeDayNote('2026-10-01', '  开始高数  ');
    expect(readDayNote('2026-10-01')).toBe('开始高数');
    expect(loadDayNotes()['2026-10-01']).toBe('开始高数');
    writeDayNote('2026-10-01', '   ');
    expect(readDayNote('2026-10-01')).toBe('');
    expect(localStorage.getItem(DAY_NOTES_KEY)).toBe('{}');
  });

  it('todayKey 是本地的 YYYY-MM-DD', () => {
    expect(todayKey(new Date(2026, 9, 5))).toBe('2026-10-05');
  });
});
