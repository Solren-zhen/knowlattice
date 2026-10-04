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
}

/** 统计有文字的页数（锚点之间非空白即算有字） */
function countExtractable(markdown: string): number {
  return markdown
    .split(/<!--\s*kb:P\d+\s*-->/)
    .filter((seg) => seg.replace(/\s/g, '').length > 0).length;
}

/**
 * 批量导入教材 PDF：逐个解析并入库，单个失败不中断整批（扫描件会在这里被跳过，
 * pdfToMarkdown 会抛出「未提取到文字」）。同名文件覆盖。
 */
export async function importMedPdfFiles(
  files: File[],
  onProgress?: (p: MedImportProgress) => void
): Promise<MedImportResult> {
  const { pdfToMarkdown } = await import('./convert');
  const imported: string[] = [];
  const overwritten: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    onProgress?.({ done: i, total, label: `解析 ${file.name}` });
    try {
      const { title, markdown } = await pdfToMarkdown(file);
      const anchors = pageAnchors(markdown);
      const existing = await hasMedBook(title);
      await putMedBook({
        name: title,
        pages: anchors.length,
        extractablePages: countExtractable(markdown),
        chars: markdown.length,
        at: Date.now(),
        text: markdown,
      });
      imported.push(title);
      if (existing) overwritten.push(title);
    } catch (e) {
      failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 新正文已入库：失效检索缓存，否则助手在同一会话里查不到刚导入的教材
  invalidateMedBooksCache();
  onProgress?.({ done: total, total, label: '完成' });
  return { imported, overwritten, failed };
}
