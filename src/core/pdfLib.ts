/**
 * pdf.js 懒加载共享模块 + 最近使用的 PDF 持久化（IndexedDB 独立库 knowlattice-pdfs，
 * 避免与 vault 的 knowlattice 库版本冲突）。
 *
 * PDF.js 6 已统一为 ESM，worker 与 CMaps 仍随包复制到 public/pdfjs/：构建器对
 * `?url` 的处理不可靠，固定同源路径同时覆盖 Vite 开发、GitHub Pages 和 Tauri。
 */
import { openDB } from 'idb';
import * as pdfjsNs from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

let _pdfjs: typeof pdfjsNs | null = null;

/**
 * pdf.js 的 worker 地址。
 *
 * 指向 `public/pdfjs/pdf.worker.min.mjs`（由 scripts/copy-pdf-worker.mjs 在构建前同步），
 * 而不是 `import '...?url'`：当前 Rolldown 版 Vite 会把 pdfjs worker 的 `?url` 导入
 * 退化成副作用导入，模块拿不到 URL 字符串 —— 线上实测 workerSrc 为空串、worker 不加载，
 * PDF 面板静默渲染成一片空白。
 *
 * 用 BASE_URL 拼绝对路径，GitHub Pages 子路径部署同样成立。
 */
export function pdfWorkerSrc(): string {
  return `${import.meta.env.BASE_URL}pdfjs/pdf.worker.min.mjs`;
}

/**
 * pdf.js 的附加资源目录（必须带尾部斜杠：它直接拼 `${cMapUrl}${name}.bcmap`）。
 *
 * 中文 PDF 大多是 CID 字体 + 预定义 CMap（UniGB-UCS2-H、Adobe-GB1-x …）。缺这份映射时
 * getTextContent() 对这些文件返回空串：看得见的文字层读出来是空的，于是被判成扫描件、
 * 对照模式选不中字、能「打开 PDF 却不能摘录」。资源由 scripts/copy-pdf-worker.mjs 同步到 public/pdfjs/。
 */
export function pdfAssetUrl(kind: 'cmaps' | 'standard_fonts' | 'wasm' | 'iccs'): string {
  return `${import.meta.env.BASE_URL}pdfjs/${kind}/`;
}

/**
 * 每处 getDocument 都必须带上的参数。阅读器、智能草稿和转换入口共用这一份，
 * 避免漏配后中文文字层或替代字体行为不一致。
 */
export function pdfDocumentParams(): Pick<
  DocumentInitParameters,
  'cMapUrl' | 'cMapPacked' | 'standardFontDataUrl' | 'wasmUrl' | 'iccUrl'
> {
  return {
    cMapUrl: pdfAssetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfAssetUrl('standard_fonts'),
    wasmUrl: pdfAssetUrl('wasm'),
    iccUrl: pdfAssetUrl('iccs'),
  };
}

export async function loadPdfjs(): Promise<typeof pdfjsNs> {
  if (_pdfjs) return _pdfjs;
  pdfjsNs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
  _pdfjs = pdfjsNs;
  return _pdfjs;
}

/** 打开 PDF（File 或 ArrayBuffer）→ PDFDocumentProxy */
export async function openPdf(source: File | ArrayBuffer) {
  const pdfjs = await loadPdfjs();
  const data = source instanceof File ? await source.arrayBuffer() : source;
  return pdfjs.getDocument({ data, ...pdfDocumentParams() }).promise;
}

/**
 * 判断是不是「几乎没有文字层」的扫描件：采样首/中/尾几页取最大可提取字符数。
 * 注意：文字层顺序错乱（真正导致选字跳行的那种扫描件）无法靠字符数或顺序偏离可靠判别，
 * 所以这里只负责识别「基本选不了字」的情况，其余交给界面上的「按行选取」开关。
 * 调用方必须传副本——pdf.js 会 detach 掉传入的 ArrayBuffer。
 */
export async function detectScannedPdf(data: ArrayBuffer): Promise<boolean> {
  try {
    const doc = await openPdf(data);
    const total = doc.numPages;
    const targets = [...new Set([1, 2, Math.ceil(total / 2), total])]
      .filter((n) => n >= 1 && n <= total);
    let maxChars = 0;
    for (const p of targets) {
      const content = await (await doc.getPage(p)).getTextContent();
      const chars = (content.items as Array<{ str?: string }>).reduce(
        (n, it) => n + (it.str ?? '').replace(/\s/g, '').length, 0);
      if (chars > maxChars) maxChars = chars;
      if (maxChars >= 40) break; // 已有足够文字，不必再采样
    }
    await doc.loadingTask.destroy();
    return maxChars < 40;
  } catch {
    return false; // 判定失败时不改变默认行为
  }
}

const PDF_DB = 'knowlattice-pdfs';
/** 当前选中的书（books store 里的一条记录 id） */
const CURRENT_KEY = 'knowlattice-pdf-current';

export interface PdfBook {
  /** 文档名（去重也用它：同名视为同一本书，重选即覆盖） */
  name: string;
  /** 打开时间；书架上按它倒序排 */
  at: number;
  /** 上次读到第几页（1 基；0 表示还没记录） */
  page: number;
}

/** 随整包备份走的 PDF 条目；data 是 base64，缺失表示本机没有正文。 */
export interface PdfBookBackup extends PdfBook {
  data: string;
}

/** 和附件备份同一口径：单本 >20MB 或合计 >80MB 时不塞进 JSON，避免整包 OOM。 */
const PDF_BACKUP_BOOK_MAX = 20 * 1024 * 1024;
const PDF_BACKUP_TOTAL_MAX = 80 * 1024 * 1024;

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(data: string): ArrayBuffer | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function pdfDb() {
  return openDB(PDF_DB, 2, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
      if (oldVersion < 2 && !db.objectStoreNames.contains('books')) {
        // keyPath = name：打开同名文件即视为「这本书」，重选覆盖内容而不是新增一本
        db.createObjectStore('books', { keyPath: 'name' });
      }
    },
  });
}

/** 书架：按最近打开倒序。元数据不含正文，所以可以整个读出来渲染下拉 */
export async function listPdfBooks(): Promise<PdfBook[]> {
  try {
    const db = await pdfDb();
    const all = (await db.getAll('books')) as PdfBook[];
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** 当前这本书的书名。没有书时返回 null */
export async function getCurrentPdfName(): Promise<string | null> {
  try {
    const name = localStorage.getItem(CURRENT_KEY);
    if (!name) return null;
    const db = await pdfDb();
    return (await db.get('books', name)) ? name : null;
  } catch {
    return null;
  }
}

async function setCurrentPdfName(name: string | null) {
  try {
    if (name) localStorage.setItem(CURRENT_KEY, name);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* 存储不可用时只是记不住「上次打开哪本」，不影响阅读 */
  }
}

/** 存一本书的正文并把它设为当前书；返回这份书架的元数据 */
export async function putPdfBook(name: string, data: ArrayBuffer, at = Date.now()): Promise<PdfBook> {
  const book: PdfBook = { name, at, page: 0 };
  const db = await pdfDb();
  await db.put('pdfs', { name, data }, name);
  await db.put('books', book);
  await setCurrentPdfName(name);
  return book;
}

/** 读一本书的正文 + 元数据（正文不在 books 里，单独读，避免书架列表把整本书读进内存） */
export async function getPdfBook(name: string): Promise<{ name: string; data: ArrayBuffer; page: number } | null> {
  const db = await pdfDb();
  const meta = (await db.get('books', name)) as PdfBook | undefined;
  const rec = (await db.get('pdfs', name)) as { name: string; data: ArrayBuffer } | undefined;
  if (!meta || !rec) return null;
  return { name, data: rec.data, page: meta.page ?? 0 };
}

/** 导出 PDF 书架正文与页码；超限的书记入 skipped，由界面提示改走文件夹备份。 */
export async function exportPdfLibrary(): Promise<{ books: PdfBookBackup[]; skipped: number }> {
  const books: PdfBookBackup[] = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const meta of await listPdfBooks()) {
    const rec = await getPdfBook(meta.name);
    if (!rec) continue;
    const size = rec.data.byteLength;
    if (size > PDF_BACKUP_BOOK_MAX || totalBytes + size > PDF_BACKUP_TOTAL_MAX) {
      skipped += 1;
      continue;
    }
    books.push({ ...meta, data: arrayBufferToBase64(rec.data) });
    totalBytes += size;
  }
  return { books, skipped };
}

/** 恢复 PDF 书架：同名书保留本机版本，只补缺失的书；返回新增/保留/失败计数。 */
export async function importPdfLibrary(entries: unknown): Promise<{ added: number; kept: number; failed: number }> {
  if (!Array.isArray(entries)) return { added: 0, kept: 0, failed: 0 };
  const db = await pdfDb();
  const tx = db.transaction(['pdfs', 'books'], 'readwrite');
  const bookStore = tx.objectStore('books');
  const existing = new Set(((await bookStore.getAll()) as PdfBook[]).map((b) => b.name));
  let added = 0;
  let kept = 0;
  let failed = 0;
  let newestAdded: PdfBook | null = null;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { failed += 1; continue; }
    const e = raw as Partial<PdfBookBackup>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const data = typeof e.data === 'string' ? base64ToArrayBuffer(e.data) : null;
    const at = Number(e.at);
    const page = Number(e.page);
    if (!name || !data || !Number.isFinite(at) || !Number.isFinite(page)) { failed += 1; continue; }
    if (existing.has(name)) { kept += 1; continue; }
    const book: PdfBook = { name, at, page: Math.max(0, Math.floor(page)) };
    tx.objectStore('pdfs').put({ name, data }, name);
    bookStore.put(book);
    existing.add(name);
    added += 1;
    if (!newestAdded || book.at > newestAdded.at) newestAdded = book;
  }
  await tx.done;
  if (added > 0 && (await getCurrentPdfName()) === null) {
    await setCurrentPdfName(newestAdded?.name ?? null);
  }
  return { added, kept, failed };
}

/** 记下某本书读到第几页（1 基），用于切回去时恢复位置 */
export async function savePdfPage(name: string, page: number) {
  try {
    const db = await pdfDb();
    const meta = (await db.get('books', name)) as PdfBook | undefined;
    if (meta) await db.put('books', { ...meta, page });
  } catch {
    /* 记不住进度不影响使用 */
  }
}

/** 从书架移除一本书（正文一并删掉）。若删的是当前书，当前指针回落到最近打开的一本 */
export async function removePdfBook(name: string): Promise<PdfBook[]> {
  const db = await pdfDb();
  await db.delete('pdfs', name);
  await db.delete('books', name);
  const rest = await listPdfBooks();
  if ((await getCurrentPdfName()) === null) {
    await setCurrentPdfName(rest[0]?.name ?? null);
  }
  return rest;
}

/** 标记某本书为当前（切换书籍时用） */
export async function setCurrentPdfBook(name: string) {
  await setCurrentPdfName(name);
}

/**
 * 迁移旧的单本存储（`pdfs.current`）：把它并入书架并清掉旧键。
 * 老用户第一次打开新版时，手上那本书不该丢。
 */
export async function migrateLegacyPdf(): Promise<void> {
  try {
    const db = await pdfDb();
    const legacy = (await db.get('pdfs', 'current')) as { name: string; data: ArrayBuffer } | undefined;
    if (!legacy) return;
    await db.put('pdfs', legacy, legacy.name);
    await db.put('books', { name: legacy.name, at: Date.now(), page: 0 });
    await db.delete('pdfs', 'current');
    await setCurrentPdfName(legacy.name);
  } catch {
    /* 迁移失败不影响新书架的使用 */
  }
}
