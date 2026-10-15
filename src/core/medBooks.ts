/**
 * 医学教材库：面板助手查询本机教材的入口。
 *
 * 教材正文与页码锚点全部存在本机（IndexedDB，见 storage/medStore.ts），
 * 本模块把「读库 + 检索 + 排版」拼成几个可直接调用的小函数，并缓存已读入的正文
 * （连同小写副本与页码偏移，检索与整页阅读共用一份缓存），
 * 避免每次检索都重读一遍 IndexedDB。纯检索逻辑见 core/medIndex.ts。
 */
import { listMedBookMeta, listMedBookRecords, getMedBookTexts, removeMedBook, type MedBookMeta } from '../storage/medStore';
import {
  bookMatches, extractPage, formatMedBooks, formatMedHits, printedPage, searchMedBooks,
  type MedBookHit, type MedBookInfo,
} from './medIndex';

export { formatMedBooks, formatMedHits };
export type { MedBookHit, MedBookInfo, MedBookMeta };

/** 已读入内存的教材缓存（正文 + 小写副本）；导入/删除后必须失效 */
interface CachedBook { name: string; text: string; lower: string }
let fullTextCache: CachedBook[] | null = null;
/** 正在进行的全文读取：并发检索共享同一次 IndexedDB 读，避免重复加载几十 MB */
let fullTextLoading: Promise<CachedBook[] | null> | null = null;
/** 缓存代际：失效时自增。在途读库回来时若代际已变，说明期间导入/删除了教材，
 *  那份 texts 是旧的——既不能写回缓存，也不能拿去检索。 */
let cacheGen = 0;

export function invalidateMedBooksCache(): void {
  cacheGen++;
  fullTextCache = null;
  fullTextLoading = null;
}

/** 读回全文（含小写副本）：命中缓存直接返回；否则共享一次读库。失效发生在等待期间时返回 null，由调用方重读。 */
async function loadFullText(): Promise<CachedBook[] | null> {
  if (fullTextCache !== null) return fullTextCache;
  const gen = cacheGen;
  const pending = (fullTextLoading ??= getMedBookTexts().then((texts) => {
    const books = texts.map((t) => ({ name: t.name, text: t.text, lower: t.text.toLowerCase() }));
    if (gen === cacheGen) fullTextCache = books;
    return books;
  }).catch((e) => {
    // 读库失败必须复位在途 Promise：否则这个已 reject 的 Promise 会被后续每次
    // loadFullText 反复复用，教材检索在本次会话内彻底起不来（同 history.ts / storage/qbank.ts 的处理）。
    fullTextLoading = null;
    throw e;
  }));
  const texts = await pending;
  if (fullTextLoading === pending) fullTextLoading = null;
  // 期间被失效（导入/删除了教材）：这次读到的是旧内容，丢弃让调用方重读
  return gen === cacheGen ? texts : null;
}

/** 教材清单（不含正文） */
export async function medBooksList(): Promise<MedBookInfo[]> {
  return listMedBookMeta();
}

/** 教材管理列表（含页数/字符数/导入时间/页码偏移），供设置页展示与编辑 */
export async function medBookRecords(): Promise<MedBookMeta[]> {
  return listMedBookRecords();
}

/** 检索教材：先读回全文（有缓存；并发请求共享同一次读库），再走纯检索。
 *  页码偏移随书传入，命中里的页码已换算成印刷页。
 *  等待期间缓存被失效时重读一次，避免「刚导入的教材查不到 / 已删的教材还能搜到」。 */
export async function medBooksSearch(query: string, limit = 6, book?: string): Promise<MedBookHit[]> {
  for (let attempt = 0; ; attempt++) {
    const [texts, records] = await Promise.all([loadFullText(), listMedBookRecords()]);
    if (texts) {
      const offsets = new Map(records.map((r) => [r.name, r.pageOffset ?? 0]));
      return searchMedBooks(
        texts.map((t) => ({ ...t, pageOffset: offsets.get(t.name) ?? 0 })),
        query, limit, book,
      );
    }
    if (attempt >= 2) throw new Error('教材库正在更新，请稍后重试。');
  }
}

/** 按书名关键字找缓存里的教材（找不到返回 null） */
async function findCachedBook(wanted: string): Promise<CachedBook | null> {
  for (let attempt = 0; ; attempt++) {
    const texts = await loadFullText();
    if (texts) {
      const hit = texts.find((t) => bookMatches(t.name, wanted));
      return hit ?? null;
    }
    if (attempt >= 2) throw new Error('教材库正在更新，请稍后重试。');
  }
}

/**
 * 读某本教材的一整页：wanted 是书名关键字，page 是印刷页码
 * （与检索结果里显示的页码同口径），内部按该书的页码偏移换算成 PDF 物理页再取原文。
 * 找不到书或页返回 null。
 */
export async function medBookPage(
  wanted: string, page: number
): Promise<{ book: string; printed: number; pdfPage: number; text: string } | null> {
  if (!wanted.trim() || !Number.isFinite(page) || page < 1) return null;
  const [hit, records] = await Promise.all([findCachedBook(wanted), listMedBookRecords()]);
  if (!hit) return null;
  const offset = records.find((r) => r.name === hit.name)?.pageOffset ?? 0;
  // 印刷页 → 物理页：检索结果把物理页减了偏移（下限 1），这里加回去。
  // 偏移为 0 时两者相同；反推可能出现重号（第 1 页之前的都压在 1），直接按物理页 = 印刷 + 偏移取。
  const pdfPage = page + Math.max(0, offset);
  const text = extractPage(hit.text, pdfPage);
  if (text === null) return null;
  return { book: hit.name, printed: page, pdfPage, text };
}

/** 读某本教材的全文（引文核验兜底用；找不到书返回 null）。 */
export async function medBookFullText(wanted: string): Promise<{ book: string; text: string } | null> {
  const hit = await findCachedBook(wanted);
  return hit ? { book: hit.name, text: hit.text } : null;
}

/** 物理页 → 印刷页（展示某本书的页码时用） */
export { printedPage };

/** 删除一本教材并使缓存失效 */
export async function medBookRemove(name: string): Promise<void> {
  await removeMedBook(name);
  invalidateMedBooksCache();
}
