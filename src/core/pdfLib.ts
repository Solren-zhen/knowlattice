/**
 * pdf.js 懒加载共享模块 + 最近使用的 PDF 持久化（IndexedDB 独立库 medvault-pdfs，
 * 避免与 vault 的 medvault 库版本冲突）。
 */
import { openDB } from 'idb';

let _pdfjs: any = null;

export async function loadPdfjs(): Promise<any> {
  if (_pdfjs) return _pdfjs;
  const pdfjs: any = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
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

const PDF_DB = 'medvault-pdfs';

async function pdfDb() {
  return openDB(PDF_DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
    },
  });
}

/** 记住最近一次使用的 PDF，重开应用免重选 */
export async function saveLastPdf(name: string, data: ArrayBuffer) {
  try {
    const db = await pdfDb();
    await db.put('pdfs', { name, data }, 'current');
  } catch {
    /* 存储失败不影响使用 */
  }
}

export async function getLastPdf(): Promise<{ name: string; data: ArrayBuffer } | null> {
  try {
    const db = await pdfDb();
    return (await db.get('pdfs', 'current')) ?? null;
  } catch {
    return null;
  }
}
