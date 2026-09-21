/**
 * 工作台 · 专注页：计时环 + 开始/暂停/重置/跳过 + 关联待办 + 今日累计 + 时长设置。
 *
 * 计时本身在 core/pomodoro.ts（按真实时间戳算，不漂移），这里只负责画和转发意图。
 * 「关联待办」是工作台的关键一环：每完成一个番茄，那条待办 +1 番茄数——
 * 投入是记出来的，不是估出来的。
 */
import { formatClock, PHASE_LABELS, type PomoStats, type PomodoroConfig, type PomodoroState } from '../core/pomodoro';
import type { Todo } from '../core/todos';
import { IconPause, IconPlay, IconTimer } from './icons';

const R = 86;
const C = 2 * Math.PI * R;

interface Props {
  state: PomodoroState;
  cfg: PomodoroConfig;
  remaining: number;
  progress: number;
  stats: PomoStats;
  todos: Todo[];
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onSkip: () => void;
  onPickTask: (id: string | null) => void;
  onChangeConfig: (patch: Partial<PomodoroConfig>) => void;
}

export default function TodoFocus({
  state, cfg, remaining, progress, stats, todos,
  onStart, onPause, onReset, onSkip, onPickTask, onChangeConfig,
}: Props) {
  const round = (state.focusDone % cfg.longEvery) + 1;
  const open = todos.filter((t) => !t.done);
  const linked = state.taskId ? todos.find((t) => t.id === state.taskId) ?? null : null;

  return (
    <div className="wb-focus">
      <div className="wb-focus__main">
        <div className={`wb-ring wb-ring--${state.phase}`} role="img" aria-label={`${PHASE_LABELS[state.phase]}剩余 ${formatClock(remaining)}`}>
          <svg viewBox="0 0 200 200" className="wb-ring__svg" aria-hidden="true">
            <circle className="wb-ring__track" cx="100" cy="100" r={R} />
            <circle
              className="wb-ring__fill"
              cx="100"
              cy="100"
              r={R}
              transform="rotate(-90 100 100)"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - Math.min(1, Math.max(0, progress)))}
            />
          </svg>
          <div className="wb-ring__center">
            <div className="wb-ring__phase">{PHASE_LABELS[state.phase]}</div>
            <div className="wb-ring__time">{formatClock(remaining)}</div>
            <div className="wb-ring__round">第 {round} / {cfg.longEvery} 个番茄</div>
          </div>
        </div>

        <div className="wb-focus__controls">
          {state.running ? (
            <button className="btn-small wb-btn-lg" onClick={onPause}>
              <IconPause /> 暂停
            </button>
          ) : (
            <button className="btn-small wb-btn-lg wb-btn-lg--primary" onClick={onStart}>
              <IconPlay /> {state.elapsedMs > 0 ? '继续' : '开始专注'}
            </button>
          )}
          <button className="btn-small" onClick={onReset} disabled={!state.running && state.elapsedMs === 0}>重置</button>
          <button className="btn-small" onClick={onSkip}>跳过</button>
        </div>
        <p className="muted wb-hint">空格 开始/暂停 · S 跳过 · 关掉面板也在计时（重开按真实时间接上）</p>
      </div>

      <aside className="wb-focus__side">
        <section className="wb-card">
          <h3 className="wb-card__title"><IconTimer size={14} /> 本次专注关联待办</h3>
          <select
            className="todo-select wb-select"
            aria-label="关联待办"
            value={state.taskId ?? ''}
            onChange={(e) => onPickTask(e.target.value || null)}
          >
            <option value="">不关联</option>
            {open.map((t) => (
              <option key={t.id} value={t.id}>
                {t.text}{t.pomos ? `（已有 ${t.pomos} 个番茄）` : ''}
              </option>
            ))}
          </select>
          {linked ? (
            <p className="muted wb-tip">
              已关联「{linked.text}」，当前 {linked.pomos ?? 0} 个番茄。完成一个番茄自动 +1。
            </p>
          ) : (
            <p className="muted wb-tip">选一条待办再开始：每完成一个番茄，它 +1 番茄数——投入是记出来的，不是估出来的。</p>
          )}
        </section>

        <section className="wb-card">
          <h3 className="wb-card__title">今日 / 累计</h3>
          <div className="wb-kv"><span>今日番茄</span><b>{stats.todayCount}</b></div>
          <div className="wb-kv"><span>今日专注</span><b>{stats.todayMinutes} 分钟</b></div>
          <div className="wb-kv"><span>累计番茄</span><b>{stats.totalCount}</b></div>
          <div className="wb-kv"><span>累计专注</span><b>{stats.totalMinutes} 分钟</b></div>
        </section>

        <section className="wb-card">
          <h3 className="wb-card__title">时长设置</h3>
          <label className="wb-field">
            专注
            <input type="number" min={1} max={180} aria-label="专注分钟" value={cfg.focusMin}
              onChange={(e) => onChangeConfig({ focusMin: Number(e.target.value) })} />
            分
          </label>
          <label className="wb-field">
            短休息
            <input type="number" min={1} max={60} aria-label="短休息分钟" value={cfg.shortMin}
              onChange={(e) => onChangeConfig({ shortMin: Number(e.target.value) })} />
            分
          </label>
          <label className="wb-field">
            长休息
            <input type="number" min={1} max={120} aria-label="长休息分钟" value={cfg.longMin}
              onChange={(e) => onChangeConfig({ longMin: Number(e.target.value) })} />
            分
          </label>
          <label className="wb-field">
            每
            <input type="number" min={1} max={12} aria-label="长休息间隔" value={cfg.longEvery}
              onChange={(e) => onChangeConfig({ longEvery: Number(e.target.value) })} />
            个番茄后长休息
          </label>
          <label className="wb-field wb-field--check">
            <input type="checkbox" aria-label="自动开始下一阶段" checked={cfg.autoStart}
              onChange={(e) => onChangeConfig({ autoStart: e.target.checked })} />
            自动开始下一阶段
          </label>
        </section>
      </aside>
    </div>
  );
}
