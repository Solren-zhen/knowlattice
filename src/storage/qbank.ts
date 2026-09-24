import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'knowlattice-qbank';
const DB_VERSION = 1;

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
  const tx = db.transaction(['banks', 'stats'], 'readwrite');
  await tx.objectStore('banks').delete(bank);
  const store = tx.objectStore('stats');
  const index = store.index('bank');
  let cursor = await index.openKeyCursor(IDBKeyRange.only(bank));
  while (cursor) {
    await store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
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
  const tx = db.transaction(['banks', 'stats', 'meta'], 'readwrite');
  tx.objectStore('banks').clear();
  tx.objectStore('stats').clear();
  tx.objectStore('meta').clear();
  await tx.done;
}

export async function clearQbankDatabase(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['banks', 'stats', 'meta'], 'readwrite');
  await Promise.all([
    tx.objectStore('banks').clear(),
    tx.objectStore('stats').clear(),
    tx.objectStore('meta').clear(),
  ]);
  await tx.done;
}
