import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearReciteLog,
  lastReciteOf,
  MAX_RECITE_SESSIONS,
  reciteCountOf,
  reciteLog,
  recordRecite,
  sanitizeReciteLog,
} from '../reciteLog';

beforeEach(() => {
  localStorage.clear();
});

describe('reciteLog', () => {
  it('新的在前，可按篇查最近一次与累计轮数', () => {
    recordRecite({ path: 'a.md', total: 8, revealed: 6, ms: 60_000, at: 1000 });
    recordRecite({ path: 'b.md', total: 4, revealed: 1, ms: 30_000, at: 2000 });
    recordRecite({ path: 'a.md', total: 8, revealed: 7, ms: 50_000, at: 3000 });

    expect(reciteLog().map((s) => s.path)).toEqual(['a.md', 'b.md', 'a.md']);
    expect(lastReciteOf('a.md')).toMatchObject({ revealed: 7, total: 8 });
    expect(reciteCountOf('a.md')).toBe(2);
    expect(lastReciteOf('nope.md')).toBeNull();
    expect(lastReciteOf('')).toBeNull();
  });

  it('清洗脏数据：缺字段、空路径、非数字一律丢弃；负数与超长时长夹到合法区间', () => {
    const out = sanitizeReciteLog([
      { path: 'a.md', total: 3, revealed: 99, ms: -5, at: 10 },
      { path: '', total: 1, revealed: 1, ms: 1, at: 1 },
      { total: 1 },
      null,
      'x',
      { path: 'b.md', total: 'x', revealed: 1, ms: 1, at: 1 },
      { path: 'c.md', total: 2, revealed: 1, ms: 99 * 3600_000, at: 2 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: 'a.md', total: 3, revealed: 99, ms: 0, at: 10 });
    // 超过 6 小时按 6 小时计：开着页面去吃饭不算背诵
    expect(out[1].ms).toBe(6 * 3600_000);
  });

  it(`最多保留 ${MAX_RECITE_SESSIONS} 轮`, () => {
    for (let i = 0; i < MAX_RECITE_SESSIONS + 5; i++) {
      recordRecite({ path: 'a.md', total: 1, revealed: 1, ms: 1000, at: i });
    }
    const list = reciteLog();
    expect(list).toHaveLength(MAX_RECITE_SESSIONS);
    // 新的在前：最后写入的 at 最大
    expect(list[0].at).toBe(MAX_RECITE_SESSIONS + 4);
  });

  it('清空后回到空列表', () => {
    recordRecite({ path: 'a.md', total: 1, revealed: 1, ms: 1000, at: 1 });
    clearReciteLog();
    expect(reciteLog()).toEqual([]);
  });
});
