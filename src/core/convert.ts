/**
 * 格式转换：PDF / Word(.docx) → Markdown（纯前端、离线、零上传）。
 *
 * - docx：mammoth 语义化 HTML → turndown 转 Markdown（表格/加粗/列表保真）；
 *   图片是 base64 巨串且本库不展示外链图，一律降级为占位符。
 * - pdf：pdf.js 文本层 → 行聚合 → 字号/字体启发式重建结构
 *   （标题分级、段落合并、列表识别、页眉页脚剔除）。
 *   启发式思路参考 opengovsg/pdf2md（MIT）：以「最常用字高 = 正文」为基准，
 *   更高字高按去重降序映射为 h1~h4。
 */

import * as mammoth from 'mammoth';
import TurndownService from 'turndown';
import { openPdf } from './pdfLib';
import { normalizeMarkdownSpacing } from './mdSpace';
import { pageAnchor } from './pageAnchor';
import { ommlToLatex } from './omml';

/** vault 内附件的固定目录（与 Editor 贴图、livePreview 的解析约定一致） */
export const ATTACH_DIR = '_attachments/';

/** docx 里抽出的图片：文件名 + 二进制。
 *  只抽不写盘：真正落库由调用方（ConvertView）在用户点「保存为笔记」时做，
 *  否则「只看一眼、不保存」也会在库里留下一堆孤儿附件。 */
export interface ConvertedImage {
  /** _attachments/ 下的文件名，如 img-m3k9x-0.png */
  filename: string;
  blob: Blob;
}

export interface ConvertResult {
  /** 推断标题（文件名去扩展名） */
  title: string;
  markdown: string;
  /** 非致命提示（如扫描版 PDF 无文字层） */
  warning?: string;
  /** Which engine produced this result (display only). */
  engine?: string;
  /** 正文引用的内嵌图片（markdown 中已写成 _attachments/<filename>） */
  images?: ConvertedImage[];
}

/* ============================================================ 通用后处理 */

/** 收敛 3+ 连续空行，去首尾空白 */
export function tidyMarkdown(md: string): string {
  return md.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ============================================================ Word(.docx) */

let _turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (_turndown) return _turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
  });
  // 表格 → GFM 管道表（mammoth 输出规范 table/thead/tbody，直接遍历行即可）
  td.addRule('gfmTable', {
    filter: (node: Node) => node.nodeName === 'TABLE',
    replacement: (_content: string, node: Node) => {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const cellsOf = (tr: HTMLTableRowElement) =>
        Array.from(tr.cells).map((c) =>
          (c.textContent ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim() || ' '
        );
      const width = Math.max(...rows.map((r) => r.cells.length));
      const lines: string[] = [];
      rows.forEach((tr, i) => {
        const cells = cellsOf(tr);
        while (cells.length < width) cells.push(' ');
        lines.push(`| ${cells.join(' | ')} |`);
        // mammoth 的表头在 thead 里（或全部 th）；紧跟表头行补分隔行
        const isHeader = i === 0
          && (tr.parentElement?.nodeName === 'THEAD'
            || Array.from(tr.cells).every((c) => c.nodeName === 'TH'));
        if (isHeader) lines.push(`| ${Array(width).fill('---').join(' | ')} |`);
      });
      // 兜底：无 thead/th 的表格也要有分隔行，否则不是合法 GFM 表
      if (!lines.some((l) => l.includes('| ---'))) {
        lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  // 图片：mammoth 把 <img src> 交给我们决定（见 docxToMarkdown 的 convertImage），
  // 这里只把 src 落成 Markdown 图片语法，预览与正文都能渲染。
  // 只接受 _attachments/ 下的路径 —— 外链图与残留的 data URI 本库渲染不了，
  // 保留可读占位，而不是留一个必然 404 的坏链接。
  td.addRule('vaultImage', {
    filter: (node: Node) => node.nodeName === 'IMG',
    replacement: (_c: string, node: Node) => {
      const el = node as HTMLImageElement;
      const src = el.getAttribute('src') ?? '';
      const alt = el.getAttribute('alt')?.trim() ?? '';
      if (!src.startsWith(ATTACH_DIR)) return alt ? `（图：${alt}）` : '';
      return `![${alt}](${src})`;
    },
  });
  _turndown = td;
  return td;
}

/** 语义化 HTML → Markdown（浏览器内调用：turndown 依赖 DOM 解析） */
export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html);
}

/** 图片扩展名：从 content-type 取；取不到就按 png（docx 内嵌图基本只有 png/jpeg/gif） */
function imageExt(contentType: string): string {
  const sub = (contentType.split('/')[1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (sub === 'jpeg') return 'jpg';
  return sub && sub.length <= 5 ? sub : 'png';
}

/* ---------- 公式：mammoth 丢弃 OMML，必须在转换前把公式捞出来 ---------- */

/** 公式占位 token：mammoth / turndown 都不碰纯文本，转换后据此还原 LaTeX */
const EQ_TOKEN_RE = /@@KLZ-EQ-(\d+)@@/g;

/** 把 docx 里的 OMML 公式抽成占位 token 写回 document.xml（返回改写后的字节与公式表）。
 *  mammoth 把 `m:oMath` 当未知元素**静默丢弃**（已用真实 .docx 验证：分数整段消失、
 *  前后文字还粘在一起），所以必须赶在它之前把公式替换成能原样穿过的文本 token。
 *  无改动（无公式 / 无 DOM 环境）时原样返回入参字节、公式表为空。 */
export async function substituteDocxEquations(arrayBuffer: ArrayBuffer): Promise<{
  bytes: ArrayBuffer;
  recipes: Array<{ latex: string; block: boolean }>;
}> {
  const empty = { bytes: arrayBuffer, recipes: [] as Array<{ latex: string; block: boolean }> };
  if (typeof DOMParser === 'undefined') return empty; // 无 DOM 环境（纯 Node 测试）跳过
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(arrayBuffer);
    const doc = zip.file('word/document.xml');
    if (!doc) return empty;
    let xml = await doc.async('string');
    if (!/m:oMath/.test(xml)) return empty;
    const recipes: Array<{ latex: string; block: boolean }> = [];
    const token = (fragment: string, block: boolean): string => {
      const n = recipes.length;
      recipes.push({ latex: ommlToLatex(fragment), block });
      return `<w:r><w:t>@@KLZ-EQ-${n}@@</w:t></w:r>`;
    };
    // 先整段公式（独占一行），再行内——避免 oMathPara 里的 oMath 被二次替换
    xml = xml.replace(/<m:oMathPara\b[^>]*>[\s\S]*?<\/m:oMathPara>/g, (m) => token(m, true));
    xml = xml.replace(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g, (m) => token(m, false));
    zip.file('word/document.xml', xml);
    return { bytes: await zip.generateAsync({ type: 'arraybuffer' }), recipes };
  } catch {
    return empty;
  }
}

/** 把正文里的公式占位符换回 `$…$` / `$$…$$`（识别不出公式的 token 直接删掉，不留噪声） */
export function applyEquationTokens(markdown: string, recipes: Array<{ latex: string; block: boolean }>): string {
  return markdown.replace(EQ_TOKEN_RE, (_m, i: string) => {
    const r = recipes[Number(i)];
    if (!r || !r.latex) return '';
    return r.block ? `\n\n$$${r.latex}$$\n\n` : `$${r.latex}$`;
  });
}

/* ---------- 内联图片（data URI）落库 ---------- */

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } } }).Buffer;
  if (B) {
    const b = B.from(clean, 'base64');
    return new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
  }
  return new Uint8Array();
}

/**
 * 每次转换一个**唯一**的名字戳。
 *
 * 为什么不能只用 `Date.now()`：它只到毫秒，同一毫秒里转两个文档会得到同一个前缀，
 * 而每份文档的图片序号都从 0 开始 —— 于是后一份的 `img-<戳>-0.png` 会**覆盖**前一份
 * （vault 的同路径写盘就是覆盖），前一份正文里的图片引用就指向了别人的图。
 * 加一个模块级自增序号：同一进程内两次转换的前缀永远不同，而文件名的形状保持不变。
 */
let imageStampSeq = 0;
const imageStamp = (): string => `${Date.now().toString(36)}${(imageStampSeq++).toString(36)}`;

/**
 * 把正文里**内联**的 `data:image/...;base64,...` 图抽成附件，并改写为 `_attachments/…`。
 * some engines（anydoc 等）会把图直接内联进 Markdown：内联 base64 既撑爆正文/索引/备份，
 * 又因为不是附件而在「存为笔记」时被静默丢弃——这正是「转换后图片丢失」的另一条路径。
 */
export function extractInlineImages(markdown: string): { markdown: string; images: ConvertedImage[] } {
  const images: ConvertedImage[] = [];
  const stamp = imageStamp();
  let seq = 0;
  const out = markdown.replace(
    /!\[([^\]]*)\]\(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\)/g,
    (_m, alt: string, subtype: string, b64: string) => {
      const low = subtype.toLowerCase();
      const ext = low === 'jpeg' ? 'jpg' : (low.replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png');
      const filename = `img-${stamp}-${seq++}.${ext}`;
      images.push({ filename, blob: new Blob([base64ToBytes(b64)], { type: `image/${subtype}` }) });
      return `![${alt}](${ATTACH_DIR}${filename})`;
    },
  );
  return { markdown: out, images };
}

/** Word(.docx) → Markdown（内嵌图片抽成 Blob，交调用方落库；公式经 OMML→LaTeX 还原）
 *
 *  图片：mammoth 抽图时就把最终 vault 路径写进 <img src>，turndown 那一步只做「照抄 src」，
 *  不存在 data URI → 路径的二次替换，也就没有漏掉的空间。
 *  公式：mammoth 完全不认 OMML（`m:oMath` 被当未知元素丢弃），所以先把它替换成占位 token、
 *  转换后换回 `$LaTeX$`——否则 Word 里的公式在转换这一步就永久消失了。 */
export async function docxToMarkdown(file: File): Promise<ConvertResult> {
  const arrayBuffer = await file.arrayBuffer();
  const images: ConvertedImage[] = [];
  const stamp = imageStamp();
  let seq = 0;
  const injected = await substituteDocxEquations(arrayBuffer);
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: injected.bytes },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const filename = `img-${stamp}-${seq++}.${imageExt(image.contentType)}`;
        images.push({
          filename,
          blob: new Blob([await image.readAsArrayBuffer()], { type: image.contentType }),
        });
        return { src: `${ATTACH_DIR}${filename}` };
      }),
    }
  );
  let markdown = htmlToMarkdown(html);
  if (injected.recipes.length) markdown = applyEquationTokens(markdown, injected.recipes);
  markdown = tidyMarkdown(markdown);
  if (!markdown.trim()) throw new Error('未从文档中提取到内容（可能是空白文档或加密文件）');
  return {
    title: file.name.replace(/\.(docx?|DOCX?)$/, ''),
    markdown,
    ...(images.length ? { images } : {}),
  };
}

/* ============================================================ PDF */

/** pdf.js 文本项的几何归一化（transform[4]=x，transform[5]=y 基线） */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontName: string;
}

export interface PdfLine {
  y: number;
  h: number;
  items: PdfTextItem[];
  text: string;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 同一行的项按 x 排序后拼接：间隙超过阈值补空格（拉丁文需要，中文不需要） */
export function joinLineItems(items: PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = '';
  let prev: PdfTextItem | null = null;
  for (const it of sorted) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > Math.max(1, prev.h * 0.18) && out && !/\s$/.test(out) && !/^\s/.test(it.str)) {
        const needsSpace = !CJK_RE.test(out.slice(-1)) && !CJK_RE.test(it.str[0]);
        if (needsSpace) out += ' ';
      }
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\u00ad/g, '').replace(/\u00a0/g, ' ').trim();
}

/** 把散落的文本项按 y 聚成行（容差 = 字高 0.45），输出自上而下的行序列 */
export function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const buckets: PdfTextItem[][] = [];
  let cur: PdfTextItem[] = [];
  let curY = sorted[0].y;
  let tol = Math.max(1.5, sorted[0].h * 0.45);
  for (const it of sorted) {
    if (Math.abs(it.y - curY) <= tol) {
      cur.push(it);
      curY = (curY * (cur.length - 1) + it.y) / cur.length; // 滑动均值抗抖
    } else {
      buckets.push(cur);
      cur = [it];
      curY = it.y;
      tol = Math.max(1.5, it.h * 0.45);
    }
  }
  buckets.push(cur);
  return buckets.map((b) => ({
    y: b.reduce((s, i) => s + i.y, 0) / b.length,
    h: Math.max(...b.map((i) => i.h)),
    items: b,
    text: joinLineItems(b),
  })).filter((l) => l.text.length > 0);
}

/* ---------- 字体统计（pdf2md 思路：最常用 = 正文） ---------- */

export interface PdfGlobals {
  /** 正文字高（出现最多） */
  bodyHeight: number;
  maxHeight: number;
  /** 字体名 → 格式 */
  fontToFormat: Map<string, 'bold' | 'italic' | 'bold-italic'>;
  mostUsedFont: string;
  /** 相邻行距中位数（段落合并阈值用） */
  lineDistance: number;
}

function weightedMode<K>(counts: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

export function analyzeGlobals(pages: PdfLine[][]): PdfGlobals {
  const heights = new Map<number, number>();
  const fonts = new Map<string, number>();
  const dists: number[] = [];
  for (const lines of pages) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const n = l.text.replace(/\s/g, '').length || 1;
      heights.set(Math.round(l.h * 2) / 2, (heights.get(Math.round(l.h * 2) / 2) ?? 0) + n);
      for (const it of l.items) {
        const m = it.fontName || 'unknown';
        fonts.set(m, (fonts.get(m) ?? 0) + (it.str.replace(/\s/g, '').length || 1));
      }
      if (i > 0) dists.push(Math.abs(lines[i - 1].y - l.y));
    }
  }
  const bodyHeight = weightedMode(heights) ?? 10;
  const maxHeight = Math.max(bodyHeight, ...heights.keys());
  const mostUsedFont = weightedMode(fonts) ?? '';
  const fontToFormat = new Map<string, 'bold' | 'italic' | 'bold-italic'>();
  for (const f of fonts.keys()) {
    const low = f.toLowerCase();
    const bold = low.includes('bold') || low.includes('black') || low.includes('heavy');
    const ital = low.includes('italic') || low.includes('oblique');
    if (bold && ital) fontToFormat.set(f, 'bold-italic');
    else if (bold) fontToFormat.set(f, 'bold');
    else if (ital) fontToFormat.set(f, 'italic');
  }
  fontToFormat.delete(mostUsedFont); // 正文最常用字体视为无格式
  dists.sort((a, b) => a - b);
  const lineDistance = dists.length ? dists[Math.floor(dists.length / 2)] : bodyHeight * 1.4;
  return { bodyHeight, maxHeight, fontToFormat, mostUsedFont, lineDistance };
}

/* ---------- 列表识别 ---------- */

const BULLET_RE = /^[•·▪‣◦●○◆※\-–—*+]\s*(.+)$/;
const CIRCLED_RE = /^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])\s*(.+)$/;
const ORDERED_RE = /^\(?(\d{1,3})[.、)）]\s+(.+)$/;
const CJK_ORD_RE = /^([一二三四五六七八九十]{1,3})[、.]\s*(.+)$/;

export type LineKind =
  | { type: 'heading'; level: number }
  | { type: 'bullet'; text: string }
  | { type: 'ordered'; num: number; text: string }
  | { type: 'para'; text: string };

/** 单行分类：列表标记优先于标题（大字列表罕见，列表误判成标题更常见） */
export function classifyLine(line: PdfLine, g: PdfGlobals, headingHeights: number[]): LineKind {
  const t = line.text;
  const b = BULLET_RE.exec(t);
  if (b) return { type: 'bullet', text: b[1] };
  const o = ORDERED_RE.exec(t);
  if (o) return { type: 'ordered', num: parseInt(o[1], 10), text: o[2] };
  const c = CIRCLED_RE.exec(t);
  if (c) return { type: 'bullet', text: `${c[1]} ${c[2]}` };
  const co = CJK_ORD_RE.exec(t);
  if (co) return { type: 'bullet', text: `${co[1]}、${co[2]}` };
  // 标题：字高显著大于正文、且在标题字高集合中
  const h = Math.round(line.h * 2) / 2;
  const idx = headingHeights.indexOf(h);
  if (idx >= 0 && line.h >= g.bodyHeight * 1.12 && t.length <= 80) {
    return { type: 'heading', level: Math.min(6, idx + 1) };
  }
  return { type: 'para', text: t };
}

/* ---------- 页眉页脚剔除 ---------- */

/** 归一化页眉页脚指纹：数字全替换成 #（页码每页不同） */
const hfKey = (s: string) => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * 剔除在多数页面顶部/底部重复出现的行（页眉、页脚、页码）。
 * 仅当页数 ≥ 3 且重复率 ≥ 60% 时启用，避免小文档误伤。
 */
export function stripHeadersFooters(pages: PdfLine[][]): PdfLine[][] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edges = [...lines.slice(0, 2), ...lines.slice(-2)];
    const keys = new Set(edges.map((l) => hfKey(l.text)).filter((k) => k.length > 0));
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.ceil(pages.length * 0.6);
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  if (repeated.size === 0) return pages;
  return pages.map((lines) => lines.filter((l) => !repeated.has(hfKey(l.text))));
}

/* ---------- 行 → Markdown ---------- */

const TERMINAL = /[。．.!?！？；;：:」』）”’]\s*$/;

export function linesToMarkdown(pages: PdfLine[][], g: PdfGlobals): string {
  const headingSet = new Set<number>();
  for (const lines of pages) {
    for (const l of lines) {
      const h = Math.round(l.h * 2) / 2;
      if (h > g.bodyHeight * 1.12 && l.text.length <= 80) headingSet.add(h);
    }
  }
  // 降序映射 h1, h2, h3…（只取前 5 级）
  const hh = [...headingSet].sort((a, b) => b - a).slice(0, 5);

  const out: string[] = [];
  let prevKind: LineKind | null = null;
  let prevY = 0;
  let orderedNext = 1;

  const push = (s: string) => out.push(s);

  for (let pi = 0; pi < pages.length; pi++) {
    const lines = pages[pi];
    // 页首写入页码锚点（独占一行）：剥离后不显示，检索与核验据此定位页码。
    // 跨页不合并段落（页尾已把 prevKind 置空），锚点不会混进上一段。
    push(pageAnchor(pi + 1));
    for (const line of lines) {
      const kind = classifyLine(line, g, hh);
      // 加粗/斜体行内包裹（标题自带强调，跳过）。
      // 列表标记不参与输出：把标记前缀从首个文本项里剥掉再重建。
      const prefixLen = kind.type === 'bullet' || kind.type === 'ordered'
        ? line.text.length - kind.text.length
        : 0;
      const fmtItems = prefixLen > 0
        ? line.items
            .map((it, i) => (i === 0 ? { ...it, str: it.str.slice(prefixLen) } : it))
            .filter((it) => it.str.length > 0)
        : line.items;
      const decorate = (text: string) => {
        if (kind.type === 'heading') return text;
        let res = '';
        let fmt: 'bold' | 'italic' | 'bold-italic' | null = null;
        let buf = '';
        const flush = () => {
          if (!buf) return;
          if (fmt === 'bold') res += `**${buf}**`;
          else if (fmt === 'italic') res += `*${buf}*`;
          else if (fmt === 'bold-italic') res += `***${buf}***`;
          else res += buf;
          buf = '';
        };
        for (const it of fmtItems) {
          const f = g.fontToFormat.get(it.fontName) ?? null;
          if (f !== fmt) { flush(); fmt = f; }
          buf += it.str;
        }
        flush();
        return res || text;
      };

      const gap = prevY ? Math.abs(prevY - line.y) : 0;
      const closeGap = gap <= g.lineDistance * 1.7;

      if (kind.type === 'heading') {
        push(`${'#'.repeat(kind.level)} ${decorate(line.text)}`);
        orderedNext = 1;
      } else if (kind.type === 'bullet') {
        push(`- ${decorate(kind.text)}`);
        orderedNext = 1;
      } else if (kind.type === 'ordered') {
        push(`${kind.num || orderedNext}. ${decorate(kind.text)}`);
        orderedNext = kind.num + 1;
      } else {
        const prev = prevKind && prevKind.type === 'para' ? out[out.length - 1] : null;
        if (prev !== null && closeGap && !TERMINAL.test(prev)) {
          // 段落续行：中文直接拼接，拉丁文补空格
          const joiner = CJK_RE.test(prev.slice(-1)) || CJK_RE.test(kind.text[0]) ? '' : ' ';
          out[out.length - 1] = prev + joiner + decorate(kind.text);
        } else {
          push(decorate(kind.text));
          orderedNext = 1;
        }
      }
      prevKind = kind;
      prevY = line.y;
    }
    prevKind = null; // 跨页不合并段落
    prevY = 0;
  }
  return tidyMarkdown(out.join('\n'));
}

/* ---------- PDF 入口 ---------- */

export async function pdfToMarkdown(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<ConvertResult> {
  const buf = await file.arrayBuffer();
  const doc = await openPdf(buf);
  const numPages = doc.numPages;
  const pages: PdfLine[][] = [];
  let chars = 0;
  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const raw of tc.items as Array<Record<string, unknown>>) {
      const str = (raw.str as string) ?? '';
      if (!str.trim()) continue;
      const tr = raw.transform as number[];
      items.push({
        str,
        x: tr[4],
        y: tr[5],
        w: (raw.width as number) ?? 0,
        h: (raw.height as number) ?? Math.abs(tr[3]),
        fontName: (raw.fontName as string) ?? '',
      });
    }
    const lines = itemsToLines(items);
    pages.push(lines);
    chars += lines.reduce((s, l) => s + l.text.length, 0);
    onProgress?.(p, numPages);
  }
  await doc.destroy();
  if (chars < 40) {
    throw new Error('未提取到文字：这可能是扫描版 PDF（无文字层），需要先 OCR');
  }
  const stripped = stripHeadersFooters(pages);
  const g = analyzeGlobals(stripped);
  const markdown = normalizeMarkdownSpacing(linesToMarkdown(stripped, g));
  const warning = numPages > 200 ? '超长 PDF，结构启发式可能欠佳，请检查预览' : undefined;
  return { title: file.name.replace(/\.pdf$/i, ''), markdown, warning };
}
