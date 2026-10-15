import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'knowlattice-qbank';
// v2：新增 stars 对象仓库（收藏/重点题）。升级只加仓库、不动旧数据，
// 老库打开时按 upgrade 里的 contains 判断补建，历史题库与逐题统计原样保留。
const DB_VERSION = 2;

export interface StoredBank {
  name: string;
  importedAt: number;
  questions: unknown[];
}

export interface StoredQuestionStat {
  bank: string;
  qid: string;
  tuple: number[];
}

/** 收藏/重点题：只存「这道题被标了」，没有值可言，keyPath 即身份。 */
export interface StoredStar {
  bank: string;
  qid: string;
}

interface MetaRecord {
  key: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('banks')) db.createObjectStore('banks', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('stats')) {
          const stats = db.createObjectStore('stats', { keyPath: ['bank', 'qid'] });
          stats.createIndex('bank', 'bank');
        }
        if (!db.objectStoreNames.contains('stars')) {
          const stars = db.createObjectStore('stars', { keyPath: ['bank', 'qid'] });
          stars.createIndex('bank', 'bank');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      },
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

export async function getAllBanks(): Promise<StoredBank[]> {
  const banks = await (await getDB()).getAll('banks') as StoredBank[];
  return banks.sort((a, b) => b.importedAt - a.importedAt);
}

export async function putBank(bank: StoredBank): Promise<void> {
  await (await getDB()).put('banks', bank);
}

export async function putBanks(banks: StoredBank[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('banks', 'readwrite');
  for (const bank of banks) tx.store.put(bank);
  await tx.done;
}

export async function removeBankAndStats(bank: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['banks', 'stats', 'stars'], 'readwrite');
  await tx.objectStore('banks').delete(bank);
  for (const name of ['stats', 'stars'] as const) {
    const store = tx.objectStore(name);
    const index = store.index('bank');
    let cursor = await index.openKeyCursor(IDBKeyRange.only(bank));
    while (cursor) {
      await store.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// ---------- 收藏 / 重点题 ----------

export async function getAllStars(): Promise<StoredStar[]> {
  return (await getDB()).getAll('stars') as Promise<StoredStar[]>;
}

export async function putStar(star: StoredStar): Promise<void> {
  await (await getDB()).put('stars', star);
}

export async function removeStar(bank: string, qid: string): Promise<void> {
  await (await getDB()).delete('stars', [bank, qid]);
}

export async function removeBankStars(bank: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stars', 'readwrite');
  const store = tx.store;
  const index = store.index('bank');
  let cursor = await index.openKeyCursor(IDBKeyRange.only(bank));
  while (cursor) {
    await store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function replaceStars(stars: StoredStar[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stars', 'readwrite');
  const store = tx.objectStore('stars');
  await store.clear();
  for (const star of stars) store.put(star);
  await tx.done;
}

export async function migrateLegacyBanks(banks: StoredBank[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['banks', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  const migrated = (await meta.get('legacy-banks-v1')) as MetaRecord | undefined;
  if (!migrated) {
    const store = tx.objectStore('banks');
    const existing = new Set((await store.getAllKeys()).map(String));
    for (const bank of banks) {
      if (!existing.has(bank.name)) {
        store.put(bank);
        existing.add(bank.name);
      }
    }
    meta.put({ key: 'legacy-banks-v1' });
  }
  await tx.done;
}

export async function getAllQuestionStats(): Promise<StoredQuestionStat[]> {
  return (await getDB()).getAll('stats') as Promise<StoredQuestionStat[]>;
}

export async function getQuestionStat(bank: string, qid: string): Promise<StoredQuestionStat | undefined> {
  return (await getDB()).get('stats', [bank, qid]) as Promise<StoredQuestionStat | undefined>;
}

export async function putQuestionStat(stat: StoredQuestionStat): Promise<void> {
  await (await getDB()).put('stats', stat);
}

export async function removeQuestionStats(bank: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stats', 'readwrite');
  const store = tx.store;
  const index = store.index('bank');
  let cursor = await index.openKeyCursor(IDBKeyRange.only(bank));
  while (cursor) {
    await store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function replaceQuestionStats(stats: StoredQuestionStat[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stats', 'readwrite');
  const store = tx.objectStore('stats');
  await store.clear();
  for (const stat of stats) store.put(stat);
  await tx.done;
}

export async function migrateLegacyQuestionStats(stats: StoredQuestionStat[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['stats', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  const migrated = (await meta.get('legacy-stats-v1')) as MetaRecord | undefined;
  if (!migrated) {
    const store = tx.objectStore('stats');
    const existing = new Set((await store.getAllKeys()).map((key) => JSON.stringify(key)));
    for (const stat of stats) {
      const key = JSON.stringify([stat.bank, stat.qid]);
      if (!existing.has(key)) {
        store.put(stat);
        existing.add(key);
      }
    }
    meta.put({ key: 'legacy-stats-v1' });
  }
  await tx.done;
}

export async function resetQbankStorageForTests(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['banks', 'stats', 'stars', 'meta'], 'readwrite');
  tx.objectStore('banks').clear();
  tx.objectStore('stats').clear();
  tx.objectStore('stars').clear();
  tx.objectStore('meta').clear();
  await tx.done;
}

export async function clearQbankDatabase(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['banks', 'stats', 'stars', 'meta'], 'readwrite');
  await Promise.all([
    tx.objectStore('banks').clear(),
    tx.objectStore('stats').clear(),
    tx.objectStore('stars').clear(),
    tx.objectStore('meta').clear(),
  ]);
  await tx.done;
}
