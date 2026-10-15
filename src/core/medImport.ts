/**
 * 教材导入：PDF → 带页码锚点的 Markdown → 存入本机教材索引。
 *
 * 复用 convert.pdfToMarkdown（pdf.js 文本层 → 行聚合 → 标题启发式，并按页插入
 * <!--kb:P#--> 页码锚点），因此教材与「格式转换」面板得到的是同一套结构，
 * 页码口径也一致。convert 会拉起 mammoth/turndown/pdf.js，故本模块按需动态引入，
 * 不进首屏包。
 */
import { pageAnchors } from './pageAnchor';
import { putMedBook, hasMedBook } from '../storage/medStore';
import { invalidateMedBooksCache } from './medBooks';

export interface MedImportProgress {
  done: number;
  total: number;
  label: string;
}

export interface MedImportResult {
  imported: string[];
  /** 其中同名覆盖的（文件名与已有教材相同）：UI 据此提示「覆盖 N 本」 */
  overwritten: string[];
  failed: Array<{ name: string; error: string }>;
  /** 非致命提示（如 OCR 只识别了前 N 页），UI 原样展示 */
  warnings: string[];
}

/** 统计有文字的页数（锚点之间非空白即算有字） */
function countExtractable(markdown: string): number {
  return markdown
    .split(/<!--\s*kb:P\d+\s*-->/)
    .filter((seg) => seg.replace(/\s/g, '').length > 0).length;
}

/** 文本层抽取的失败信息里，这类字样说明是扫描版，可以走 OCR 回退 */
export function looksLikeScannedPdf(error: string): boolean {
  return /未提取到文字|扫描/.test(error);
}

/**
 * 批量导入教材 PDF：逐个解析并入库，单个失败不中断整批。
 * 文本层抽取失败的扫描版，在 opts.ocr 开启时回退 OCR（每页约 2~5 秒，
 * 且有页数上限，识别不满整本的会在 warnings 里说明）。同名文件覆盖。
 */
export async function importMedPdfFiles(
  files: File[],
  onProgress?: (p: MedImportProgress) => void,
  opts?: { ocr?: boolean }
): Promise<MedImportResult> {
  const { pdfToMarkdown } = await import('./convert');
  const imported: string[] = [];
  const overwritten: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const warnings: string[] = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    onProgress?.({ done: i, total, label: `解析 ${file.name}` });
    let md: { title: string; markdown: string } | null = null;
    try {
      md = await pdfToMarkdown(file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!opts?.ocr || !looksLikeScannedPdf(msg)) {
        failed.push({ name: file.name, error: msg });
        continue;
      }
      // 扫描版回退 OCR：进度按整批占比折算，让用户知道没有卡死
      try {
        onProgress?.({ done: i, total, label: `OCR 识别 ${file.name}（较慢）` });
        const { ocrPdfToMarkdown } = await import('./ocr');
        const res = await ocrPdfToMarkdown(file, (p) => {
          onProgress?.({ done: i, total, label: `${file.name}：${p.label}` });
        });
        md = { title: res.title, markdown: res.markdown };
        if (res.warning) warnings.push(`《${res.title}》${res.warning}`);
      } catch (oe) {
        failed.push({ name: file.name, error: oe instanceof Error ? oe.message : String(oe) });
        continue;
      }
    }
    if (!md) continue;
    const anchors = pageAnchors(md.markdown);
    const existing = await hasMedBook(md.title);
    await putMedBook({
      name: md.title,
      pages: anchors.length,
      extractablePages: countExtractable(md.markdown),
      chars: md.markdown.length,
      at: Date.now(),
      text: md.markdown,
    });
    imported.push(md.title);
    if (existing) overwritten.push(md.title);
  }

  // 新正文已入库：失效检索缓存，否则助手在同一会话里查不到刚导入的教材
  invalidateMedBooksCache();
  onProgress?.({ done: total, total, label: '完成' });
  return { imported, overwritten, failed, warnings };
}
