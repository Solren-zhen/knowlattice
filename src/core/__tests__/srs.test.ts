import { beforeEach, describe, expect, it, vi } from 'vitest';

// srs.ts 有模块级 cache（localStorage 解析缓存），测试间用 resetModules 隔离
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadSrs() {
  return await import('../srs');
}

describe('loadCards', () => {
  it('localStorage 为空返回 {}', async () => {
    expect(await loadSrs().then((m) => m.loadCards())).toEqual({});
  });

  it('丢弃旧版/残缺数据（无 stability 等字段）', async () => {
    localStorage.setItem(
      'medvault-srs',
      JSON.stringify({ good: { due: 1, reps: 1, stability: 2, difficulty: 4, state: 1 }, bad: { due: 'x' } })
    );
    const srs = await loadSrs();
    expect(Object.keys(srs.loadCards())).toEqual(['good']);
  });
});

describe('applyReview / dueQueue / srsStats', () => {
  const NOW = 1_752_000_000_000;

  it('首次评卡生成调度状态，due 在未来', async () => {
    const srs = await loadSrs();
    const card = srs.applyReview('a.md', 'good', NOW);
    expect(card.reps).toBe(1);
    expect(new Date(card.due).getTime()).toBeGreaterThan(NOW);
  });

  it('到期卡先出队，未来到期卡不出队，无卡的新篇排最后', async () => {
    const past = NOW - 10_000;
    const future = NOW + 10_000;
    localStorage.setItem(
      'medvault-srs',
      JSON.stringify({
        'past.md': { due: past, reps: 5, stability: 10, difficulty: 3, state: 1 },
        'future.md': { due: future, reps: 5, stability: 10, difficulty: 3, state: 1 },
      })
    );
    const srs = await loadSrs();
    const q = srs.dueQueue(['new.md', 'future.md', 'past.md'], NOW);
    expect(q[0]).toBe('past.md');
    expect(q).toEqual(['past.md', 'new.md']);
  });

  it('srsStats 统计已学与今日到期', async () => {
    localStorage.setItem(
      'medvault-srs',
      JSON.stringify({
        'learned-due.md': { due: 1_000, reps: 3, stability: 5, difficulty: 3, state: 1 },
        'learned-notdue.md': { due: 1_999_999_999_999, reps: 3, stability: 5, difficulty: 3, state: 1 },
      })
    );
    const srs = await loadSrs();
    expect(srs.srsStats(['learned-due.md', 'learned-notdue.md', 'unlearned.md'], NOW)).toEqual({
      total: 3,
      learned: 2,
      dueNow: 1,
    });
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
    srs.applyReview('a.md', 'good', NOW);
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
    srs.applyReview('a.md', 'good', NOW);
    const backup = JSON.stringify({ srs: JSON.parse(srs.exportSrsJson()) });
    localStorage.clear();
    expect(srs.importSrsFromJson(backup)).toBe(1);
    expect(Object.keys(srs.exportSrsState())).toEqual(['a.md']);
    // 裸状态对象直接导入
    localStorage.clear();
    expect(srs.importSrsFromJson(srs.exportSrsJson())).toBe(1);
  });
});
