/**
 * 学习日历：把番茄记录按「天 × 科目」铺开，供月历与历史汇总使用。
 *
 * 口径与 pomodoro 一致：一条记录在**完成那一刻**所在的那天，minutes 是计划时长。
 * 旧记录没有 subject 字段，一律归入「未分类」，不丢数据。
 *
 * 纯函数为主，存储只碰两个键（每日一句话小结；记录本身仍归 core/pomodoro）。
 */
import type { PomodoroRecord } from './pomodoro';
import { dayKey } from './dateKey';

export const UNCATEGORIZED = '未分类';
/** 每日一句话小结（YYYY-MM-DD → 文本），已登记在 storage/kv.ts 的 KV_KEYS */
export const DAY_NOTES_KEY = 'knowlattice-day-notes';
const NOTE_MAX = 120;

export interface SubjectSlice {
  name: string;
  minutes: number;
}

export interface DayStat {
  day: string;
  minutes: number;
  sessions: number;
  subjects: SubjectSlice[];
}

export interface CalendarCell {
  day: string;
  dayNum: number;
  inMonth: boolean;
  /** 还没到的日子：画成空环，不参与「今日」之后的统计 */
  future: boolean;
  minutes: number;
  sessions: number;
  subjects: SubjectSlice[];
}

export function dayKeyOf(d: Date): string {
  return dayKey(d);
}

export function todayKey(now = new Date()): string {
  return dayKey(now);
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return dayKeyOf(d);
}

export function subjectOf(r: PomodoroRecord): string {
  const name = typeof r.subject === 'string' ? r.subject.trim() : '';
  return name || UNCATEGORIZED;
}

/** 按天汇总；科目按分钟数降序 */
export function dailyStats(records: readonly PomodoroRecord[]): Map<string, DayStat> {
  const acc = new Map<string, { minutes: number; sessions: number; subjects: Map<string, number> }>();
  for (const r of records) {
    if (!r || !Number.isFinite(r.minutes) || r.minutes <= 0) continue;
    const cur = acc.get(r.day) ?? { minutes: 0, sessions: 0, subjects: new Map<string, number>() };
    cur.minutes += r.minutes;
    cur.sessions += 1;
    const s = subjectOf(r);
    cur.subjects.set(s, (cur.subjects.get(s) ?? 0) + r.minutes);
    acc.set(r.day, cur);
  }
  const out = new Map<string, DayStat>();
  for (const [day, v] of acc) {
    out.set(day, {
      day,
      minutes: v.minutes,
      sessions: v.sessions,
      subjects: [...v.subjects.entries()]
        .map(([name, minutes]) => ({ name, minutes }))
        .sort((a, b) => b.minutes - a.minutes),
    });
  }
  return out;
}

/**
 * 月历格子：固定 6 行 × 7 列，周一起始。
 * month 用 1–12（和 Date 的 0–11 不同，调用处少一次 ±1）。
 */
export function monthCells(
  year: number,
  month: number,
  records: readonly PomodoroRecord[],
  today: string,
): CalendarCell[] {
  const stats = dailyStats(records);
  const first = new Date(year, month - 1, 1);
  // getDay(): 0=周日 → 周一起始的偏移
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - offset);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = dayKeyOf(d);
    const s = stats.get(day);
    cells.push({
      day,
      dayNum: d.getDate(),
      inMonth: d.getMonth() === month - 1,
      future: day > today,
      minutes: s?.minutes ?? 0,
      sessions: s?.sessions ?? 0,
      subjects: s?.subjects ?? [],
    });
  }
  return cells;
}

/** 趋势：days 为数字时取截至 endDay 的最近 N 天；'all' 从最早记录铺到今天 */
export function trendDays(
  records: readonly PomodoroRecord[],
  endDay: string,
  days: number | 'all',
): Array<{ day: string; minutes: number }> {
  const stats = dailyStats(records);
  let start: string;
  if (days === 'all') {
    const earliest = records.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
    start = earliest && earliest < endDay ? earliest : endDay;
  } else {
    start = addDays(endDay, -(Math.max(1, days) - 1));
  }
  const out: Array<{ day: string; minutes: number }> = [];
  for (let d = start; d <= endDay; d = addDays(d, 1)) {
    out.push({ day: d, minutes: stats.get(d)?.minutes ?? 0 });
  }
  return out;
}

export interface OverallSummary {
  totalMinutes: number;
  totalSessions: number;
  subjects: Array<SubjectSlice & { pct: number }>;
}

/** 历史累计：总时长、总周期数、分科占比（%） */
export function overallSummary(records: readonly PomodoroRecord[]): OverallSummary {
  let totalMinutes = 0;
  let totalSessions = 0;
  const bySubject = new Map<string, number>();
  for (const r of records) {
    if (!r || !Number.isFinite(r.minutes) || r.minutes <= 0) continue;
    totalMinutes += r.minutes;
    totalSessions += 1;
    const s = subjectOf(r);
    bySubject.set(s, (bySubject.get(s) ?? 0) + r.minutes);
  }
  const subjects = [...bySubject.entries()]
    .map(([name, minutes]) => ({
      name,
      minutes,
      pct: totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);
  return { totalMinutes, totalSessions, subjects };
}

/** 配色槽总数：0–8 给科目，9 固定给「未分类」 */
export const SUBJECT_SLOTS = 10;

/**
 * 科目 → 配色槽。按「第一次出现的日期、再按名字」排定顺序，最多前 9 个科目各占一槽。
 * 顺序只由历史决定：以后新增记录不会让已有科目换色；新科目排在末尾。
 * 用固定顺序而不是名字哈希，是为了避免 408/英语 这类名字撞到同一个颜色。
 */
export function subjectColorMap(records: readonly PomodoroRecord[]): Map<string, number> {
  const first = new Map<string, string>();
  for (const r of records) {
    if (!r || !Number.isFinite(r.minutes) || r.minutes <= 0) continue;
    const s = subjectOf(r);
    if (s === UNCATEGORIZED) continue;
    const prev = first.get(s);
    if (!prev || r.day < prev) first.set(s, r.day);
  }
  const names = [...first.entries()]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1])))
    .map(([name]) => name)
    .slice(0, SUBJECT_SLOTS - 1);
  const map = new Map<string, number>();
  names.forEach((name, i) => map.set(name, i));
  map.set(UNCATEGORIZED, SUBJECT_SLOTS - 1);
  return map;
}

/**
 * 专注时长 → 热力档位：0 无记录 / 1 ≤25 分钟 / 2 ≤60 分钟 / 3 更多。
 * 25 分钟与番茄钟默认周期同口径；返回值直接写进 data-level，颜色只在 CSS 里定义。
 */
export function heatLevel(minutes: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  if (minutes <= 25) return 1;
  if (minutes <= 60) return 2;
  return 3;
}

/** 分钟 → 「2h41m」；不足 1 小时只显示分钟 */
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h${rest}m` : `${h}h`;
}

export function loadDayNotes(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DAY_NOTES_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, NOTE_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

export function readDayNote(day: string): string {
  return loadDayNotes()[day] ?? '';
}

export function writeDayNote(day: string, text: string): Record<string, string> {
  const all = loadDayNotes();
  const next = text.trim().slice(0, NOTE_MAX);
  if (next) all[day] = next;
  else delete all[day];
  try {
    localStorage.setItem(DAY_NOTES_KEY, JSON.stringify(all));
  } catch {
    // 存储满了就只影响这一句小结，别把面板打崩
  }
  return all;
}

export function monthLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

/** 备份用：每日小结是「日期 → 一句话」，原样导出。 */
export function exportDayNotes(): Record<string, string> {
  return loadDayNotes();
}

/** 恢复用：只补不覆盖，已有日期的内容保留本地。 */
export function importDayNotes(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const current = loadDayNotes();
  const next = { ...current };
  let added = 0;
  let kept = 0;
  for (const [day, text] of Object.entries(incoming as Record<string, unknown>)) {
    if (typeof text !== 'string' || !text.trim()) continue;
    if (Object.prototype.hasOwnProperty.call(current, day)) {
      kept += 1;
      continue;
    }
    next[day] = text.trim().slice(0, NOTE_MAX);
    added += 1;
  }
  if (added > 0) {
    try {
      localStorage.setItem(DAY_NOTES_KEY, JSON.stringify(next));
    } catch {
      return { added: 0, kept };
    }
  }
  return { added, kept };
}
