/**
 * 医学教材索引的本地存储（IndexedDB，独立库 knowlattice-medbooks）。
 *
 * 与 PDF 书架（knowlattice-pdfs）分开：书架面向「阅读最近一本书」，会随打开动作重排；
 * 教材库面向「长期可检索的语料」，只随导入/删除变化，两者生命周期不同。
 *
 * meta 与 text 分两个 store：清单只读 meta（几十条），全文只在检索/导入时按需读，
 * 避免每次打开设置都把几十 MB 教材正文读进内存。
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { MedBookInfo } from '../core/medIndex';

const DB = 'knowlattice-medbooks';
const VERSION = 1;

export interface MedBookMeta {
  /** 教材名（主键，= 文件名去扩展名） */
  name: string;
  /** 总页数 */
  pages: number;
  /** 有文字的页数 */
  extractablePages: number;
  /** 正文字符数（展示用，也用来估体积） */
  chars: number;
  /** 导入时间（ms），清单按它倒序 */
  at: number;
}

async function db(): Promise<IDBPDatabase> {
  return openDB(DB, VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'name' });
      if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
    },
  });
}

/** 教材清单（不含正文），按导入时间倒序 */
export async function listMedBookRecords(): Promise<MedBookMeta[]> {
  try {
    const d = await db();
    const all = (await d.getAll('meta')) as MedBookMeta[];
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** 教材清单（面向工具展示的最小字段） */
export async function listMedBookMeta(): Promise<MedBookInfo[]> {
  const rows = await listMedBookRecords();
  return rows.map((r) => ({ title: r.name, pages: r.pages, extractablePages: r.extractablePages }));
}

/** 读回全部教材正文（供检索）。仅在需要全文时调用。 */
export async function getMedBookTexts(): Promise<Array<{ name: string; text: string }>> {
  const metas = await listMedBookRecords();
  const d = await db();
  const out: Array<{ name: string; text: string }> = [];
  for (const m of metas) {
    const text = (await d.get('texts', m.name)) as string | undefined;
    if (text) out.push({ name: m.name, text });
  }
  return out;
}

/** 是否已存在同名教材（同名导入会覆盖，导入方据此提示） */
export async function hasMedBook(name: string): Promise<boolean> {
  try {
    const d = await db();
    return (await d.get('meta', name)) !== undefined;
  } catch {
    return false;
  }
}

/** 写入/覆盖一本教材（同名覆盖）。 */
export async function putMedBook(rec: MedBookMeta & { text: string }): Promise<void> {
  const { text, ...meta } = rec;
  const d = await db();
  await d.put('meta', meta);
  await d.put('texts', text, rec.name);
}

/** 删除一本教材（meta 与正文一并删）。 */
export async function removeMedBook(name: string): Promise<void> {
  const d = await db();
  await d.delete('meta', name);
  await d.delete('texts', name);
}
