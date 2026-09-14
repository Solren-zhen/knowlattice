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

export interface ConvertResult {
  /** 推断标题（文件名去扩展名） */
  title: string;
  markdown: string;
  /** 非致命提示（如扫描版 PDF 无文字层） */
  warning?: string;
  /** Which engine produced this result (display only). */
  engine?: string;
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
  // mammoth 把图片转成 base64 巨串；本库 Markdown 不渲染外链图，降级为占位符
  td.addRule('dropImages', {
    filter: (node: Node) => node.nodeName === 'IMG',
    replacement: (_c: string, node: Node) => {
      const alt = (node as HTMLImageElement).getAttribute('alt')?.trim();
      return alt ? `（图：${alt}）` : '';
    },
  });
  _turndown = td;
  return td;
}

/** 语义化 HTML → Markdown（浏览器内调用：turndown 依赖 DOM 解析） */
export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html);
}

/** Word(.docx) → Markdown */
export async function docxToMarkdown(file: File): Promise<ConvertResult> {
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const markdown = tidyMarkdown(htmlToMarkdown(html));
  if (!markdown.trim()) throw new Error('未从文档中提取到内容（可能是空白文档或加密文件）');
  return { title: file.name.replace(/\.(docx?|DOCX?)$/, ''), markdown };
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

  for (const lines of pages) {
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
