import { describe, expect, it } from 'vitest';
import { pruneByPath, pruneGlobal, KEEP_PER_PATH, GLOBAL_CAP, type Snapshot } from '../history';

const snap = (path: string, at: number): Snapshot => ({ path, at, content: `c${at}` });

describe('pruneByPath（单篇保留策略）', () => {
  it('保留最近 N 条，返回更旧条目的时间戳', () => {
    const recs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => snap('a.md', i));
    const stale = pruneByPath(recs, 10);
    expect(stale).toEqual([1, 2]);
  });

  it('不足 keep 条时不清理', () => {
    expect(pruneByPath([snap('a.md', 1), snap('a.md', 2)], 10)).toEqual([]);
  });

  it('乱序输入也正确（按时间排序后取前 N）', () => {
    const recs = [5, 3, 9, 1, 7].map((i) => snap('a.md', i));
    expect(pruneByPath(recs, 3)).toEqual([1, 3]);
  });

  it('默认参数 = KEEP_PER_PATH', () => {
    const recs = Array.from({ length: KEEP_PER_PATH + 3 }, (_, i) => snap('a.md', i + 1));
    expect(pruneByPath(recs)).toHaveLength(3);
  });
});

describe('pruneGlobal（全库总量清理）', () => {
  it('未超上限返回空', () => {
    const recs = Array.from({ length: GLOBAL_CAP }, (_, i) => snap(`p${i}.md`, i));
    expect(pruneGlobal(recs)).toEqual([]);
  });

  it('超上限时先删最旧，保留最新的 cap 条', () => {
    const recs = Array.from({ length: GLOBAL_CAP + 5 }, (_, i) => snap(`p${i}.md`, i + 1));
    const stale = pruneGlobal(recs);
    expect(stale).toHaveLength(5);
    expect(stale.map(([p]) => p)).toEqual(['p0.md', 'p1.md', 'p2.md', 'p3.md', 'p4.md']);
  });
});
