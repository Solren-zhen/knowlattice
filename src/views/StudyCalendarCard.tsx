/**
 * 首页工作台的「学习日历」卡：当前月份的紧凑月历（每日分科圆环 + 分钟数）。
 *
 * 只看不改：月份切换、当天小结编辑与历史汇总都放在「学习报告」页里（StudyCalendarView）——
 * 首页这块只回答「这个月哪天学了、学了多久」。数据与配色跟报告页共用 core/studyCalendar。
 */
import { useMemo, useState } from 'react';
import { loadRecords } from '../core/pomodoro';
import { fmtMinutes, heatLevel, monthCells, monthLabel, subjectColorMap, todayKey } from '../core/studyCalendar';
import CalendarRing from './CalendarRing';
import { IconCalendar } from './icons';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export default function StudyCalendarCard({ onOpenReport }: { onOpenReport?: () => void }) {
  const today = todayKey();
  const [records] = useState(() => loadRecords());
  const [now] = useState(() => new Date());
  const y = now.getFullYear();
  const m = now.getMonth() + 1;

  const cells = useMemo(() => monthCells(y, m, records, today), [y, m, records, today]);
  /** 只保留本月占用的整周：monthCells 固定给 6 行，月末那两行常是全空的外月 */
  const visible = useMemo(() => {
    const first = cells.findIndex((c) => c.inMonth);
    if (first < 0) return cells;
    let last = cells.length - 1;
    while (last >= 0 && !cells[last].inMonth) last--;
    return cells.slice(Math.floor(first / 7) * 7, Math.ceil((last + 1) / 7) * 7);
  }, [cells]);

  const colorMap = useMemo(() => subjectColorMap(records), [records]);
  const slotOf = (name: string) => colorMap.get(name) ?? 9;
  const monthTotal = visible.filter((c) => c.inMonth).reduce((a, c) => a + c.minutes, 0);
  const todayTotal = visible.find((c) => c.day === today)?.minutes ?? 0;
  /** 本月各科目累计时长（降序）：图例让圆环的颜色有名字，最多列 8 个 */
  const monthSubjects = useMemo(() => {
    const acc = new Map<string, number>();
    for (const c of visible) {
      if (!c.inMonth) continue;
      for (const s of c.subjects) acc.set(s.name, (acc.get(s.name) ?? 0) + s.minutes);
    }
    return [...acc.entries()]
      .map(([name, minutes]) => ({ name, minutes }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 8);
  }, [visible]);

  return (
    <section className="home-wb__card home-cal" aria-label="学习日历">
      <div className="home-wb__head">
        <span className="home-wb__title"><IconCalendar size={14} /> 学习日历</span>
        {onOpenReport && (
          <button
            type="button"
            className="home-wb__link"
            aria-label="在学习报告中查看完整日历"
            onClick={onOpenReport}
          >
            完整日历
          </button>
        )}
      </div>
      <div className="home-cal__meta">
        <b>{monthLabel(y, m)}</b>
        <span>{monthTotal ? `本月 ${fmtMinutes(monthTotal)}` : '本月还没有专注记录'}</span>
        {todayTotal > 0 && <span>今日 {fmtMinutes(todayTotal)}</span>}
      </div>
      <div className="home-cal__week" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="home-cal__grid" role="list" aria-label={`${monthLabel(y, m)}专注记录`}>
        {visible.map((c) => {
          const perSubject = c.subjects.map((s) => `${s.name} ${fmtMinutes(s.minutes)}`).join('、');
          return (
            <div
              key={c.day}
              role="listitem"
              className="home-cal__cell"
              data-out={!c.inMonth || undefined}
              data-future={c.future || undefined}
              data-today={c.day === today || undefined}
              data-level={heatLevel(c.minutes)}
              title={`${c.day}：${c.minutes ? `专注 ${fmtMinutes(c.minutes)}${perSubject ? `（${perSubject}）` : ''}` : '无记录'}`}
              aria-label={`${c.day}${c.minutes ? `，专注 ${fmtMinutes(c.minutes)}${perSubject ? `，${perSubject}` : ''}` : '，无记录'}`}
            >
              <span className="home-cal__day">{c.dayNum}</span>
              <CalendarRing subjects={c.subjects} future={c.future} slot={slotOf} />
              <span className="home-cal__mins">{c.minutes ? fmtMinutes(c.minutes) : ''}</span>
            </div>
          );
        })}
      </div>
      {monthSubjects.length > 0 && (
        <div className="home-cal__legend" aria-label="本月科目图例">
          {monthSubjects.map((s) => (
            <span key={s.name} className="home-cal__legend-item" title={`${s.name}：本月 ${fmtMinutes(s.minutes)}`}>
              <i style={{ background: `var(--sc-slot-${slotOf(s.name)})` }} aria-hidden="true" />
              <span className="home-cal__legend-name">{s.name}</span>
              <b>{fmtMinutes(s.minutes)}</b>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
