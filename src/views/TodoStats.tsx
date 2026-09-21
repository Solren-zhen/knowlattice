/**
 * 工作台 · 统计页：番茄总览 + 近 7 天专注趋势 + 待办完成率 + 学习打卡热力图。
 *
 * 打卡数据来自 core/stats（复习评卡、题库作答自动记一次），所以这里**不做**手动习惯打卡——
 * 那会变成第二套并行数据，两边的「连续天数」迟早对不上。热力图画的也是这份真实学习记录。
 */
import type { PomoStats } from '../core/pomodoro';
import type { HeatCell } from '../core/stats';

interface Props {
  stats: PomoStats;
  trend: Array<{ day: string; count: number; minutes: number }>;
  heat: HeatCell[][];
  todos: { done: number; total: number; overdue: number };
  study: { streak: number; days: number };
}

const HEAT_LABELS = ['0', '1', '2', '3', '4+'];

export default function TodoStats({ stats, trend, heat, todos, study }: Props) {
  const max = Math.max(1, ...trend.map((d) => d.count));
  const rate = todos.total > 0 ? Math.round((todos.done / todos.total) * 100) : 0;

  return (
    <div className="wb-stats">
      <div className="wb-cards">
        <div className="wb-stat"><span>今日番茄</span><b>{stats.todayCount}</b></div>
        <div className="wb-stat"><span>今日专注</span><b>{stats.todayMinutes}<i>分钟</i></b></div>
        <div className="wb-stat"><span>累计番茄</span><b>{stats.totalCount}</b></div>
        <div className="wb-stat"><span>累计专注</span><b>{stats.totalMinutes}<i>分钟</i></b></div>
      </div>

      <section className="wb-card">
        <h3 className="wb-card__title">近 7 天专注趋势</h3>
        <div className="wb-trend">
          {trend.map((d) => (
            <div className="wb-trend__item" key={d.day} title={`${d.day}：${d.count} 个番茄 · ${d.minutes} 分钟`}>
              <span className="wb-trend__num">{d.count || ''}</span>
              <div className="wb-trend__barwrap">
                <div className="wb-trend__bar" style={{ height: `${(d.count / max) * 100}%` }} />
              </div>
              <span className="wb-trend__day">{d.day.slice(5)}</span>
            </div>
          ))}
        </div>
        <p className="muted wb-tip">共 {trend.reduce((n, d) => n + d.count, 0)} 个番茄 · {trend.reduce((n, d) => n + d.minutes, 0)} 分钟。</p>
      </section>

      <section className="wb-card">
        <h3 className="wb-card__title">待办完成率</h3>
        <div className="wb-rate">
          <div className="todo-progress"><span className="todo-progress-bar" style={{ width: `${rate}%` }} /></div>
          <b>{rate}%</b>
        </div>
        <p className="muted wb-tip">
          已完成 {todos.done} / {todos.total} 条{todos.overdue > 0 ? ` · 逾期 ${todos.overdue} 条` : ''}。
        </p>
      </section>

      <section className="wb-card">
        <h3 className="wb-card__title">学习打卡（复习评卡 / 题库作答自动记）</h3>
        <div className="wb-cards wb-cards--tight">
          <div className="wb-stat"><span>连续打卡</span><b>{study.streak}<i>天</i></b></div>
          <div className="wb-stat"><span>累计打卡</span><b>{study.days}<i>天</i></b></div>
        </div>
        <div className="wb-heat" role="img" aria-label={`近 ${heat.length} 周打卡热力图`}>
          {heat.map((col) => (
            <div className="wb-heat__col" key={col[0].day}>
              {col.map((c) => (
                <span
                  key={c.day}
                  className={`wb-heat__cell wb-heat__cell--${c.future ? 'future' : Math.min(4, c.count)}`}
                  title={`${c.day}：${c.future ? '还没到' : `${c.count} 次学习`}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="wb-heat__legend">
          <span className="muted">少</span>
          {HEAT_LABELS.map((l, i) => <span key={l} className={`wb-heat__cell wb-heat__cell--${i}`} title={`${l} 次`} />)}
          <span className="muted">多</span>
        </div>
      </section>
    </div>
  );
}
