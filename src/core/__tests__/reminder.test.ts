import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER,
  isValidTime,
  loadReminder,
  localDateKey,
  markFired,
  notifySupport,
  reminderBody,
  sanitizeReminder,
  saveReminder,
  sendSystemNotify,
  shouldFire,
} from '../reminder';

beforeEach(() => {
  localStorage.clear();
});

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min);

describe('reminder · 时刻校验', () => {
  it('只接受 HH:MM（两位、0-23 时、0-59 分）', () => {
    expect(isValidTime('20:00')).toBe(true);
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('2:00')).toBe(false);
    expect(isValidTime('20:60')).toBe(false);
    expect(isValidTime('')).toBe(false);
  });
});

describe('reminder · 本地日期键', () => {
  it('用本地时区，不用 UTC（否则东八区晚上会记错天）', () => {
    expect(localDateKey(at(2026, 10, 5, 20, 0))).toBe('2026-10-05');
    expect(localDateKey(at(2026, 1, 9, 0, 5))).toBe('2026-01-09');
  });
});

describe('reminder · 清洗与存取', () => {
  it('非法 time 退回默认时刻', () => {
    expect(sanitizeReminder({ time: '99:99' }).time).toBe(DEFAULT_REMINDER.time);
    expect(sanitizeReminder({ lastFired: '昨天' }).lastFired).toBe('');
  });

  it('enabled 必须是真 true', () => {
    expect(sanitizeReminder({ enabled: 'yes' }).enabled).toBe(false);
    expect(sanitizeReminder({ enabled: true }).enabled).toBe(true);
  });

  it('默认是关闭的（不替用户决定"可以打扰我"）', () => {
    expect(loadReminder()).toEqual({ ...DEFAULT_REMINDER, enabled: false });
  });

  it('存进去再读出来一致', () => {
    saveReminder({ enabled: true, time: '07:30', lastFired: '2026-10-05' });
    expect(loadReminder()).toEqual({ enabled: true, time: '07:30', lastFired: '2026-10-05' });
  });
});

describe('reminder · 该不该提醒', () => {
  const cfg = { enabled: true, time: '20:00', lastFired: '' };

  it('开关关闭时不提醒', () => {
    expect(shouldFire({ ...cfg, enabled: false }, at(2026, 10, 5, 21, 0), 10)).toBe(false);
  });

  it('没有到期卡时不提醒（没卡还提醒就是纯打扰）', () => {
    expect(shouldFire(cfg, at(2026, 10, 5, 21, 0), 0)).toBe(false);
  });

  it('未到点不提醒，到点/过点提醒', () => {
    expect(shouldFire(cfg, at(2026, 10, 5, 19, 59), 10)).toBe(false);
    expect(shouldFire(cfg, at(2026, 10, 5, 20, 0), 10)).toBe(true);
    // 轮询可能整分钟跳过设定时刻，所以过了也算该提醒
    expect(shouldFire(cfg, at(2026, 10, 5, 23, 30), 10)).toBe(true);
  });

  it('同一天只提醒一次', () => {
    expect(shouldFire({ ...cfg, lastFired: '2026-10-05' }, at(2026, 10, 5, 21, 0), 10)).toBe(false);
    expect(shouldFire({ ...cfg, lastFired: '2026-10-04' }, at(2026, 10, 5, 21, 0), 10)).toBe(true);
  });

  it('markFired 记下今天', () => {
    const next = markFired(cfg, at(2026, 10, 5, 21, 0));
    expect(next.lastFired).toBe('2026-10-05');
    expect(loadReminder().lastFired).toBe('2026-10-05');
    expect(shouldFire(next, at(2026, 10, 5, 22, 0), 10)).toBe(false);
  });
});

describe('reminder · 运行时不支持通知时必须安全降级', () => {
  it('Node/无 Notification 环境下判定为不支持', () => {
    // 测试环境没有 Notification 构造器
    expect(notifySupport()).toBe('unsupported');
  });

  it('不支持时发送返回 false，且不抛异常（调用方据此退回应用内提示）', () => {
    expect(sendSystemNotify('标题', '正文')).toBe(false);
  });
});

describe('reminder · 提醒正文', () => {
  it('带上到期张数', () => {
    expect(reminderBody(12, null)).toBe('今天有 12 张卡片到期。');
  });

  it('有考试日期时补上倒计时', () => {
    expect(reminderBody(12, 30)).toContain('距考试还有 30 天');
    expect(reminderBody(12, 0)).toContain('考试就是今天');
    expect(reminderBody(12, -3)).toBe('今天有 12 张卡片到期。');
  });
});
