/**
 * OCR：把扫描版 PDF（没有文字层）转成可编辑的 Markdown。
 *
 * 为什么需要：anydoc 与内置启发式引擎都只读 PDF 的文字层，扫描件会以 needsOcr 报错。
 * 界面上已经有 4 处提示「扫描版需先 OCR」（ConvertView / DraftGen / convert.ts / anydoc.ts），
 * 但一直没有实现——这个模块补上的就是这一步。
 *
 * 完全离线，不请求任何 CDN。tesseract.js 的三条路径默认全部指向 jsDelivr，必须逐个覆盖：
 *   workerPath    → public/tesseract/worker.min.js
 *   corePath      → public/tesseract/（三个 core 变体，按浏览器能力自动挑）
 *                   注意 core 入口文件名必须是 tesseract-core-*-lstm.wasm.js（getCore.js
                   按这个模式拼 URL），所以同一份加载器同时保留了 .js 与 .wasm.js 两个名字，
                   免得上游改回另一种命名时要临时补文件；多占 261 kB。
 *   langPath      → public/tessdata/（fast 模型，chi_sim + eng 共约 3.5 MB）
 *   workerBlobURL → false（第四处覆盖，见下）
 * 这些资源只在真正发起 OCR 时才被请求，不进主包、不影响首屏。
 *
 * 关于 workerBlobURL —— 这一处最隐蔽，踩过才知道：
 * tesseract.js 默认 workerBlobURL: true 时不直接 new Worker(workerPath)，
 * 而是先造一个内容仅为 importScripts("<workerPath>") 的 Blob，再 new Worker(blobURL)。
 * 于是 worker 内的 self.location.href 是 blob:…；而 emscripten 产物靠
 *   fa = new URL(".", _scriptName).href   // _scriptName 在 worker 里回退成 self.location.href
 * 定位自己的 .wasm 兄弟文件——blob URL 不能作为相对路径的 base，这句会抛异常，
 * 又被库自己的 try{}catch{} 静默吞掉，fa 变成空串，.wasm 请求打到一个非法地址。
 * 表现是永远停在「初始化引擎」，不报错、不超时、控制台干净，很难查。
 * 设成 false 后 worker 从真实 URL 加载，fa 正确解析为 /tesseract/，.wasm 才能取到。
 */
import { openPdf } from './pdfLib';
import { normalizeMarkdownSpacing } from './mdSpace';
import { pageAnchor } from './pageAnchor';
import type { ConvertResult } from './convert';

const BASE = import.meta.env.BASE_URL;

/** 单次 OCR 的页数上限。每页约 2~5 秒，不设上限用户会以为程序卡死。 */
export const MAX_OCR_PAGES = 30;

/**
 * 渲染倍率。PDF 内部单位是 72 DPI，OCR 需要约 180 DPI 才有可用精度；
 * 再高收益很小但内存和耗时线性增长。
 */
const RENDER_SCALE = 2.5;

/** 渲染后单边最大像素，防止异常大的页面撑爆内存 */
const MAX_SIDE = 4000;

export interface OcrProgress {
  /** 总体进度 0~1 */
  ratio: number;
  /** 面向用户的文案 */
  label: string;
}

/** tesseract 的阶段状态 → 中文文案 */
const STATUS_LABEL: Record<string, string> = {
  'loading tesseract core': '加载识别引擎',
  'initializing tesseract': '初始化引擎',
  'loading language traineddata': '加载语言包',
  'initializing api': '初始化接口',
  'recognizing text': '识别文字',
};

/**
 * tesseract 的中文识别结果常在汉字之间夹空格（每个字被当成独立 token），
 * 直接写进笔记会很难读。这里只去掉「汉字 空格 汉字」，英文单词间的空格保留。
 */
export function collapseCjkSpaces(s: string): string {
  return s.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '');
}

/**
 * 建一个识别 worker。两份用途（PDF 整页 / 单张图片）共用同一套离线路径与日志口径——
 * 分开写两份 `createWorker({...})` 的后果是：某天只改了其中一份的路径，另一份静默走上网。
 * `cap` 是「初始化阶段最多占多少进度」，剩下的留给真正的识别循环。
 */
async function createOcrWorker(
  onProgress?: (p: OcrProgress) => void,
  cap = 0.45
) {
  const { createWorker } = await import('tesseract.js');
  return createWorker(['chi_sim', 'eng'], 1, {
    workerPath: BASE + 'tesseract/worker.min.js',
    corePath: BASE + 'tesseract/',
    // 必须为 false，否则 worker 跑在 blob: URL 上、core 定位不到自己的 .wasm（详见文件头注释）
    workerBlobURL: false,
    langPath: BASE + 'tessdata',
    gzip: true,
    logger: (m: { status?: string; progress?: number }) => {
      const label = m.status ? (STATUS_LABEL[m.status] ?? m.status) : '';
      if (label) onProgress?.({ ratio: Math.min(cap, m.progress ?? 0) * cap, label });
    },
  });
}

/**
 * 单张图片（截图、讲义片段、扫描页照片）→ 纯文本。
 *
 * 与 PDF 那条路的区别只在输入：tesseract 直接吃 Blob/File，不必先经 pdf.js 渲染；
 * 因此这里不需要 canvas，也不受页数上限约束。
 * 返回的文本已折叠汉字间空格、去空行，供调用方直接插入笔记或复制。
 */
export async function ocrImageToText(
  input: Blob,
  onProgress?: (p: OcrProgress) => void
): Promise<string> {
  const worker = await createOcrWorker(onProgress, 0.6);
  try {
    onProgress?.({ ratio: 0.6, label: '识别文字' });
    const res = await worker.recognize(input);
    const text = collapseCjkSpaces(res.data.text).replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('这张图里没识别出文字。请确认截图清晰、方向正确，或者文字太小。');
    onProgress?.({ ratio: 1, label: '识别完成' });
    return text;
  } finally {
    await worker.terminate();
  }
}

/** 把 pdf.js 的一页渲染成 canvas，交给 tesseract 识别 */
async function renderPage(doc: { getPage: (n: number) => Promise<unknown> }, n: number): Promise<HTMLCanvasElement> {
  const page = (await doc.getPage(n)) as {
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
  };
  const base = page.getViewport({ scale: 1 });
  // 大页面按上限回收倍率
  const scale = Math.min(RENDER_SCALE, MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale: Math.max(1, scale) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('无法创建画布上下文，浏览器可能已禁用 canvas');
  // 先铺白底：PDF 透明背景在部分识别模型下会被当成噪声
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * 扫描版 PDF → Markdown。
 * 失败时抛出面向用户的错误信息。
 */
export async function ocrPdfToMarkdown(
  file: File,
  onProgress?: (p: OcrProgress) => void
): Promise<ConvertResult> {
  const doc = (await openPdf(file)) as {
    numPages: number;
    getPage: (n: number) => Promise<unknown>;
    destroy: () => Promise<void>;
  };

  const total = Math.min(doc.numPages, MAX_OCR_PAGES);
  const truncated = doc.numPages > total;
  const worker = await createOcrWorker(onProgress, 0.45);

  const pages: Array<{ page: number; text: string }> = [];
  try {
    for (let p = 1; p <= total; p++) {
      onProgress?.({
        ratio: 0.45 + (0.55 * (p - 1)) / total,
        label: '识别第 ' + p + '/' + total + ' 页',
      });
      const canvas = await renderPage(doc, p);
      const res = await worker.recognize(canvas);
      // 及时释放画布，多页时内存占用是线性的
      canvas.width = 0;
      canvas.height = 0;
      const text = collapseCjkSpaces(res.data.text).replace(/\n{3,}/g, '\n\n').trim();
      if (text) pages.push({ page: p, text });
    }
  } finally {
    await worker.terminate();
    await doc.destroy();
  }

  onProgress?.({ ratio: 1, label: '整理结果' });

  if (pages.length === 0) {
    throw new Error('OCR 没有识别出任何文字。请确认这份 PDF 的扫描图像清晰、方向正确。');
  }

  // 每页前置页码锚点（剥离后不显示），与文本层 PDF 的坐标口径一致
  const markdown = normalizeMarkdownSpacing(
    pages.map((pg) => `${pageAnchor(pg.page)}\n${pg.text}`).join('\n\n')
  );
  const warning = truncated
    ? '已识别前 ' + total + ' 页（全文 ' + doc.numPages + ' 页）。OCR 较慢，超出部分请分批处理。'
    : '文字由 OCR 识别，可能存在错字，建议导入后通读一遍。';
  return { title: file.name.replace(/\.pdf$/i, ''), markdown, engine: 'ocr', warning };
}
