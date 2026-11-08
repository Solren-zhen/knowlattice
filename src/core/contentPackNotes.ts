/**
 * 内容包里的「讲义页」→ 笔记。
 *
 * 背景：讲义图是按「一本讲义的第 N 页」组织的（一页 2–4 张图），不是按题目组织的。
 * 直接把它摊进题库会丢掉页序（图上讲的是「第 4 页那一段」，抽出来就没有上下文了），
 * 所以这里落成**一本讲义一篇笔记**：页码顺序即阅读顺序，图按原样内联，每页后面跟着
 * 「这一页对应的题」——图看一遍、题再做一遍，两边对得上。
 *
 * 去重是刻意的：题干只取前 60 字做索引，解析不抄进正文（解析在题库里，抄一遍等于
 * 同一份文字在库里存两份，改一处另一处就是旧的了）。
 */
import { CONTENT_PACK_FORMAT } from './contentPack';
import { asRecord } from './record';

export interface PackPage {
  paper: string;
  label: string;
  /** 版次/主讲（同一本讲义可能有多个版本，页码不通用，所以按版本分开成篇） */
  teacher: string;
  page: string;
  /** 该页对应的题干片段（源数据带的，可能为空） */
  note: string;
  /** 该页的图片 ref，按页内顺序 */
  images: string[];
  /** 源数据里直接带的题目 id（多数页没有，靠 pageLinks 补） */
  qids: string[];
}

/** 一本讲义（同一 paper + 版本）的页集合 */
export interface PackBook {
  key: string;
  label: string;
  teacher: string;
  paper: string;
  pages: PackPage[];
}

/** 笔记里「这一页相关题」用到的题目摘要 */
export interface ItemBrief {
  stem: string;
  answers: string[];
}

export const PAGE_INDEX_KEY = 'page2item.json';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 是不是「讲义页」文件：一个数组，元素带 paper/label/page 与图片或题目 id */
export function looksLikePages(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const first = asRecord(raw[0]);
  if (!first) return false;
  return typeof first.paper === 'string' && typeof first.page === 'string'
    && (Array.isArray(first.images) || Array.isArray(first.qids));
}

/** 是不是「页 → 题目 id」映射：键是 `<paper>:<页码>`，值是 id 数组 */
export function looksLikePageLinks(raw: unknown): boolean {
  const o = asRecord(raw);
  if (!o) return false;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  let matched = 0;
  for (const k of keys.slice(0, 20)) {
    if (/^[A-Za-z0-9_-]+:\d+$/.test(k) && Array.isArray(o[k])) matched += 1;
  }
  return matched >= Math.min(3, keys.length);
}

export function packPages(raw: unknown): PackPage[] {
  if (!Array.isArray(raw)) return [];
  const out: PackPage[] = [];
  for (const it of raw) {
    const o = asRecord(it);
    if (!o) continue;
    const paper = str(o.paper);
    const page = str(o.page);
    // 缺 paper/page 的页没法排序也没法关联题目，留着只会变成一堆读不出处的图
    if (!paper || !page) continue;
    out.push({
      paper,
      label: str(o.label) || '未命名讲义',
      teacher: str(o.teacher),
      page,
      note: str(o.note),
      images: strList(o.images),
      qids: strList(o.qids),
    });
  }
  return out;
}

export function packPageLinks(raw: unknown): Record<string, string[]> {
  const o = asRecord(raw);
  if (!o) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!/^[A-Za-z0-9_-]+:\d+$/.test(k)) continue;
    const ids = strList(v);
    if (ids.length) out[k] = ids;
  }
  return out;
}

/** 页码排序：源数据里 page 是字符串，'10' 排在 '9' 前面会把整本讲义读乱 */
function pageNum(p: PackPage): number {
  const n = Number.parseInt(p.page, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** 按（讲义 + 版本）分组，组内按页码升序 */
export function groupBooks(pages: PackPage[]): PackBook[] {
  const map = new Map<string, PackBook>();
  for (const p of pages) {
    const key = `${p.paper}|${p.teacher}`;
    let b = map.get(key);
    if (!b) {
      b = { key, label: p.label, teacher: p.teacher, paper: p.paper, pages: [] };
      map.set(key, b);
    }
    b.pages.push(p);
  }
  const books = [...map.values()];
  for (const b of books) {
    b.pages.sort((x, y) => pageNum(x) - pageNum(y) || x.page.localeCompare(y.page));
  }
  return books;
}

/** 笔记路径：讲义/<讲义名>/<版本>.md；版本为空时落到 <讲义名>.md */
export function bookNotePath(book: PackBook): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim();
  const label = safe(book.label) || '未命名讲义';
  const teacher = safe(book.teacher);
  return teacher ? `讲义/${label}/${teacher}.md` : `讲义/${label}.md`;
}

export interface BookMarkdownOptions {
  /** `<paper>:<页码>` → 题目 id */
  links?: Record<string, string[]>;
  /** 题目 id → 摘要（来自同一批选中的 unit 文件；没有就只报数量） */
  index?: Map<string, ItemBrief>;
  /** 图片 ref → vault 相对路径（落库后的 `_attachments/…`）；返回 null 表示这张图没进库 */
  mediaPath: (ref: string) => string | null;
  /** 每页最多列几道相关题的题干 */
  maxItems?: number;
}

/** 把一本讲义写成笔记正文 */
export function bookMarkdown(book: PackBook, opts: BookMarkdownOptions): string {
  const links = opts.links ?? {};
  const index = opts.index;
  const maxItems = opts.maxItems ?? 3;
  const lines: string[] = [];
  lines.push(`# ${book.label}${book.teacher ? ` · ${book.teacher}` : ''} 讲义`);
  lines.push('');
  lines.push(`共 ${book.pages.length} 页。页码顺序即讲义顺序；页内图片按原顺序排列。`);
  lines.push('');

  let placed = 0;
  let missing = 0;
  let linked = 0;
  for (const p of book.pages) {
    lines.push(`## 第 ${p.page} 页`);
    lines.push('');
    const imgs: string[] = [];
    for (const ref of p.images) {
      const path = opts.mediaPath(ref);
      if (!path) { missing += 1; continue; }
      imgs.push(`![](${path})`);
    }
    placed += imgs.length;
    if (imgs.length) {
      lines.push(...imgs);
      lines.push('');
    } else if (p.images.length) {
      lines.push('_（本页图片不在导入的这批文件里）_');
      lines.push('');
    }
    if (p.note) {
      lines.push(`> 本页要点：${p.note}`);
      lines.push('');
    }
    const ids = links[`${p.paper}:${p.page}`] ?? p.qids;
    if (ids.length) {
      linked += ids.length;
      lines.push(`本页相关题 ${ids.length} 道：`);
      lines.push('');
      const shown = index ? ids.slice(0, maxItems).map((id) => index.get(id)).filter(Boolean) : [];
      if (shown.length) {
        shown.forEach((brief, i) => {
          const ans = brief!.answers.length ? `（答案 ${brief!.answers.join('')}）` : '';
          lines.push(`${i + 1}. ${brief!.stem}${ans}`);
        });
        if (ids.length > shown.length) lines.push(`…余下 ${ids.length - shown.length} 道在题库里练`);
      } else {
        lines.push('_（题目正文在题库里；把 unit/ 里的单元文件一起选进来就能在这里看到题干）_');
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`图片 ${placed} 张已落库${missing ? `，${missing} 张未找到（不在本批文件里）` : ''}；页题关联 ${linked} 条。`);
  return lines.join('\n');
}

/** 单元文件（items）→ 题目摘要索引，供笔记里显示题干用 */
export function unitBriefIndex(raw: unknown): Map<string, ItemBrief> {
  const out = new Map<string, ItemBrief>();
  const o = asRecord(raw);
  if (!o || !Array.isArray(o.items)) return out;
  const format = str(o.format);
  if (format && format !== CONTENT_PACK_FORMAT) return out;
  for (const it of o.items) {
    const rec = asRecord(it);
    if (!rec || typeof rec.qid !== 'string') continue;
    const stem = blocksToText(rec.stem).slice(0, 60);
    if (!stem) continue;
    out.set(rec.qid, { stem, answers: strList(rec.answers) });
  }
  return out;
}

function blocksToText(v: unknown): string {
  if (!Array.isArray(v)) return '';
  const parts: string[] = [];
  for (const b of v) {
    const rec = asRecord(b);
    if (!rec) continue;
    if (rec.t === 'text' && typeof rec.v === 'string') parts.push(rec.v);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
