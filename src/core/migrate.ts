/**
 * 一次性本地标识迁移：把旧版以 medvault 命名的 localStorage 键与 IndexedDB 库统一到 knowlattice。
 *
 * 策略：先把旧数据复制到新名字，确认新数据就位后再删旧的；任何一步失败都保留旧数据。
 * 幂等：新键 / 新库已存在则跳过，可安全重复执行。
 */

const OLD_PREFIX = 'medvault-';
const NEW_PREFIX = 'knowlattice-';

/** localStorage：medvault-* → knowlattice-*。同步执行，必须早于任何读取主题 / 进度 / 打卡的代码。 */
export function migrateLocalStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OLD_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const next = NEW_PREFIX + k.slice(OLD_PREFIX.length);
      if (localStorage.getItem(next) === null) {
        const v = localStorage.getItem(k);
        if (v !== null) localStorage.setItem(next, v);
      }
      localStorage.removeItem(k);
    }
  } catch {
    /* localStorage 不可用（隐私模式等）：忽略，不影响启动 */
  }
}

/** 旧库名 → 新库名 */
const DB_PAIRS: Array<[string, string]> = [
  ['medvault', 'knowlattice'],
  ['medvault-history', 'knowlattice-history'],
  ['medvault-pdfs', 'knowlattice-pdfs'],
];

interface StoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
}

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** 打开已存在的库；库不存在时返回 null（并清理探测过程中新建的空库）。 */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const r = indexedDB.open(name);
    let created = false;
    r.onupgradeneeded = () => { created = true; };
    r.onsuccess = () => {
      const db = r.result;
      if (created || db.objectStoreNames.length === 0) {
        db.close();
        if (created) indexedDB.deleteDatabase(name);
        resolve(null);
      } else {
        resolve(db);
      }
    };
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  });
}

async function dbExists(name: string): Promise<boolean> {
  const withList = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof withList.databases === 'function') {
    try {
      const list = await withList.databases();
      return list.some((d) => d.name === name);
    } catch {
      /* 落到下面的探测 */
    }
  }
  const db = await openExisting(name);
  if (!db) return false;
  db.close();
  return true;
}

/** 把 oldName 的结构与全部记录复制到 newName，成功后才删除 oldName。 */
async function copyDb(oldName: string, newName: string): Promise<void> {
  const oldDb = await openExisting(oldName);
  if (!oldDb) return;

  // 旧库结构与记录先整体读出：新建与「补齐半成品」两条路径都要用
  const schemas: StoreSchema[] = [];
  const records = new Map<string, unknown[]>();
  for (const name of Array.from(oldDb.objectStoreNames)) {
    const store = oldDb.transaction(name, 'readonly').objectStore(name);
    schemas.push({
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames).map((n) => {
        const ix = store.index(n);
        return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      }),
    });
    records.set(name, await request(store.getAll()));
  }
  const version = oldDb.version;
  oldDb.close();

  if (await dbExists(newName)) {
    // 「新库存在」≠「迁移完成」：上次复制半途失败留下的半成品库、或 8 秒超时期间
    // 应用先挂载建出的空库，都会卡在这里。按逐 store 记录数校验，缺了就补齐——
    // put 按主键覆盖，迁移期间应用已写入的新记录不会被清掉。
    await patchPartialCopy(newName, schemas, records);
  } else {
    await createAndFill(newName, version, schemas, records);
  }

  // 复制成功后才删旧库；被其它标签页占用（blocked）就留着，下次启动再删
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(oldName);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
}

/** 新库已存在时按记录数校验完整性，缺哪个 store 就把旧记录 put 回去补齐。 */
async function patchPartialCopy(
  newName: string,
  schemas: StoreSchema[],
  records: Map<string, unknown[]>,
): Promise<void> {
  const newDb = await openExisting(newName);
  if (!newDb) return; // 被占用/打不开：本轮放弃，旧库保留，下次启动再试
  try {
    const have = new Set(Array.from(newDb.objectStoreNames));
    for (const sc of schemas) {
      if (!have.has(sc.name)) {
        // schema 对不上（新库版本更高且没有这个 store）：没法无版本升级地补，留待人工
        console.warn(`迁移 ${newName}：新库缺少 store「${sc.name}」，本轮跳过（旧库保留）`);
        continue;
      }
      const count = await request(newDb.transaction(sc.name, 'readonly').objectStore(sc.name).count());
      if (count >= (records.get(sc.name)?.length ?? 0)) continue; // 这个 store 已完整
      const tx = newDb.transaction(sc.name, 'readwrite');
      const store = tx.objectStore(sc.name);
      for (const rec of records.get(sc.name) ?? []) store.put(rec);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
  } finally {
    newDb.close();
  }
}

/** 新库不存在：按旧库版本号建库、灌入全部记录。 */
async function createAndFill(
  newName: string,
  version: number,
  schemas: StoreSchema[],
  records: Map<string, unknown[]>,
): Promise<void> {
  const newDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(newName, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const sc of schemas) {
        const opts: IDBObjectStoreParameters = { autoIncrement: sc.autoIncrement };
        if (sc.keyPath !== null) opts.keyPath = sc.keyPath;
        const store = db.createObjectStore(sc.name, opts);
        for (const ix of sc.indexes) {
          store.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`open ${newName} blocked`));
  });

  for (const sc of schemas) {
    const tx = newDb.transaction(sc.name, 'readwrite');
    const store = tx.objectStore(sc.name);
    for (const rec of records.get(sc.name) ?? []) store.put(rec);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  newDb.close();
}

/** 迁移三个 IndexedDB 库。必须早于 vault / 历史 / PDF 首次打开新库，否则会读到空库。 */
export async function migrateIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  for (const [oldName, newName] of DB_PAIRS) {
    try {
      await copyDb(oldName, newName);
    } catch {
      /* 单个库失败不影响其它库；旧数据仍在 */
    }
  }
}
