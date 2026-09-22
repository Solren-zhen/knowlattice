/**
 * 搜索命中定位：给「一键搜索内容高亮」提供**字符级区间**。
 *
 * 为什么要自己算：MiniSearch 7 的结果里有 `match`（哪个词命中了哪个字段），
 * 但**没有** `includeMatches`，拿不到字符偏移（已核对 dist/es/index.js 与
 * index.d.ts，零命中）。所以片段定位与高亮必须自己来。
 *
 * 顺带修掉原来的定位 bug：旧 snippet() 用 `body.indexOf(q[0])` 定位，
 * 只拿查询的**第一个字符**去找——搜「氧解离曲线」时会在正文里找第一个「氧」，
 * 于是片段经常定位到完全无关的位置。
 */
import { expandQuery } from './medSynonyms';

/** 文本里的一段区间 [start, end) */
export interface Hit {
  start: number;
  end: number;
}

/** 片段 + 相对该片段的高亮区间 */
export interface Snippet {
  text: string;
  hits: Hit[];
}

/** 纯 ASCII（字母/数字/符号，无 CJK） */
const isAscii = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 合并重叠/相邻区间，按起点排序 */
function merge(hits: Hit[]): Hit[] {
  if (hits.length <= 1) return hits;
  const sorted = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Hit[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].start <= last.end) last.end = Math.max(last.end, sorted[i].end);
    else out.push(sorted[i]);
  }
  return out;
}

/**
 * 找出 text 里所有 term 的出现位置（大小写不敏感）。
 *
 * 纯 ASCII 词按**词边界**匹配：否则缩写 "AMI" 会在 "family" 里命中；
 * 含 CJK 的词直接子串匹配——中文没有词边界可依，且子串命中正是要的效果。
 */
export function locateAll(text: string, terms: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t) continue;
    const re = isAscii(t)
      ? new RegExp(`\\b${escapeRe(t)}\\b`, 'gi')
      : new RegExp(escapeRe(t), 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) break; // 零宽匹配防死循环
      hits.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return merge(hits);
}

/** 去 YAML frontmatter，并把换行统一成 \n —— 偏移量在这之后才计算 */
function bodyOf(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/^---[\s\S]*?---\n?/, '');
}

/** 换行压成空格：**逐字符替换、长度不变**，所以偏移量照旧可用 */
const flatten = (s: string): string => s.replace(/\n/g, ' ');

/**
 * 从正文提取命中片段，并给出**相对片段**的高亮区间。
 * 找不到命中时退化为开头一段（与旧行为一致，只是不再错误定位）。
 */
export function buildSnippet(content: string, query: string, len = 60): Snippet {
  const body = bodyOf(content);
  const terms = expandQuery(query);
  const head = (): Snippet => ({ text: flatten(body.slice(0, len)), hits: [] });
  if (!terms.length) return head();

  const all = locateAll(body, terms);
  if (!all.length) return head();

  const start = Math.max(0, all[0].start - 15);
  const raw = body.slice(start, start + len);
  const pad = start > 0 ? 1 : 0; // 前置省略号占一个字符
  const end = pad + raw.length;
  const hits: Hit[] = [];
  for (const h of all) {
    const s = h.start - start + pad;
    const e = h.end - start + pad;
    if (e <= pad || s >= end) continue; // 完全落在窗口外
    hits.push({ start: Math.max(pad, s), end: Math.min(end, e) });
  }
  return { text: (pad ? '…' : '') + flatten(raw), hits };
}

/** 按命中区间把文本切成片段，供渲染 <mark> 用 */
export function segment(text: string, hits: Hit[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start > at) out.push({ text: text.slice(at, h.start), hit: false });
    if (h.end > h.start) out.push({ text: text.slice(h.start, h.end), hit: true });
    at = Math.max(at, h.end);
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** 标题高亮：标题很短，直接整体定位，不需要截窗口 */
export function titleHits(title: string, query: string): Hit[] {
  return locateAll(title, expandQuery(query));
}
