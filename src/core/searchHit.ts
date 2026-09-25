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
export function locateAll(text: string, terms: string[], from = -1, span = 0): Hit[] {
  const windowed = from >= 0 && span > 0;
  const hits: Hit[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t) continue;
    const re = isAscii(t)
      ? new RegExp(`\\b${escapeRe(t)}\\b`, 'gi')
      : new RegExp(escapeRe(t), 'g');
    let m: RegExpExecArray | null;
    if (windowed) {
      // 窗口化：从窗口前 15 字符起扫（片段起点会回拉到首个命中之前），越过窗口尾即收。
      // 摘要只展示 60 字符，长文命中几百处时，后面的全文扫描全是白扫。
      re.lastIndex = Math.max(0, from - 15);
      while ((m = re.exec(text)) !== null) {
        if (m.index + m[0].length > from + span) break;
        if (m[0].length === 0) { re.lastIndex++; continue; } // 零宽匹配防死循环
        hits.push({ start: m.index, end: m.index + m[0].length });
      }
    } else {
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) break; // 零宽匹配防死循环
        hits.push({ start: m.index, end: m.index + m[0].length });
      }
    }
  }
  return merge(hits);
}

/** 正文缓存（键 = 笔记内容字符串，内容不变直接复用）：搜索框每键对 20 条结果
 *  各跑一次 bodyOf（CRLF 归一 + frontmatter 剥离），查询期间笔记不变，纯浪费。
 *  有界，与 parser.parseFrontmatterCached 同一套纪律。 */
const BODY_CACHE_MAX = 64;
const bodyCache = new Map<string, string>();

/** 去 YAML frontmatter，并把换行统一成 \n —— 偏移量在这之后才计算 */
function bodyOf(content: string): string {
  const hit = bodyCache.get(content);
  if (hit !== undefined) return hit;
  const out = content.replace(/\r\n?/g, '\n').replace(/^---[\s\S]*?---\n?/, '');
  if (bodyCache.size >= BODY_CACHE_MAX) bodyCache.clear();
  bodyCache.set(content, out);
  return out;
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

  // 第一处命中（定位片段用）：每词只扫到第一处就停，取最早——原来全量收集
  // 所有词条在全文的全部命中，只为用 all[0] 定位
  let first = -1;
  for (const raw of terms) {
    const t = raw.trim();
    if (!t) continue;
    const re = isAscii(t)
      ? new RegExp(`\\b${escapeRe(t)}\\b`, 'i')
      : new RegExp(escapeRe(t), 'i');
    const m = re.exec(body);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  if (first < 0) return head();

  const start = Math.max(0, first - 15);
  const raw = body.slice(start, start + len);
  const pad = start > 0 ? 1 : 0; // 前置省略号占一个字符
  const end = pad + raw.length;
  const all = locateAll(body, terms, start, raw.length); // 只收窗口内（含前 15 字符回拉区）的命中
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
