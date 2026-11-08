/**
 * 学习日历（嵌入视图）：月历（每日专注时长 + 按科目分段的圆环 + 一句话小结）与历史汇总
 * （累计时长、周期数、趋势柱、分科占比）。
 *
 * 它不再是独立面板：没有遮罩、不注册 Esc，由「学习报告」页（Dashboard）直接渲染。
 * 首页工作台只放得下当前月份的紧凑月历（StudyCalendarCard）；月份切换、当天小结与
 * 历史汇总这些「放不下」的部分都在这里。
 *
 * 数据只来自番茄记录（core/pomodoro），科目缺失归「未分类」；
 * 小结是唯一在视图里可编辑的文本，持久化仍走 core/studyCalendar 的 writeDayNote。
 */
import { useMemo, useState } from 'react';
import { loadRecords } from '../core/pomodoro';
import {
  fmtMinutes,
  heatLevel,
  loadDayNotes,
  monthCells,
  monthLabel,
  overallSummary,
  subjectColorMap,
  todayKey,
  trendDays,
  writeDayNote,
} from '../core/studyCalendar';
import CalendarRing from './CalendarRing';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
type Tab = 'calendar' | 'summary';
type Range = 7 | 30 | 90 | 'all';

export default function StudyCalendarView() {
  const today = todayKey();
  const [records] = useState(() => loadRecords());
  const [tab, setTab] = useState<Tab>('calendar');
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  });
  const [selected, setSelected] = useState(today);
  const [notes, setNotes] = useState<Record<string, string>>(() => loadDayNotes());
  const [draft, setDraft] = useState(() => loadDayNotes()[today] ?? '');
  const [range, setRange] = useState<Range>(30);

  const cells = useMemo(
    () => monthCells(cursor.y, cursor.m, records, today),
    [cursor.y, cursor.m, records, today],
  );
  const summary = useMemo(() => overallSummary(records), [records]);
  const colorMap = useMemo(() => subjectColorMap(records), [records]);
  const slotOf = (name: string) => colorMap.get(name) ?? 9;
  const trend = useMemo(() => trendDays(records, today, range), [records, range, today]);
  const trendMax = Math.max(1, ...trend.map((t) => t.minutes));
  const selectedStat = cells.find((c) => c.day === selected);
  const selectedTotal = records
    .filter((r) => r.day === selected)
    .reduce((a, r) => a + r.minutes, 0);

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c.y, c.m - 1 + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    });
  };

  const pickDay = (day: string) => {
    setSelected(day);
    setDraft(notes[day] ?? '');
  };

  const saveNote = () => {
    setNotes(writeDayNote(selected, draft));
  };

  return (
    <section className="sc-embed" data-reveal aria-label="学习日历">
      <div className="sc-embed__head">
        <h4>学习日历</h4>
        <div className="sc-tabs" role="group" aria-label="视图">
          <button type="button" className="btn btn-small" aria-pressed={tab === 'calendar'} onClick={() => setTab('calendar')}>
            日历
          </button>
          <button type="button" className="btn btn-small" aria-pressed={tab === 'summary'} onClick={() => setTab('summary')}>
            汇总
          </button>
        </div>
        <span className="sc-head__meta">
          {records.length ? `累计 ${fmtMinutes(summary.totalMinutes)} · ${summary.totalSessions} 个专注周期` : '还没有番茄记录'}
        </span>
      </div>

      {tab === 'calendar' ? (
        <div className="sc-body sc-body--embed">
          <div className="sc-toolbar">
            <button className="btn btn-small" type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">
              ‹
            </button>
            <b className="sc-month">{monthLabel(cursor.y, cursor.m)}</b>
            <button className="btn btn-small" type="button" onClick={() => shiftMonth(1)} aria-label="下个月">
              ›
            </button>
            <button
              className="btn btn-small"
              type="button"
              onClick={() => {
                const d = new Date();
                setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
                pickDay(today);
              }}
            >
              本月
            </button>
          </div>

          <div className="sc-week">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>

          <div className="sc-grid">
            {cells.map((c) => (
              <button
                key={c.day}
                type="button"
                className="sc-cell"
                data-out={!c.inMonth || undefined}
                data-future={c.future || undefined}
                data-sel={c.day === selected || undefined}
                data-level={heatLevel(c.minutes)}
                aria-label={`${c.day}${c.minutes ? `，专注 ${fmtMinutes(c.minutes)}` : ''}`}
                onClick={() => pickDay(c.day)}
              >
                <span className="sc-day">{c.dayNum}</span>
                <CalendarRing subjects={c.subjects} future={c.future} slot={slotOf} />
                <span className="sc-mins">{c.minutes ? fmtMinutes(c.minutes) : ''}</span>
                <span className="sc-note">{notes[c.day] || ''}</span>
              </button>
            ))}
          </div>

          <section className="sc-editor" aria-label="当天记录">
            <div className="sc-editor__head">
              <b>{selected}</b>
              <span className="sc-editor__total">
                {selectedTotal ? `专注 ${fmtMinutes(selectedTotal)}` : '这一天还没有专注记录'}
              </span>
              {selectedStat?.subjects.length ? (
                <span className="sc-editor__subs">
                  {selectedStat.subjects.map((s) => (
                    <span key={s.name} className="sc-chip">
                      <i style={{ background: `var(--sc-slot-${slotOf(s.name)})` }} />
                      {s.name} {fmtMinutes(s.minutes)}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
            <div className="sc-editor__row">
              <input
                className="sc-input"
                aria-label="当天一句话小结"
                maxLength={120}
                placeholder="写一句小结：今天学了什么、卡在哪"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={saveNote}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveNote();
                }}
              />
              <button className="btn btn-small" type="button" onClick={saveNote}>
                保存
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className="sc-body sc-summary sc-body--embed">
          <section className="sc-stat">
            <div className="sc-stat__main">
              <span className="sc-stat__label">累计专注</span>
              <b>{fmtMinutes(summary.totalMinutes)}</b>
              <span className="sc-stat__sub">共 {summary.totalSessions} 个番茄</span>
            </div>
            {summary.subjects.length > 1 && (
              <svg className="sc-donut" viewBox="0 0 120 120" aria-label="分科占比">
                <circle className="sc-ring__track" cx="60" cy="60" r="44" strokeWidth="14" />
                {(() => {
                  let acc = 0;
                  return summary.subjects.map((s) => {
                    const len = (s.pct / 100) * (2 * Math.PI * 44);
                    const offset = -acc;
                    acc += len;
                    return (
                      <circle
                        key={s.name}
                        className="sc-ring__seg"
                        cx="60"
                        cy="60"
                        r="44"
                        strokeWidth="14"
                        transform="rotate(-90 60 60)"
                        style={{
                          stroke: `var(--sc-slot-${slotOf(s.name)})`,
                          strokeDasharray: `${len} ${2 * Math.PI * 44 - len}`,
                          strokeDashoffset: offset,
                        }}
                      />
                    );
                  });
                })()}
              </svg>
            )}
            <ul className="sc-subj">
              {summary.subjects.length === 0 && <li className="sc-empty">还没有记录：去「工作台 → 专注」跑完一轮番茄。</li>}
              {summary.subjects.map((s) => (
                <li key={s.name}>
                  <i style={{ background: `var(--sc-slot-${slotOf(s.name)})` }} />
                  <span className="sc-subj__name">{s.name}</span>
                  <span className="sc-subj__min">{fmtMinutes(s.minutes)}</span>
                  <span className="sc-subj__pct">{s.pct}%</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="sc-trend">
            <div className="sc-trend__head">
              <b>专注趋势</b>
              <div className="sc-ranges" role="group" aria-label="时间范围">
                {([7, 30, 90, 'all'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="btn btn-small"
                    aria-pressed={range === r}
                    onClick={() => setRange(r)}
                  >
                    {r === 'all' ? '全部' : `近 ${r} 天`}
                  </button>
                ))}
              </div>
            </div>
            <div className="sc-bars" role="img" aria-label="每日专注时长">
              {trend.map((t) => (
                <span
                  key={t.day}
                  className="sc-bar"
                  data-zero={t.minutes === 0 || undefined}
                  title={`${t.day}：${t.minutes ? fmtMinutes(t.minutes) : '无记录'}`}
                  style={{ height: `${t.minutes ? Math.max(4, (t.minutes / trendMax) * 100) : 2}%` }}
                />
              ))}
            </div>
            <div className="sc-bars__foot">
              <span>{trend[0]?.day}</span>
              <span>{trend[trend.length - 1]?.day}</span>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
