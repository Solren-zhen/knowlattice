/**
 * 番茄钟（Pomodoro）：专注 25 分钟 → 短休息 5 分钟 → 每 4 个专注后长休息 15 分钟。
 *
 * 计时**按真实时间戳算**（now − startedAt + 已累计），不靠 setInterval 累加毫秒：
 * 累加式在标签页被挂起、系统休眠、渲染卡顿时都会漂移，25 分钟能差出几十秒。
 * 这里任何时刻的剩余时间都是「本段计划时长 − (已累计 + 本次已跑)」，所以怎么卡都不漂。
 *
 * 状态与记录都存 localStorage：关掉面板、刷新页面后倒计时继续走（重开时按时间戳重算）。
 * 一次专注完成的记录里 minutes 记的是**计划时长**，不是实际墙钟时间——把暂停时长算进
 * 「专注了多少分钟」是自欺欺人。
 *
 * 两条记账口径（刻意的，不是随手定的）：
 *   - 一条番茄记在**完成那一刻**所在的那一天：23:50 开始、00:15 跑完，算第二天——
 *     和本应用打卡（评卡/作答按当下记）保持一致，统计页的趋势与连续天数才对得上；
 *   - 记录里的 endedAt 是**真正跑完的时刻**（startedAt + 计划时长 − 暂停前已跑），
 *     不是「你重开面板的那一刻」，所以关着面板跨天再打开也不会记错日子。
 */
import { dayKey } from './todos';

const STATE_KEY = 'knowlattice-pomodoro';
const RECORDS_KEY = 'knowlattice-pomodoros';

export type PomodoroPhase = 'focus' | 'short' | 'long';

export interface PomodoroConfig {
  focusMin: number;
  shortMin: number;
  longMin: number;
  /** 每几个专注后进入长休息 */
  longEvery: number;
  /** 一个阶段结束后自动进入下一阶段 */
  autoStart: boolean;
}

export const DEFAULT_CONFIG: PomodoroConfig = {
  focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, autoStart: true,
};

export const PHASE_LABELS: Record<PomodoroPhase, string> = {
  focus: '专注', short: '短休息', long: '长休息',
};

export interface PomodoroState {
  phase: PomodoroPhase;
  running: boolean;
  /** 本段开始的时间戳；暂停时为 null */
  startedAt: number | null;
  /** 暂停前累计的毫秒 */
  elapsedMs: number;
  /** 已完成的专注个数（决定什么时候长休息） */
  focusDone: number;
  /** 本次专注关联的待办 */
  taskId: string | null;
}

export interface PomodoroRecord {
  id: string;
  /** 完成那天（本地时区 YYYY-MM-DD） */
  day: string;
  endedAt: number;
  minutes: number;
  taskId?: string;
}

export function defaultState(taskId: string | null = null): PomodoroState {
  return { phase: 'focus', running: false, startedAt: null, elapsedMs: 0, focusDone: 0, taskId };
}

/** 计划时长（毫秒） */
export function phaseMs(phase: PomodoroPhase, cfg: PomodoroConfig): number {
  const min = phase === 'focus' ? cfg.focusMin : phase === 'short' ? cfg.shortMin : cfg.longMin;
  return Math.max(1, min) * 60_000;
}

/** 本段已跑毫秒：暂停累计 + 本次运行（运行中才加） */
export function elapsedMs(state: PomodoroState, now: number): number {
  const live = state.running && state.startedAt !== null ? Math.max(0, now - state.startedAt) : 0;
  return state.elapsedMs + live;
}

export function remainingMs(state: PomodoroState, cfg: PomodoroConfig, now: number): number {
  return Math.max(0, phaseMs(state.phase, cfg) - elapsedMs(state, now));
}

/** 进度 0~1（给计时环用） */
export function progressOf(state: PomodoroState, cfg: PomodoroConfig, now: number): number {
  return Math.min(1, elapsedMs(state, now) / phaseMs(state.phase, cfg));
}

export function start(state: PomodoroState, now: number): PomodoroState {
  if (state.running) return state;
  return { ...state, running: true, startedAt: now };
}

export function pause(state: PomodoroState, now: number): PomodoroState {
  if (!state.running) return state;
  return { ...state, running: false, startedAt: null, elapsedMs: elapsedMs(state, now) };
}

/** 重置当前这一段（阶段不变） */
export function reset(state: PomodoroState): PomodoroState {
  return { ...state, running: false, startedAt: null, elapsedMs: 0 };
}

/** 下一个阶段：专注之后看节奏给短/长休息，休息之后一律回专注 */
export function nextPhase(state: PomodoroState, cfg: PomodoroConfig): PomodoroPhase {
  if (state.phase !== 'focus') return 'focus';
  const done = state.focusDone + 1;
  return done % Math.max(1, cfg.longEvery) === 0 ? 'long' : 'short';
}

function enter(state: PomodoroState, cfg: PomodoroConfig, phase: PomodoroPhase, now: number): PomodoroState {
  return {
    ...state,
    phase,
    running: cfg.autoStart,
    startedAt: cfg.autoStart ? now : null,
    elapsedMs: 0,
  };
}

/** 跳过当前阶段（跳过专注**不**记一个番茄——没做完就是没做完） */
export function skip(state: PomodoroState, cfg: PomodoroConfig, now: number): PomodoroState {
  return enter(state, cfg, nextPhase(state, cfg), now);
}

export interface TickResult {
  state: PomodoroState;
  /** 这一段是不是刚好走完了 */
  finished: boolean;
  /** 走完的若是一个专注，这里给出要落库的记录 */
  record?: PomodoroRecord;
}

/**
 * 推进到 now。没跑完原样返回；跑完了进入下一阶段，专注阶段额外产出一条记录。
 * 只前进一个阶段：面板关了两小时再打开，不会把中间那几段凭空补出来。
 */
export function tick(state: PomodoroState, cfg: PomodoroConfig, now: number, id = newPomoId()): TickResult {
  if (!state.running || remainingMs(state, cfg, now) > 0) return { state, finished: false };
  const wasFocus = state.phase === 'focus';
  const next: PomodoroState = {
    ...enter(state, cfg, nextPhase(state, cfg), now),
    focusDone: wasFocus ? state.focusDone + 1 : state.focusDone,
  };
  if (!wasFocus) return { state: next, finished: true };
  return {
    state: next,
    finished: true,
    record: {
      id,
      // 记**真正跑完的那一刻**：面板关着两小时再打开，记录也要落在当时的时间线上
      day: dayKey(new Date(endedAtOf(state, cfg, now))),
      endedAt: endedAtOf(state, cfg, now),
      minutes: Math.max(1, cfg.focusMin),
      ...(state.taskId ? { taskId: state.taskId } : {}),
    },
  };
}

/** 这一段的逻辑结束时刻（开始时刻 + 计划时长 − 暂停前的已跑）；没在跑就用 now */
export function endedAtOf(state: PomodoroState, cfg: PomodoroConfig, now: number): number {
  if (state.startedAt === null) return now;
  return state.startedAt + (phaseMs(state.phase, cfg) - state.elapsedMs);
}

export function newPomoId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 毫秒 → `mm:ss`，向上取整：还剩 0.4 秒也显示 00:01，
 * 免得最后一秒先跳到 00:00 再跳阶段，看着像卡住。
 */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 配置清洗：坏数据不能让计时器变成 0 分钟或者每 0 个专注就长休息 */
export function sanitizeConfig(raw: unknown): PomodoroConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  return {
    focusMin: num(o.focusMin, 1, 180, DEFAULT_CONFIG.focusMin),
    shortMin: num(o.shortMin, 1, 60, DEFAULT_CONFIG.shortMin),
    longMin: num(o.longMin, 1, 120, DEFAULT_CONFIG.longMin),
    longEvery: num(o.longEvery, 1, 12, DEFAULT_CONFIG.longEvery),
    autoStart: typeof o.autoStart === 'boolean' ? o.autoStart : DEFAULT_CONFIG.autoStart,
  };
}

// ---------- 存储 ----------

export function loadConfig(): PomodoroConfig {
  try {
    return sanitizeConfig(JSON.parse(localStorage.getItem(`${STATE_KEY}-config`) ?? '{}'));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: PomodoroConfig) {
  localStorage.setItem(`${STATE_KEY}-config`, JSON.stringify(cfg));
}

export function loadState(): PomodoroState {
  try {
    const o = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<PomodoroState> | null;
    if (!o || typeof o !== 'object') return defaultState();
    const phase: PomodoroPhase = o.phase === 'short' || o.phase === 'long' ? o.phase : 'focus';
    return {
      phase,
      running: o.running === true,
      startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
      elapsedMs: typeof o.elapsedMs === 'number' && Number.isFinite(o.elapsedMs) && o.elapsedMs > 0 ? o.elapsedMs : 0,
      focusDone: typeof o.focusDone === 'number' && Number.isFinite(o.focusDone) && o.focusDone > 0 ? Math.floor(o.focusDone) : 0,
      taskId: typeof o.taskId === 'string' ? o.taskId : null,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: PomodoroState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function sanitizeRecords(raw: unknown): PomodoroRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PomodoroRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.endedAt !== 'number' || !Number.isFinite(o.endedAt)) continue;
    if (typeof o.minutes !== 'number' || !Number.isFinite(o.minutes) || o.minutes <= 0) continue;
    out.push({
      id: o.id,
      day: typeof o.day === 'string' ? o.day : dayKey(new Date(o.endedAt)),
      endedAt: o.endedAt,
      minutes: o.minutes,
      ...(typeof o.taskId === 'string' && o.taskId ? { taskId: o.taskId } : {}),
    });
  }
  return out;
}

export function loadRecords(): PomodoroRecord[] {
  try {
    return sanitizeRecords(JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function saveRecords(list: PomodoroRecord[]) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(list));
}

/** 追加一条专注记录，返回新的完整列表（不可变） */
export function addRecord(list: PomodoroRecord[], rec: PomodoroRecord): PomodoroRecord[] {
  const next = [...list, rec];
  saveRecords(next);
  return next;
}

export interface PomoStats {
  todayCount: number;
  todayMinutes: number;
  totalCount: number;
  totalMinutes: number;
}

export function pomoStats(records: PomodoroRecord[], today: string): PomoStats {
  let todayCount = 0;
  let todayMinutes = 0;
  let totalMinutes = 0;
  for (const r of records) {
    totalMinutes += r.minutes;
    if (r.day === today) {
      todayCount++;
      todayMinutes += r.minutes;
    }
  }
  return { todayCount, todayMinutes, totalCount: records.length, totalMinutes };
}

/** 近 N 天每天完成的番茄数（含今天，末尾是今天） */
export function pomoTrend(records: PomodoroRecord[], today: string, days = 7): Array<{ day: string; count: number; minutes: number }> {
  const byDay = new Map<string, { count: number; minutes: number }>();
  for (const r of records) {
    const cur = byDay.get(r.day) ?? { count: 0, minutes: 0 };
    byDay.set(r.day, { count: cur.count + 1, minutes: cur.minutes + r.minutes });
  }
  const out: Array<{ day: string; count: number; minutes: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    // 以 today 为锚点算日期，而不是 now：测试与「看到昨天为止」的场景都要能对齐
    const day = shiftDay(today, -i);
    const v = byDay.get(day) ?? { count: 0, minutes: 0 };
    out.push({ day, count: v.count, minutes: v.minutes });
  }
  return out;
}

function shiftDay(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt);
}

/** 导出全部专注记录（整包备份用） */
export function exportPomodoros(): PomodoroRecord[] {
  return loadRecords();
}

/**
 * 从备份导入专注记录：按 id 去重合并（同一份备份重复导入不会翻倍），
 * 返回新并入的条数。按结束时间排序，保持时间线可读。
 */
export function importPomodoros(state: unknown): number {
  const incoming = sanitizeRecords(state);
  if (incoming.length === 0) return 0;
  const cur = loadRecords();
  const seen = new Set(cur.map((r) => r.id));
  const merged = [...cur];
  let n = 0;
  for (const r of incoming) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
    n++;
  }
  if (n > 0) saveRecords(merged.sort((a, b) => a.endedAt - b.endedAt));
  return n;
}
