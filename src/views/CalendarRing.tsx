/**
 * 一天的分科圆环：按分钟占比分段；没记录时只留灰轨。
 *
 * 学习日历的两处入口共用它——首页工作台的紧凑月历（StudyCalendarCard）与
 * 「学习报告」里的完整月历（StudyCalendarView）——避免同一条圆环画两遍。
 */
import type { SubjectSlice } from '../core/studyCalendar';

const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

export default function CalendarRing({
  subjects,
  future,
  slot,
}: {
  subjects: readonly SubjectSlice[];
  /** 还没到的日子：只画灰轨，不参与统计 */
  future?: boolean;
  /** 科目 → 配色槽 */
  slot: (name: string) => number;
}) {
  const total = subjects.reduce((a, s) => a + s.minutes, 0);
  let acc = 0;
  return (
    <svg className="sc-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="sc-ring__track" cx="18" cy="18" r={RING_R} />
      {!future && total > 0 &&
        subjects.map((s) => {
          const len = (s.minutes / total) * RING_C;
          const dash = `${len} ${RING_C - len}`;
          const offset = -acc;
          acc += len;
          return (
            <circle
              key={s.name}
              className="sc-ring__seg"
              cx="18"
              cy="18"
              r={RING_R}
              style={{ stroke: `var(--sc-slot-${slot(s.name)})`, strokeDasharray: dash, strokeDashoffset: offset }}
            />
          );
        })}
    </svg>
  );
}
