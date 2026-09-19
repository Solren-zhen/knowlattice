/**
 * 笔记历史快照（IndexedDB 独立库 knowlattice-history，与 knowlattice / knowlattice-pdfs 互不干扰）：
 * - 每次保存后异步推入一条全量快照（纯文本体积小；同一内容不重复推）
 * - 每篇笔记保留最近 10 条；全库快照总量超上限时清理最旧的（防止单库无限膨胀）
 * - 删除笔记时不清理快照 → 误删的笔记可从「历史版本」面板找回
 * 纯函数部分（pruneByPath / pruneGlobal）可单测，IndexedDB 仅在浏览器中可用。
 */

import { openDB } from 'idb';

export interface Snapshot {
  path: string;
  /** 保存时间戳（毫秒），与 path 组成主键 */
  at: number;
  content: string;
}

const DB_NAME = 'knowlattice-history';
const STORE = 'snaps';
/** 每篇笔记最多保留的快照数 */
export const KEEP_PER_PATH = 10;
/** 全库快照总量上限（超过后从最旧开始清理） */
export const GLOBAL_CAP = 600;

async function db() {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) {
        const store = d.createObjectStore(STORE, { keyPath: ['path', 'at'] });
        store.createIndex('path', 'path');
        store.createIndex('at', 'at');
      }
    },
  });
}

/* ---------- 纯函数：保留策略 ---------- */

/** 单篇笔记的保留策略：按时间倒序保留前 keep 条，返回待删除的时间戳（升序） */
export function pruneByPath(recs: Snapshot[], keep = KEEP_PER_PATH): number[] {
  return [...recs]
    .sort((a, b) => b.at - a.at)
    .slice(keep)
    .map((r) => r.at)
    .sort((a, b) => a - b);
}

/** 全库总量清理：超出 cap 时返回需要删除的（path, at）列表（先删最旧） */
export function pruneGlobal(recs: Snapshot[], cap = GLOBAL_CAP): Array<[string, number]> {
  if (recs.length <= cap) return [];
  return [...recs]
    .sort((a, b) => a.at - b.at)
    .slice(0, recs.length - cap)
    .map((r) => [r.path, r.at] as [string, number]);
}

/* ---------- IndexedDB 操作（浏览器中调用） ---------- */

/** 保存成功后调用：内容与最新快照相同则跳过；fire-and-forget，不阻塞保存 */
export async function pushSnapshot(path: string, content: string): Promise<void> {
  try {
    const d = await db();
    const idx = d.transaction(STORE, 'readonly').store.index('path');
    const recs = (await idx.getAll(path)) as Snapshot[];
    const latest = recs.sort((a, b) => b.at - a.at)[0];
    if (latest && latest.content === content) return;
    const rec: Snapshot = { path, at: Date.now(), content };
    await d.put(STORE, rec);
    // 保留策略：单篇超额 + 全库超额
    const stale = pruneByPath([...recs, rec]);
    for (const at of stale) await d.delete(STORE, [path, at]).catch(() => {});
    if (stale.length === 0) {
      const all = (await d.getAll(STORE)) as Snapshot[];
      for (const [p, at] of pruneGlobal(all)) await d.delete(STORE, [p, at]).catch(() => {});
    }
  } catch {
    /* 快照失败不影响主流程 */
  }
}

/** 某篇笔记的快照列表（新 → 旧） */
export async function listSnapshots(path: string): Promise<Snapshot[]> {
  try {
    const d = await db();
    const recs = (await d.transaction(STORE, 'readonly').store.index('path').getAll(path)) as Snapshot[];
    return recs.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** 全库快照去重后的路径列表（不区分是否仍存在，由调用方与 docs 对比） */
export async function listSnapshotPaths(): Promise<Map<string, number>> {
  try {
    const d = await db();
    const all = (await d.getAll(STORE)) as Snapshot[];
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
    return counts;
  } catch {
    return new Map();
  }
}
