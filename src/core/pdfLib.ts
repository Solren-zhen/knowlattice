/**
 * pdf.js 懒加载共享模块 + 最近使用的 PDF 持久化（IndexedDB 独立库 knowlattice-pdfs，
 * 避免与 vault 的 knowlattice 库版本冲突）。
 *
 * 版本必须停在 3.x：
 * - @react-pdf-viewer/core@3.12 只认 pdfjs 的 `renderTextLayer` / `SVGGraphics` 两个具名导出；
 * - pdfjs 4.x 已把这两个 API 删除（改用 TextLayer 类），viewer 调用即失败 →
 *   PDF 面板静默渲染成一片空白，控制台连报错都没有。
 * 3.x 是 UMD 产物，浏览器里 `import('pdfjs-dist')` 拿不到具名导出，因此下面走 cjs 入口
 * 并在 vite.config 的 optimizeDeps 里显式声明，让 Vite 做 CJS → ESM 互操作。
 */
import { openDB } from 'idb';
// 走包入口（vite.config 里把 'pdfjs-dist' alias 到 3.x 的 build/pdf.js），
// 与 @react-pdf-viewer/core 内部 require 的是同一份，worker 配置才生效。
import * as pdfjsNs from 'pdfjs-dist';
import { installPdfIntersectionFallback } from './pdfio';

let _pdfjs: any = null;

/**
 * pdf.js 的 worker 地址。
 *
 * 指向 `public/pdfjs/pdf.worker.min.js`（由 scripts/copy-pdf-worker.mjs 在构建前同步），
 * 而不是 `import '...?url'`：当前 Rolldown 版 Vite 会把 pdfjs worker 的 `?url` 导入
 * 退化成副作用导入，模块拿不到 URL 字符串 —— 线上实测 workerSrc 为空串、worker 不加载，
 * PDF 面板静默渲染成一片空白。
 *
 * 用 BASE_URL 拼绝对路径，GitHub Pages 子路径部署同样成立。
 */
export function pdfWorkerSrc(): string {
  return `${import.meta.env.BASE_URL}pdfjs/pdf.worker.min.js`;
}

/**
 * @react-pdf-viewer/core 需要 pdfjs 的这几项具名导出。本仓库自己只调 getDocument，
 * 生产构建摇树时会把「看似没人用」的 renderTextLayer / SVGGraphics 删掉
 * （线上实测：产物里连标识符都不存在 → viewer 静默空白）。用动态属性名访问钉住它们。
 */
const VIEWER_APIS = ['PDFWorker', 'renderTextLayer', 'SVGGraphics', 'PasswordResponses'] as const;

/** 保住 viewer 依赖的 pdfjs 导出不被摇树删掉；返回缺失的 API 名（正常为空数组） */
export function keepViewerPdfApis(pdfjs: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const name of VIEWER_APIS) {
    // 用变量下标访问：写成 pdfjs.SVGGraphics 会被 Rolldown 判定为未使用并删除
    if (pdfjs[name as string] === undefined) missing.push(name);
  }
  return missing;
}

export async function loadPdfjs(): Promise<any> {
  if (_pdfjs) return _pdfjs;
  // viewer 的文档加载要靠 IntersectionObserver 的「容器可见」回调才会启动；
  // 冷缓存首次打开时那个回调可能不来（详见 pdfio.ts），这里先装好兜底再返回。
  installPdfIntersectionFallback();
  // UMD 经 CJS→ESM 互操作后可能被双层包裹（default 里再套 default）
  const mod: any = pdfjsNs;
  const pdfjs: any = mod?.default?.default ?? mod?.default ?? mod;
  const missing = keepViewerPdfApis(pdfjs);
  if (missing.length) {
    // 别静默：PDF 面板会因此空白，留一条可诊断的日志
    console.error('pdfjs 缺少 viewer 需要的 API：', missing.join(', '));
  }
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
  _pdfjs = pdfjs;
  return pdfjs;
}

/** 打开 PDF（File 或 ArrayBuffer）→ PDFDocumentProxy */
export async function openPdf(source: File | ArrayBuffer) {
  const pdfjs = await loadPdfjs();
  const data = source instanceof File ? await source.arrayBuffer() : source;
  return pdfjs.getDocument({ data }).promise;
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
    await doc.destroy();
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
