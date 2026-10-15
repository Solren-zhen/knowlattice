/**
 * 每日复习提醒：到点提醒你今天还有多少张卡要清。
 *
 * 借鉴点：第三方备考工具用系统级本地通知做每日复习提醒
 * （「每天定时提醒您完成今日学习任务与闪卡复习」/「每天定时提醒你复习遗忘曲线」，
 * 配套 flutter_local_notifications 适配层）。本项目此前**完全没有**任何提醒机制：
 * 复习是「你自己想起来才会打开」，没有到期卡已经堆积的提示（全库 grep 确认为 0，
 * src/main.tsx 还主动注销了所有 Service Worker，所以连推送都没有）。
 *
 * 为什么默认关闭：提醒会打断用户。默认开启等于替所有人做了一次"允许打扰我"的决定，
 * 与"保持现有行为不变"直接冲突。所以 enabled 默认 false，由用户在统计面板里显式打开。
 *
 * 为什么要有应用内兜底：Tauri 的 WebView2 对 Web Notification API 的支持依赖宿主实现，
 * 桌面端不保证可用（本项目也没装 @tauri-apps/plugin-notification，不为一个提醒去加依赖）。
 * 所以发送路径是「系统通知 → 不可用就退回应用内 toast」，两条路都必须能用；
 * 判定与发送分开（shouldFire 是纯函数），这样"该不该提醒"可以单测，
 * 而"能不能弹出来"由调用方按运行时能力处理。
 */

export interface ReminderConfig {
  /** 是否开启每日提醒 */
  enabled: boolean;
  /** 提醒时刻，本地时间 `HH:MM` */
  time: string;
  /** 上次已提醒的本地日期 `YYYY-MM-DD`：同一天只提醒一次 */
  lastFired: string;
}

const KEY = 'knowlattice-review-reminder';

export const DEFAULT_REMINDER: ReminderConfig = { enabled: false, time: '20:00', lastFired: '' };

/** `HH:MM`，00:00–23:59 */
export function isValidTime(t: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/**
 * 本地日历日 `YYYY-MM-DD`。
 * 用本地时区而不是 toISOString()——后者是 UTC，在东八区会把晚上 20:00 的提醒
 * 记成"昨天"或"明天"，于是同一天要么重复提醒、要么整天不提醒。
 */
export function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const minutesOfTime = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export function sanitizeReminder(raw: unknown): ReminderConfig {
  const o = (raw ?? {}) as Partial<ReminderConfig>;
  const time = typeof o.time === 'string' && isValidTime(o.time) ? o.time : DEFAULT_REMINDER.time;
  const lastFired = typeof o.lastFired === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.lastFired) ? o.lastFired : '';
  return { enabled: o.enabled === true, time, lastFired };
}

export function loadReminder(): ReminderConfig {
  try {
    return sanitizeReminder(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_REMINDER };
  }
}

export function saveReminder(cfg: ReminderConfig): ReminderConfig {
  const clean = sanitizeReminder(cfg);
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

export function exportReminder(): ReminderConfig {
  return loadReminder();
}

export function importReminder(raw: unknown): boolean {
  const clean = sanitizeReminder(raw);
  if (!clean.enabled && !clean.lastFired) return false;
  saveReminder(clean);
  return true;
}

/**
 * 现在该不该提醒（纯函数）：
 *   1. 开关打开；
 *   2. 确实有到期卡（dueNow > 0）——没卡还提醒就是纯打扰；
 *   3. 今天还没提醒过；
 *   4. 当前时刻已过设定时刻（用 >= 而不是 == ：轮询有间隔，恰好错过那一分钟
 *      就永远不提醒了；这也是 core/pomodoro.ts 用时间戳现算而不是累加计数的同一思路）。
 */
export function shouldFire(cfg: ReminderConfig, now: Date, dueNow: number): boolean {
  if (!cfg.enabled) return false;
  if (dueNow <= 0) return false;
  if (cfg.lastFired === localDateKey(now)) return false;
  return now.getHours() * 60 + now.getMinutes() >= minutesOfTime(cfg.time);
}

/** 记下"今天已提醒"，返回新对象（视图放进 state，原地改不换引用会不重渲染） */
export function markFired(cfg: ReminderConfig, now = new Date()): ReminderConfig {
  return saveReminder({ ...cfg, lastFired: localDateKey(now) });
}

export type NotifySupport = 'granted' | 'denied' | 'default' | 'unsupported';

/** 当前运行时对系统通知的支持情况（不申请权限，只读） */
export function notifySupport(): NotifySupport {
  if (typeof globalThis.Notification !== 'function') return 'unsupported';
  return Notification.permission;
}

/**
 * 申请系统通知权限。**必须在用户点击事件里调用**——浏览器/WebView 会拒绝
 * 非用户手势触发的权限请求，那样用户会看到"点了开关但没反应"。
 */
export async function requestNotifyPermission(): Promise<NotifySupport> {
  if (notifySupport() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

/**
 * 发一条系统通知。返回是否真的发出去了——调用方据此决定要不要退回应用内提示。
 * 不抛异常：通知失败不该让复习计时/队列统计跟着挂掉。
 */
export function sendSystemNotify(title: string, body: string): boolean {
  if (notifySupport() !== 'granted') return false;
  try {
    new Notification(title, { body, tag: 'knowlattice-review' });
    return true;
  } catch {
    return false;
  }
}

/** 提醒正文：把到期张数说清楚，用户一看就知道要不要现在去复习 */
export function reminderBody(dueNow: number, examDays: number | null): string {
  const base = `今天有 ${dueNow} 张卡片到期。`;
  if (examDays === null) return base;
  if (examDays > 0) return `${base}距考试还有 ${examDays} 天。`;
  if (examDays === 0) return `${base}考试就是今天。`;
  return base;
}
