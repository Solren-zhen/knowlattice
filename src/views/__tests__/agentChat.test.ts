/**
 * AI 会话存储的单元测试（agentChat）。
 *
 * 这里钉的是「对话会不会丢 / 权限会不会悄悄放宽」这两类不可逆的事：
 *   - 上次意外退出留下的待确认提案必须变 stale，不能下次打开还能点「应用」；
 *   - 旧版单线程对话要能迁移，坏了就当空表，不能把面板炸掉；
 *   - 会话超限时只淘汰**非当前**会话，当前会话保底；
 *   - 配额满时 persistSessions 必须回 false（面板据此提示「关掉面板会丢」）；
 *   - 旧三档配置里只有 autonomous 能迁成 yolo，autoApply 必须退回 read。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OLD_CHAT_KEY,
  PERSIST_CONTENT_LIMIT,
  PREFS_KEY,
  SESSIONS_KEY,
  SESSIONS_LIMIT,
  fmtAgo,
  fmtTokens,
  freshSession,
  loadPrefs,
  loadSessions,
  persistSessions,
  savePrefs,
  type AgentSession,
  type ChatItem,
} from '../agentChat';

function session(id: string, updatedAt: number, items: ChatItem[] = []): AgentSession {
  return { id, title: id, updatedAt, usage: { promptTokens: 0, completionTokens: 0, estimated: false }, items };
}

const proposal = (id: number, status: 'pending' | 'applied'): ChatItem => ({
  kind: 'proposal', id, path: 'a.md', old: 'x', next: 'y', isNew: false, status,
});

beforeEach(() => localStorage.clear());

describe('freshSession', () => {
  it('新会话是空的，标题为「新对话」', () => {
    const s = freshSession();
    expect(s.items).toEqual([]);
    expect(s.title).toBe('新对话');
    expect(s.usage.promptTokens).toBe(0);
  });

  it('id 不重复', () => {
    const ids = new Set(Array.from({ length: 20 }, () => freshSession().id));
    expect(ids.size).toBe(20);
  });
});

describe('loadSessions', () => {
  it('没有存档时返回空表', () => {
    expect(loadSessions()).toEqual([]);
  });

  it('读回的待确认提案一律标为过期（审批 promise 不持久化，兑现不了）', () => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session('s1', 1, [proposal(1, 'pending'), proposal(2, 'applied')])]));
    const [s] = loadSessions();
    expect(s.items.map((i) => (i.kind === 'proposal' ? i.status : 'n/a'))).toEqual(['stale', 'applied']);
  });

  it('缺 usage 的老会话补零，不让面板崩', () => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([{ id: 's1', title: 't', updatedAt: 1, items: [] }]));
    expect(loadSessions()[0].usage).toEqual({ promptTokens: 0, completionTokens: 0, estimated: false });
  });

  it('旧版单线程对话迁移成一个会话，标题取首条用户消息前 24 字', () => {
    localStorage.setItem(OLD_CHAT_KEY, JSON.stringify([
      { kind: 'msg', id: 1, role: 'user', text: '请解释一下心衰的分型以及各型的血流动力学差别' },
      { kind: 'msg', id: 2, role: 'assistant', text: '…' },
    ]));
    const sessions = loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s-migrated');
    expect(sessions[0].title).toBe('请解释一下心衰的分型以及各型的血流动力学差别');
    expect(sessions[0].items).toHaveLength(2);
  });

  it('坏 JSON / 非数组 / 结构不对的条目都当空表', () => {
    localStorage.setItem(SESSIONS_KEY, '{oops');
    expect(loadSessions()).toEqual([]);
    localStorage.setItem(SESSIONS_KEY, '"nope"');
    expect(loadSessions()).toEqual([]);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([{ id: 1, items: [] }]));
    expect(loadSessions()).toEqual([]);
  });
});

describe('persistSessions', () => {
  it('写盘后能读回（提案正文按上限截断）', () => {
    const long = 'a'.repeat(PERSIST_CONTENT_LIMIT + 500);
    const items: ChatItem[] = [{ kind: 'proposal', id: 1, path: 'a.md', old: long, next: long, isNew: true, status: 'pending' }];
    expect(persistSessions([session('s1', 1, items)], 's1')).toBe(true);
    const [s] = loadSessions();
    const p = s.items[0];
    expect(p.kind === 'proposal' && p.old.length).toBe(PERSIST_CONTENT_LIMIT);
    // 读回时 pending 已被标 stale，这是预期行为
    expect(p.kind === 'proposal' && p.status).toBe('stale');
  });

  it('超过上限只淘汰最旧的**非当前**会话', () => {
    const many = Array.from({ length: SESSIONS_LIMIT + 5 }, (_, i) => session(`s${i}`, i));
    // 当前会话是最旧的，也必须保住
    expect(persistSessions(many, 's0')).toBe(true);
    const back = loadSessions();
    expect(back).toHaveLength(SESSIONS_LIMIT);
    expect(back.some((s) => s.id === 's0')).toBe(true);
    expect(back.some((s) => s.id === 's1')).toBe(false);
  });

  it('配额满时返回 false（面板据此提示对话会丢），而不是静默成功', () => {
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
        removeItem: () => {},
        clear: () => {},
        length: 0,
        key: () => null,
      },
    });
    try {
      expect(persistSessions([session('s1', 1)], 's1')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: real });
    }
  });
});

describe('yolo 权限的读取', () => {
  it('没存过时是 read 档（yolo=false）', () => {
    expect(loadPrefs()).toEqual({ yolo: false });
  });

  it('存了 yolo 就读回来', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ yolo: true }));
    expect(loadPrefs()).toEqual({ yolo: true });
  });

  it('旧三档里的 autonomous 迁成 yolo', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ autonomous: true }));
    expect(loadPrefs()).toEqual({ yolo: true });
  });

  it('旧三档里的 autoApply 不许悄悄升级成 yolo（那是放宽权限）', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ autoApply: true }));
    expect(loadPrefs()).toEqual({ yolo: false });
  });

  it('savePrefs 落盘后可读回；坏 JSON 退回默认', () => {
    savePrefs({ yolo: true });
    expect(loadPrefs()).toEqual({ yolo: true });
    localStorage.setItem(PREFS_KEY, 'not json');
    expect(loadPrefs()).toEqual({ yolo: false });
  });
});

describe('展示格式', () => {
  it('token 数四位以上折成 k', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
  });

  it('相对时间分档：分钟 / 小时 / 天', () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    expect(fmtAgo(now - 30_000, now)).toBe('刚刚');
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(fmtAgo(now - 2 * 86_400_000, now)).toBe('2 天前');
  });
});
