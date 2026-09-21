import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCard } from '../srsCards';

// srs.ts 有模块级 cache（localStorage 解析缓存），测试间用 resetModules 隔离
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadSrs() {
  return await import('../srs');
}

/** 造一张卡：默认是「整篇卡」（key === path），传 key 则模拟小节卡 */
function card(path: string, key = path, legacyKey?: string): ReviewCard {
  return { key, path, noteTitle: path, heading: key === path ? '' : key.slice(path.length + 1), body: 'x', hints: [], legacyKey };
}

/** 直接塞一条调度状态 */
function seed(state: Record<string, unknown>) {
  localStorage.setItem('knowlattice-srs', JSON.stringify(state));
}

const state = (due: number, reps = 5) => ({ due, reps, stability: 10, difficulty: 3, state: 1 });

describe('loadCards', () => {
  it('localStorage 为空返回 {}', async () => {
    expect(await loadSrs().then((m) => m.loadCards())).toEqual({});
  });

  it('丢弃旧版/残缺数据（无 stability 等字段）', async () => {
    seed({ good: state(1, 1), bad: { due: 'x' } });
    const srs = await loadSrs();
    expect(Object.keys(srs.loadCards())).toEqual(['good']);
  });
});

describe('applyReview / dueQueue / srsStats', () => {
  const NOW = 1_752_000_000_000;

  it('首次评卡生成调度状态，due 在未来', async () => {
    const srs = await loadSrs();
    const c = srs.applyReview(card('a.md'), 'good', NOW);
    expect(c.reps).toBe(1);
    expect(new Date(c.due).getTime()).toBeGreaterThan(NOW);
  });

  it('到期卡先出队，未来到期卡不出队，无卡的新篇排最后', async () => {
    seed({
      'past.md': state(NOW - 10_000),
      'future.md': state(NOW + 10_000),
    });
    const srs = await loadSrs();
    const q = srs.dueQueue([card('new.md'), card('future.md'), card('past.md')], NOW);
    expect(q.map((c) => c.key)).toEqual(['past.md', 'new.md']);
  });

  it('同一篇的多张小节卡各排各的（这正是改粒度的意义）', async () => {
    seed({ 'a.md#一': state(NOW - 10_000), 'a.md#二': state(NOW + 10_000) });
    const srs = await loadSrs();
    const cards = [card('a.md', 'a.md#一'), card('a.md', 'a.md#二')];
    expect(srs.dueQueue(cards, NOW).map((c) => c.key)).toEqual(['a.md#一']);
    expect(srs.srsStats(cards, NOW)).toEqual({ total: 2, learned: 2, dueNow: 1 });
  });

  it('srsStats 统计已学与今日到期（单位是卡）', async () => {
    seed({ 'learned-due.md': state(1_000, 3), 'learned-notdue.md': state(1_999_999_999_999, 3) });
    const srs = await loadSrs();
    const cards = [card('learned-due.md'), card('learned-notdue.md'), card('unlearned.md')];
    expect(srs.srsStats(cards, NOW)).toEqual({ total: 3, learned: 2, dueNow: 1 });
  });
});

describe('粒度升级的迁移：旧的「整篇卡」调度不丢', () => {
  const NOW = 1_752_000_000_000;

  it('小节卡还没有自己的调度时，继承该篇旧的整篇卡调度', async () => {
    seed({ 'a.md': state(NOW - 10_000) }); // 旧数据：一篇一卡
    const srs = await loadSrs();
    const first = card('a.md', 'a.md#一', 'a.md');
    const second = card('a.md', 'a.md#二', 'a.md');
    // 首张卡算「已到期」而不是「新卡」；第二节同样读到旧调度（同一次迁移）
    expect(srs.dueQueue([first, second], NOW).map((c) => c.key)).toEqual(['a.md#一', 'a.md#二']);
    expect(srs.srsStats([first, second], NOW)).toEqual({ total: 2, learned: 2, dueNow: 2 });
    expect(srs.scheduleOf(srs.loadCards(), first)?.reps).toBe(5);
  });

  it('首评后调度落到小节键上，旧键被删掉（不会继承第二次）', async () => {
    seed({ 'a.md': state(NOW - 10_000) });
    const srs = await loadSrs();
    const first = card('a.md', 'a.md#一', 'a.md');
    srs.applyReview(first, 'good', NOW);
    const keys = Object.keys(srs.loadCards());
    expect(keys).toEqual(['a.md#一']);
    expect(srs.loadCards()['a.md']).toBeUndefined();
  });

  it('整篇卡（没有小节的笔记）键不变，与旧数据同键', async () => {
    seed({ 'a.md': state(NOW - 10_000) });
    const srs = await loadSrs();
    const whole = card('a.md');
    expect(srs.dueQueue([whole], NOW).map((c) => c.key)).toEqual(['a.md']);
    srs.applyReview(whole, 'good', NOW);
    expect(Object.keys(srs.loadCards())).toEqual(['a.md']);
  });

  it('noteStatus：最紧的那张卡代表整篇，并给出已排程节数', async () => {
    seed({ 'a.md#一': state(NOW + 50_000), 'a.md#二': state(NOW - 1_000) });
    const srs = await loadSrs();
    const cards = [card('a.md', 'a.md#一'), card('a.md', 'a.md#二'), card('a.md', 'a.md#三')];
    const st = srs.noteStatus(cards, 'a.md', NOW);
    expect(st.total).toBe(3);
    expect(st.learned).toBe(2);
    expect(st.dueNow).toBe(true); // 最紧的那张已到期
    expect(new Date(st.card!.due).getTime()).toBe(NOW - 1_000);
  });

  it('noteStatus：完全没学过时 card 为 null', async () => {
    const srs = await loadSrs();
    const st = srs.noteStatus([card('a.md', 'a.md#一')], 'a.md', NOW);
    expect(st).toMatchObject({ total: 1, learned: 0, dueNow: false, card: null });
  });
});

describe('导入导出（回归：due 序列化为 ISO 字符串）', () => {
  const NOW = 1_752_000_000_000;

  it('importSrsState 接受 ISO 字符串与时间戳数字', async () => {
    const srs = await loadSrs();
    const iso = { x: { due: '2026-01-02T03:04:05.000Z', reps: 2, stability: 3, difficulty: 4, state: 1 } };
    expect(srs.importSrsState(iso)).toBe(1);
    expect(srs.importSrsState({ y: { due: 123456789, reps: 1, stability: 2, difficulty: 3, state: 0 } })).toBe(1);
    expect(Object.keys(srs.loadCards()).sort()).toEqual(['x', 'y']);
  });

  it('导入合并：已有卡保留', async () => {
    const srs = await loadSrs();
    srs.applyReview(card('a.md'), 'good', NOW);
    srs.importSrsState({ b: { due: '2026-01-01T00:00:00.000Z', reps: 1, stability: 2, difficulty: 3, state: 1 } });
    expect(Object.keys(srs.loadCards()).sort()).toEqual(['a.md', 'b']);
  });

  it('格式无效抛错', async () => {
    const srs = await loadSrs();
    expect(() => srs.importSrsState(null)).toThrow();
    expect(() => srs.importSrsState('bad')).toThrow();
  });

  it('exportSrsJson ↔ importSrsFromJson 回环（整包备份自动取 .srs）', async () => {
    const srs = await loadSrs();
    srs.applyReview(card('a.md'), 'good', NOW);
    const backup = JSON.stringify({ srs: JSON.parse(srs.exportSrsJson()) });
    localStorage.clear();
    expect(srs.importSrsFromJson(backup)).toBe(1);
    expect(Object.keys(srs.exportSrsState())).toEqual(['a.md']);
    // 裸状态对象直接导入
    localStorage.clear();
    expect(srs.importSrsFromJson(srs.exportSrsJson())).toBe(1);
  });
});
