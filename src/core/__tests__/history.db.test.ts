/**
 * pushSnapshot / listSnapshotPaths 的 IndexedDB 行为测试（fake-indexeddb）。
 * 纯函数（pruneByPath/pruneGlobal）见 history.test.ts；这里覆盖重写后的存取路径：
 * 去重（同内容不重复推）、单篇保留 10 条、全库 600 上限、路径计数。
 *
 * 主键是 [path, at] 而 at = Date.now()：连续快照会落进同一毫秒互相覆盖（新旧实现
 * 行为一致），所以只 mock Date.now（不假造定时器——fake-indexeddb 内部依赖真实调度）。
 * 真实使用中保存有 800ms 防抖，不会踩到同毫秒覆盖。
 *
 * 注意：fake-indexeddb 的 getAll 没有真实浏览器的结构化克隆开销，
 * 这里只验证行为正确性——性能差异在真实 IDB 中才成立。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  pushSnapshot,
  listSnapshots,
  listSnapshotPaths,
  KEEP_PER_PATH,
  GLOBAL_CAP,
  type Snapshot,
} from '../history';

const DB_NAME = 'knowlattice-history';
const STORE = 'snaps';

/** 直写一条快照（绕过 pushSnapshot 的去重/清理，用于构造任意存量） */
async function seed(path: string, at: number, content: string): Promise<void> {
  const d = await openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ['path', 'at'] });
        store.createIndex('path', 'path');
        store.createIndex('at', 'at');
      }
    },
  });
  await d.put(STORE, { path, at, content } satisfies Snapshot);
  await d.close();
}

/** 清空快照库（每个用例独立起点；模块级 dbPromise 复用同一个库） */
async function clear(): Promise<void> {
  const d = await openDB(DB_NAME, 1, {
    upgrade() { /* schema 已由 pushSnapshot/seed 建立 */ },
  });
  await d.clear(STORE);
  await d.close();
}

/** 让 Date.now 每次调用 +2ms：主键 [path, at] 不再同毫秒互相覆盖 */
function tickClock(): () => void {
  let t = 1_000_000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 2));
  return () => spy.mockRestore();
}

afterEach(async () => {
  await clear();
});

describe('pushSnapshot（IndexedDB 路径）', () => {
  it('内容变化才推：同内容不重复', async () => {
    const restore = tickClock();
    await pushSnapshot('a.md', '内容一');
    await pushSnapshot('a.md', '内容一'); // 同内容 → 跳过
    await pushSnapshot('a.md', '内容二');
    restore();
    const recs = await listSnapshots('a.md');
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.content)).toEqual(['内容二', '内容一']); // 新 → 旧
  });

  it('单篇超过 10 条时删最旧，保留最近 10 条', async () => {
    const restore = tickClock();
    for (let i = 0; i < 12; i++) {
      await pushSnapshot('b.md', `版本${i}`);
    }
    restore();
    const recs = await listSnapshots('b.md');
    expect(recs).toHaveLength(KEEP_PER_PATH);
    expect(recs[0]?.content).toBe('版本11'); // 最新在前
    expect(recs.at(-1)?.content).toBe('版本2'); // 版本0、版本1 已被清掉
  });

  it('快照数 <10 的常态保存不误删（行为等价性）', async () => {
    // 旧实现在此分支 getAll 整库；新实现 count + 游标。行为必须一致：
    // 没超上限时不删任何东西
    const restore = tickClock();
    await pushSnapshot('c.md', 'v1');
    await pushSnapshot('d.md', 'w1');
    restore();
    const paths = await listSnapshotPaths();
    expect(paths.get('c.md')).toBe(1);
    expect(paths.get('d.md')).toBe(1);
  });

  it('全库超过 600 条时按最旧清理', async () => {
    // 直写 603 条（绕过 pushSnapshot 的逐条清理，快速构造超限状态）
    for (let i = 0; i < GLOBAL_CAP + 3; i++) {
      await seed(`p${Math.floor(i / 10)}.md`, i, `c${i}`);
    }
    const before = await listSnapshotPaths();
    expect([...before.values()].reduce((a, b) => a + b, 0)).toBe(GLOBAL_CAP + 3);

    // 再推一条（at = mock 时间戳 1000002，大于全部种子）→ 触发全库清理
    const restore = tickClock();
    await pushSnapshot('new.md', '新内容');
    restore();
    const after = await listSnapshotPaths();
    expect([...after.values()].reduce((a, b) => a + b, 0)).toBe(GLOBAL_CAP); // 603 + 1 - 4 最旧 = 600
    expect(after.get('new.md')).toBe(1); // 刚推的这条保留
    const p0 = await listSnapshots('p0.md');
    expect(p0.every((r) => r.at > 3)).toBe(true); // at=0..3 的最旧记录被删
  });

  it('listSnapshotPaths 聚合每篇的快照数', async () => {
    const restore = tickClock();
    await pushSnapshot('x.md', '1');
    await pushSnapshot('x.md', '2');
    await pushSnapshot('y.md', '1');
    restore();
    const counts = await listSnapshotPaths();
    expect(counts.get('x.md')).toBe(2);
    expect(counts.get('y.md')).toBe(1);
  });
});
