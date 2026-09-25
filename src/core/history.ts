/**
 * 笔记历史快照（IndexedDB 独立库 knowlattice-history，与 knowlattice / knowlattice-pdfs 互不干扰）：
 * - 每次保存后异步推入一条全量快照（纯文本体积小；同一内容不重复推）
 * - 每篇笔记保留最近 10 条；全库快照总量超上限时清理最旧的（防止单库无限膨胀）
 * - 删除笔记时不清理快照 → 误删的笔记可从「历史版本」面板找回
 * 纯函数部分（pruneByPath / pruneGlobal）可单测，IndexedDB 仅在浏览器中可用。
 */

import { openDB, type IDBPDatabase } from 'idb';

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

/** 连接缓存：openDB 每次都会发起一次 indexedDB.open，原来每次保存/列快照
 *  都开新连接（旧连接等 GC）。模块级单例即可——fake-indexeddb 与 jsdom 下同样成立。 */
let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: ['path', 'at'] });
          store.createIndex('path', 'path');
          store.createIndex('at', 'at');
        }
      },
    }).catch((e) => {
      // 打开失败不缓存失败态：下次调用重试，而不是永远返回同一个 rejection
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
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

/**
 * 该篇最新一条快照：path 索引 + 倒序游标的第一条（主键 [path, at] 同 path 内按
 * at 升序，倒序即最新）。只物化 1 条记录——原来 getAll(path) 把该篇全部快照的
 * 完整正文都读出来，只为看最新那一条。
 */
async function latestSnapshot(d: IDBPDatabase, path: string): Promise<Snapshot | undefined> {
  const cursor = await d.transaction(STORE, 'readonly').store.index('path').openCursor(path, 'prev');
  return cursor?.value as Snapshot | undefined;
}

/** 删指定的快照主键（单事务批量提交，替代原来逐条 await 的串行事务） */
async function deleteKeys(d: IDBPDatabase, keys: Array<[string, number]>): Promise<void> {
  if (!keys.length) return;
  const tx = d.transaction(STORE, 'readwrite');
  for (const key of keys) void tx.store.delete(key);
  await tx.done.catch(() => { /* 单条失败静默，与旧行为一致 */ });
}

/**
 * 保存成功后调用：内容与最新快照相同则跳过；fire-and-forget，不阻塞保存。
 *
 * 清理策略与旧版等价（单篇保留最近 keep 条 / 全库超上限删最旧），但判定全部
 * 改为 O(1) 的 count：只有真正超限（真正要删东西）时才走游标收集待删键——
 * 键游标（openKeyCursor）不物化记录正文。旧版在「该篇不足 keep 条」这一常态
 * 分支里 getAll 整个快照库（最多 600 条完整正文）到主线程，只为算出「没超上限」。
 */
export async function pushSnapshot(path: string, content: string): Promise<void> {
  try {
    const d = await db();
    const latest = await latestSnapshot(d, path);
    if (latest && latest.content === content) return; // 同内容不重复推
    const rec: Snapshot = { path, at: Date.now(), content };
    await d.put(STORE, rec);

    // 单篇超额：该篇快照数 > keep 时，删最旧的差额条（path 索引正序键游标）
    const perPath = await d.transaction(STORE, 'readonly').store.index('path').count(path);
    if (perPath > KEEP_PER_PATH) {
      const doomed: Array<[string, number]> = [];
      let cursor = await d.transaction(STORE, 'readonly').store.index('path').openKeyCursor(path);
      while (cursor && doomed.length < perPath - KEEP_PER_PATH) {
        doomed.push(cursor.primaryKey as [string, number]);
        cursor = await cursor.continue();
      }
      await deleteKeys(d, doomed);
    }

    // 全库超额：总数 > cap 时，按 at 索引正序（最旧在前）删差额条
    const total = await d.count(STORE);
    if (total > GLOBAL_CAP) {
      const doomed: Array<[string, number]> = [];
      let cursor = await d.transaction(STORE, 'readonly').store.index('at').openKeyCursor();
      while (cursor && doomed.length < total - GLOBAL_CAP) {
        doomed.push(cursor.primaryKey as [string, number]);
        cursor = await cursor.continue();
      }
      await deleteKeys(d, doomed);
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
    const counts = new Map<string, number>();
    // 键游标只取索引键（路径），不物化记录正文——旧版 getAll 全库只为数个数
    let cursor = await d.transaction(STORE, 'readonly').store.index('path').openKeyCursor();
    while (cursor) {
      const p = cursor.key as string;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      cursor = await cursor.continue();
    }
    return counts;
  } catch {
    return new Map();
  }
}
