/**
 * 开发期存储适配器：IndexedDB（浏览器直接可用，无需任何后端）。
 * 数据模型：
 * - objectStore "files"：vault 相对路径 → 笔记字符串（keyPath = path）
 * - objectStore "attachments"：vault 相对路径 → Blob（keyPath = path）
 * 二进制附件与文本笔记分库，避免启动/保存时把大图片读进 docs Map。
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { StorageAdapter, VaultFileMeta } from './adapter';

const DB_NAME = 'knowlattice';
const DB_VERSION = 2;

const textEncoder = new TextEncoder();

interface FileRecord {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

interface AttachmentRecord {
  path: string;
  blob: Blob;
  mtime: number;
  size: number;
}

export class WebAdapter implements StorageAdapter {
  readonly name = 'indexeddb';
  private db: IDBPDatabase | null = null;

  private async getDB(): Promise<IDBPDatabase> {
    if (!this.db) {
      this.db = await openDB(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1 && !db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'path' });
          }
          if (oldVersion < 2 && !db.objectStoreNames.contains('attachments')) {
            db.createObjectStore('attachments', { keyPath: 'path' });
          }
        },
      });
    }
    return this.db;
  }

  async listAll(): Promise<VaultFileMeta[]> {
    const db = await this.getDB();
    const all: FileRecord[] = await db.getAll('files');
    return all.map(({ path, mtime, size }) => ({ path, mtime, size }));
  }

  /** 单遍读出全部笔记：getAll 本来就会反序列化整条记录，
   *  直接复用 content，避免旧版「listAll + 逐条 read」把全库读两遍。 */
  async readAll(): Promise<Map<string, string>> {
    const db = await this.getDB();
    const all: FileRecord[] = await db.getAll('files');
    return new Map(all.map((r) => [r.path, r.content]));
  }

  async read(path: string): Promise<string> {
    const db = await this.getDB();
    const rec: FileRecord | undefined = await db.get('files', path);
    return rec?.content ?? '';
  }

  async exists(path: string): Promise<boolean> {
    const db = await this.getDB();
    return (await db.get('files', path)) !== undefined;
  }

  async write(path: string, content: string): Promise<void> {
    const db = await this.getDB();
    const rec: FileRecord = {
      path,
      content,
      mtime: Date.now(),
      size: textEncoder.encode(content).length,
    };
    await db.put('files', rec);
  }

  /** 一批一个事务：导入/恢复几千篇时，原来每篇一个独立事务（每次都走完整的
   *  事务提交协议），这是「导入转圈」时间的主要成分。事务失败整体抛出，
   *  由调用方退回逐条重写以精确定位失败文件。 */
  async writeMany(entries: Array<{ path: string; content: string }>): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction('files', 'readwrite');
    const now = Date.now();
    for (const e of entries) {
      void tx.store.put({ path: e.path, content: e.content, mtime: now, size: textEncoder.encode(e.content).length });
    }
    await tx.done;
  }

  async remove(path: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('files', path);
  }

  /** 一批一个事务删除（同 writeMany 的合批理由） */
  async removeMany(paths: string[]): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction('files', 'readwrite');
    for (const p of paths) void tx.store.delete(p);
    await tx.done;
  }

  /** 一次读出全部附件 {path → Blob}。Blob 是惰性句柄，不会把全部字节读进内存。 */
  async readAllAttachments(): Promise<Map<string, Blob>> {
    const db = await this.getDB();
    const all: AttachmentRecord[] = await db.getAll('attachments');
    return new Map(all.map((r) => [r.path, r.blob]));
  }

  async writeAttachment(path: string, blob: Blob): Promise<void> {
    const db = await this.getDB();
    const rec: AttachmentRecord = {
      path,
      blob,
      mtime: Date.now(),
      size: blob.size,
    };
    await db.put('attachments', rec);
  }

  async removeAttachment(path: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('attachments', path);
  }
}
