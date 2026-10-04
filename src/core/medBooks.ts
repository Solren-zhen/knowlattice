/**
 * 医学教材库：面板助手查询本机教材的入口。
 *
 * 教材正文与页码锚点全部存在本机（IndexedDB，见 storage/medStore.ts），
 * 本模块把「读库 + 检索 + 排版」拼成几个可直接调用的小函数，并缓存已读入的正文，
 * 避免每次检索都重读一遍 IndexedDB。纯检索逻辑见 core/medIndex.ts。
 */
import { listMedBookMeta, listMedBookRecords, getMedBookTexts, removeMedBook, type MedBookMeta } from '../storage/medStore';
import {
  formatMedBooks, formatMedHits, searchMedBooks,
  type MedBookHit, type MedBookInfo,
} from './medIndex';

export { formatMedBooks, formatMedHits };
export type { MedBookHit, MedBookInfo, MedBookMeta };

/** 已读入内存的教材正文缓存；导入/删除后必须失效 */
let fullTextCache: Array<{ name: string; text: string }> | null = null;
/** 正在进行的全文读取：并发检索共享同一次 IndexedDB 读，避免重复加载几十 MB */
let fullTextLoading: Promise<Array<{ name: string; text: string }>> | null = null;

export function invalidateMedBooksCache(): void {
  fullTextCache = null;
  fullTextLoading = null;
}

/** 教材清单（不含正文） */
export async function medBooksList(): Promise<MedBookInfo[]> {
  return listMedBookMeta();
}

/** 教材管理列表（含页数/字符数/导入时间），供设置页展示 */
export async function medBookRecords(): Promise<MedBookMeta[]> {
  return listMedBookRecords();
}

/** 检索教材：先读回全文（有缓存；并发请求共享同一次读库），再走纯检索 */
export async function medBooksSearch(query: string, limit = 6, book?: string): Promise<MedBookHit[]> {
  if (fullTextCache === null) {
    fullTextLoading ??= getMedBookTexts().then((texts) => {
      fullTextCache = texts;
      fullTextLoading = null;
      return texts;
    });
    await fullTextLoading;
  }
  return searchMedBooks(fullTextCache!, query, limit, book);
}

/** 删除一本教材并使缓存失效 */
export async function medBookRemove(name: string): Promise<void> {
  await removeMedBook(name);
  invalidateMedBooksCache();
}
