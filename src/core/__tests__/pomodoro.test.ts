/**
 * 番茄钟（core/pomodoro.ts）：状态机、真实时间戳计时（不漂移）、记录与统计、持久化。
 * 计时部分全用显式传入的 now，不碰真实时钟，所以断言是确定的。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecord, DEFAULT_CONFIG, defaultState, elapsedMs, exportPomodoros, importPomodoros, loadConfig, loadRecords,
  loadState, nextPhase, pause, phaseMs, pomoStats, pomoTrend, progressOf, remainingMs, reset, saveConfig,
  saveState, sanitizeConfig, skip, start, tick, type PomodoroConfig, type PomodoroRecord,
} from '../pomodoro';

beforeEach(() => localStorage.clear());

const T0 = Date.parse('2026-09-21T10:00:00'); // 固定基准时间
const MIN = 60_000;
const cfg: PomodoroConfig = { ...DEFAULT_CONFIG };

describe('番茄钟：配置', () => {
  it('坏配置回落到默认值，数值被夹在合理区间', () => {
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig({ focusMin: 0, shortMin: 999, longMin: -3, longEvery: 0 })).toEqual({
      focusMin: 1, shortMin: 60, longMin: 1, longEvery: 1, autoStart: DEFAULT_CONFIG.autoStart,
    });
    expect(sanitizeConfig({ focusMin: '25' })).toEqual(DEFAULT_CONFIG);
  });

  it('读写往返；坏 JSON 不炸', () => {
    saveConfig({ ...DEFAULT_CONFIG, focusMin: 45, autoStart: false });
    expect(loadConfig()).toMatchObject({ focusMin: 45, autoStart: false });
    localStorage.setItem('knowlattice-pomodoro-config', '{oops');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('阶段时长按配置算', () => {
    expect(phaseMs('focus', cfg)).toBe(25 * MIN);
    expect(phaseMs('short', cfg)).toBe(5 * MIN);
    expect(phaseMs('long', cfg)).toBe(15 * MIN);
  });
});

describe('番茄钟：计时不漂移', () => {
  it('运行中剩余时间随真实时间线性减少（不是每秒累加出来的）', () => {
    const s = start(defaultState(), T0);
    expect(remainingMs(s, cfg, T0)).toBe(25 * MIN);
    // 时钟直接跳 10 分钟（模拟标签页被挂起）——剩余必须正好少 10 分钟
    expect(remainingMs(s, cfg, T0 + 10 * MIN)).toBe(15 * MIN);
    expect(progressOf(s, cfg, T0 + 10 * MIN)).toBeCloseTo(0.4, 5);
    // 跳过头也不会变负数
    expect(remainingMs(s, cfg, T0 + 99 * MIN)).toBe(0);
  });

  it('暂停期间的墙钟时间不算进专注', () => {
    let s = start(defaultState(), T0);
    s = pause(s, T0 + 5 * MIN); // 已专注 5 分钟
    expect(elapsedMs(s, T0 + 5 * MIN)).toBe(5 * MIN);
    // 暂停了两小时再继续，已跑时长不能变
    s = start(s, T0 + 125 * MIN);
    expect(elapsedMs(s, T0 + 125 * MIN)).toBe(5 * MIN);
    expect(remainingMs(s, cfg, T0 + 125 * MIN)).toBe(20 * MIN);
    // 继续跑 20 分钟，正好走完
    expect(remainingMs(s, cfg, T0 + 145 * MIN)).toBe(0);
  });

  it('重复 start / pause 是幂等的；reset 只清当前这段', () => {
    const s0 = defaultState();
    expect(start(s0, T0)).toEqual(start(start(s0, T0), T0));
    const s1 = pause(start(s0, T0), T0 + MIN);
    expect(pause(s1, T0 + 9 * MIN)).toBe(s1); // 已经暂停，原样返回
    expect(reset(s1)).toEqual({ ...s1, running: false, startedAt: null, elapsedMs: 0 });
    expect(reset(s1).phase).toBe('focus');
  });
});

describe('番茄钟：阶段推进', () => {
  it('专注走完 → 短休息，并产出记录（分钟数用计划时长）', () => {
    const s = start({ ...defaultState('t-1'), }, T0);
    const r = tick(s, cfg, T0 + 25 * MIN, 'p-1');
    expect(r.finished).toBe(true);
    expect(r.record).toEqual({ id: 'p-1', day: '2026-09-21', endedAt: T0 + 25 * MIN, minutes: 25, taskId: 't-1' });
    expect(r.state.phase).toBe('short');
    expect(r.state.focusDone).toBe(1);
    expect(r.state.running).toBe(true); // autoStart 默认开
  });

  it('没到点不推进', () => {
    const s = start(defaultState(), T0);
    const r = tick(s, cfg, T0 + 24 * MIN);
    expect(r.finished).toBe(false);
    expect(r.record).toBeUndefined();
    expect(r.state).toBe(s);
  });

  it('休息走完 → 回专注，且不产出记录', () => {
    let s = start(defaultState(), T0);
    s = tick(s, cfg, T0 + 25 * MIN, 'p-1').state; // → 短休息
    const r = tick(s, cfg, T0 + 30 * MIN, 'p-2');
    expect(r.finished).toBe(true);
    expect(r.record).toBeUndefined();
    expect(r.state.phase).toBe('focus');
    expect(r.state.focusDone).toBe(1);
  });

  it('每 4 个专注之后是长休息', () => {
    let s = start({ ...defaultState(), focusDone: 3 }, T0);
    expect(nextPhase(s, cfg)).toBe('long');
    s = tick(s, cfg, T0 + 25 * MIN, 'p-1').state;
    expect(s.phase).toBe('long');
    expect(s.focusDone).toBe(4);
    // 长休息完 → 专注
    const r = tick(s, cfg, T0 + 40 * MIN, 'p-2');
    expect(r.state.phase).toBe('focus');
  });

  it('autoStart 关掉时下一阶段停在原地不跑', () => {
    const off: PomodoroConfig = { ...cfg, autoStart: false };
    const r = tick(start(defaultState(), T0), off, T0 + 25 * MIN, 'p-1');
    expect(r.state.phase).toBe('short');
    expect(r.state.running).toBe(false);
    expect(r.state.startedAt).toBeNull();
    expect(remainingMs(r.state, off, T0 + 999 * MIN)).toBe(5 * MIN); // 没跑就不会自己走完
  });

  it('跳过专注不记番茄、也不推进节奏', () => {
    const s = skip(start(defaultState(), T0), cfg, T0 + MIN);
    expect(s.phase).toBe('short');
    expect(s.focusDone).toBe(0);
    expect(skip(s, cfg, T0 + MIN).phase).toBe('focus');
  });

  it('一次 tick 只前进一个阶段（关掉面板两小时，不会把中间几段凭空补出来）', () => {
    const r = tick(start(defaultState(), T0), cfg, T0 + 120 * MIN, 'p-1');
    expect(r.state.phase).toBe('short'); // 只前进到短休息，不会一路补到后面
    expect(r.state.elapsedMs).toBe(0);
    // 但记录要落在真正跑完的那一刻，而不是「重开面板」的那一刻
    expect(r.record!.endedAt).toBe(T0 + 25 * MIN);
    expect(r.record!.day).toBe('2026-09-21');
  });

  it('跨零点：记在**完成**那天，不是开始那天', () => {
    const late = Date.parse('2026-09-21T23:50:00');
    const r = tick(start(defaultState(), late), cfg, late + 30 * MIN, 'p-1'); // 次日 00:20 才打开面板
    expect(r.record!.endedAt).toBe(late + 25 * MIN); // 真正跑完是次日 00:15
    expect(r.record!.day).toBe('2026-09-22');
  });
});

describe('番茄钟：持久化与记录', () => {
  it('状态读写往返；坏数据回落到干净状态', () => {
    const s = start({ ...defaultState('t-9'), focusDone: 2 }, T0);
    saveState(s);
    expect(loadState()).toEqual(s);
    localStorage.setItem('knowlattice-pomodoro', '{"phase":"??","running":"yes","focusDone":-5}');
    expect(loadState()).toEqual(defaultState());
    localStorage.setItem('knowlattice-pomodoro', 'nope');
    expect(loadState()).toEqual(defaultState());
  });

  it('记录：坏条目被丢掉，好的留下', () => {
    const good: PomodoroRecord = { id: 'p-1', day: '2026-09-21', endedAt: T0, minutes: 25 };
    addRecord([], good);
    addRecord(loadRecords(), { id: 'p-2', day: '2026-09-21', endedAt: T0 + MIN, minutes: 25, taskId: 't-1' });
    expect(loadRecords()).toHaveLength(2);

    localStorage.setItem('knowlattice-pomodoros', JSON.stringify([
      good,
      { id: '', minutes: 25, endedAt: T0 },          // 没 id
      { id: 'p-3', minutes: 0, endedAt: T0 },        // 0 分钟
      { id: 'p-4', minutes: 25 },                    // 没结束时间
      { id: 'p-5', minutes: 25, endedAt: T0 },       // 好的，day 缺省按结束时间补
    ]));
    const list = loadRecords();
    expect(list.map((r) => r.id)).toEqual(['p-1', 'p-5']);
    expect(list[1].day).toBe('2026-09-21');
  });

  it('统计今日/累计', () => {
    const recs: PomodoroRecord[] = [
      { id: 'a', day: '2026-09-21', endedAt: T0, minutes: 25 },
      { id: 'b', day: '2026-09-21', endedAt: T0, minutes: 25, taskId: 't-1' },
      { id: 'c', day: '2026-09-20', endedAt: T0, minutes: 15 },
    ];
    expect(pomoStats(recs, '2026-09-21')).toEqual({ todayCount: 2, todayMinutes: 50, totalCount: 3, totalMinutes: 65 });
  });

  it('近 7 天趋势以 today 为锚点，末尾是今天', () => {
    const recs: PomodoroRecord[] = [
      { id: 'a', day: '2026-09-21', endedAt: T0, minutes: 25 },
      { id: 'b', day: '2026-09-18', endedAt: T0, minutes: 25 },
      { id: 'c', day: '2026-09-18', endedAt: T0, minutes: 15 },
    ];
    const t = pomoTrend(recs, '2026-09-21', 7);
    expect(t).toHaveLength(7);
    expect(t[6]).toEqual({ day: '2026-09-21', count: 1, minutes: 25 });
    expect(t[3]).toEqual({ day: '2026-09-18', count: 2, minutes: 40 });
    expect(t[0].day).toBe('2026-09-15');
    expect(t[0].count).toBe(0);
  });

  it('导出后清空再导入，记录能原样回来；重复导入不翻倍', () => {
    addRecord([], { id: 'p-1', day: '2026-09-21', endedAt: T0, minutes: 25 });
    const dumped = exportPomodoros();
    localStorage.clear();
    expect(importPomodoros(dumped)).toBe(1);
    expect(loadRecords()).toHaveLength(1);
    expect(importPomodoros(dumped)).toBe(0); // 同一份备份再导一次不翻倍
    expect(importPomodoros(null)).toBe(0);
    expect(importPomodoros([{ junk: true }])).toBe(0);
  });
});
