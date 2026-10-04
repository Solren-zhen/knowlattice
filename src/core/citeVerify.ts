/**
 * 引用逐字核验：把回答里「“原文…”〔《书名》 P182〕」形式的引用拆出来，
 * 与库内原文比对，给出四档结论，让「禁止编造」从道德约束变成可检查的机制。
 *
 * - exact       归一化后整段是原文子串（逐字命中）
 * - partial     头、尾都在原文里，中段有落差（拼接/省略致偏移）
 * - fabricated  只有头或只有尾命中（拿真实开头/结尾编了中间）
 * - not_found   头尾都对不上（查无此句）
 *
 * 归一化复用 pdfText.normalizePdfSelection（PDF 选区的排版空白清理）再叠合字折叠；
 * 数字走「归一化前严格比对」通道：宁可判 fabricated，也不放过 1.5 → 15 这类改写。
 */
import { normalizePdfSelection } from './pdfText';
import { stripPageAnchors } from './pageAnchor';

export type CiteStatus = 'exact' | 'partial' | 'fabricated' | 'not_found';

export interface Citation {
  /** 《书名》内的书名，无则 null */
  book: string | null;
  /** 页码，无则 null */
  page: number | null;
  /** 紧邻的逐字引文（“”内），无则 '' */
  quote: string;
  /** 原始引用标记，如 〔《内科学》 P182〕 */
  raw: string;
}

export interface CitationResult extends Citation {
  status: CiteStatus;
  /** 命中的来源笔记路径；not_found 或未解析到来源时为 null */
  sourcePath: string | null;
  /** 逐字命中（status === 'exact'）的笔记篇数：0 = 没有一篇逐字对上 */
  hits: number;
  /** 多处逐字命中（hits > 1）：结论仍是 exact，但出处不唯一，无法唯一溯源 */
  ambiguous: boolean;
}

const CITE_RE = /〔([^〕]+)〕/g;
const MIN_PROBE = 6;

/** 合字折叠：PDF 文本层常把 fi/fl/ffi 等排成单个 Unicode 合字 */
const LIGATURES: Array<[RegExp, string]> = [
  [/\ufb00/g, 'ff'], [/\ufb01/g, 'fi'], [/\ufb02/g, 'fl'], [/\ufb03/g, 'ffi'],
  [/\ufb04/g, 'ffl'], [/\ufb05/g, 'ft'], [/\ufb06/g, 'st'],
];

export function foldLigatures(s: string): string {
  let out = s;
  for (const [re, to] of LIGATURES) out = out.replace(re, to);
  return out;
}

/** 核验用的归一化：合字折叠 → PDF 选区清理 → 去掉全部空白（抗排版差异） */
export function normalizeForCite(s: string): string {
  return foldLigatures(normalizePdfSelection(s)).replace(/\s+/g, '');
}

function digitsOf(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** 核验前的原文预处理缓存：同一份原文（内容串为键）只归一化一次。
 *  引用核验会对每个候选来源整篇归一化（多趟正则 + 去空白），大库 × 多条引用
 *  不缓存会在渲染线程重复扫几十 MB。按缓存文本总字数逐出最旧，防止内存膨胀。 */
interface SourcePrep { normalized: string; digits: Set<string> }
const SOURCE_PREP_CACHE = new Map<string, SourcePrep>();
const SOURCE_PREP_MAX_CHARS = 8_000_000;
let sourcePrepChars = 0;

function sourcePrep(source: string): SourcePrep {
  const hit = SOURCE_PREP_CACHE.get(source);
  if (hit) return hit;
  const prep: SourcePrep = { normalized: normalizeForCite(source), digits: new Set(digitsOf(source)) };
  sourcePrepChars += source.length + prep.normalized.length;
  SOURCE_PREP_CACHE.set(source, prep);
  while (SOURCE_PREP_CACHE.size > 1 && sourcePrepChars > SOURCE_PREP_MAX_CHARS) {
    const oldest = SOURCE_PREP_CACHE.keys().next().value!;
    sourcePrepChars -= oldest.length + SOURCE_PREP_CACHE.get(oldest)!.normalized.length;
    SOURCE_PREP_CACHE.delete(oldest);
  }
  return prep;
}

/** 剥离页码锚点的结果缓存：同一份原文（原始 content 串为键）只剥一次。
 *  核验是「每条引用 × 每篇笔记」逐个剥锚点，不缓存时同一篇会被剥 N 次；
 *  预算与逐出策略与 sourcePrep 同口径（SOURCE_PREP_MAX_CHARS、逐出最旧），防内存膨胀。 */
const STRIPPED_CACHE = new Map<string, string>();
let strippedChars = 0;

function strippedSource(content: string): string {
  const hit = STRIPPED_CACHE.get(content);
  if (hit !== undefined) return hit;
  const out = stripPageAnchors(content);
  strippedChars += content.length + out.length;
  STRIPPED_CACHE.set(content, out);
  while (STRIPPED_CACHE.size > 1 && strippedChars > SOURCE_PREP_MAX_CHARS) {
    const oldest = STRIPPED_CACHE.keys().next().value!;
    strippedChars -= oldest.length + STRIPPED_CACHE.get(oldest)!.length;
    STRIPPED_CACHE.delete(oldest);
  }
  return out;
}

/** 最长的、能在原文中找到的引文前缀长度（不足 MIN_PROBE 记 0）。
 *  前缀命中具有单调性（长前缀命中 ⟹ 短前缀命中），二分求最大值，
 *  最坏 O(log n) 次全文扫描——逐长度线性探测在编造引文（全不命中）时会退化成 O(n)。 */
function longestPrefixIn(q: string, s: string): number {
  if (q.length < MIN_PROBE || !s.includes(q.slice(0, MIN_PROBE))) return 0;
  let lo = MIN_PROBE;
  let hi = q.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo + 1) / 2);
    if (s.includes(q.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 最长的、能在原文中找到的引文后缀长度（不足 MIN_PROBE 记 0）；单调性同前缀，二分求最大 */
function longestSuffixIn(q: string, s: string): number {
  if (q.length < MIN_PROBE || !s.includes(q.slice(q.length - MIN_PROBE))) return 0;
  let lo = MIN_PROBE;
  let hi = q.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo + 1) / 2);
    if (s.includes(q.slice(q.length - mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 单条引文对单份原文的四档核验 */
export function verifyQuote(quote: string, source: string): CiteStatus {
  const q0 = quote.trim();
  if (!q0) return 'not_found';

  // 数字严格通道：归一化前原文必须逐字含每个数字串
  const prep = sourcePrep(source);
  for (const d of digitsOf(q0)) {
    if (!prep.digits.has(d)) return 'fabricated';
  }

  const q = normalizeForCite(q0);
  const s = prep.normalized;
  if (!q || !s) return 'not_found';
  if (s.includes(q)) return 'exact';

  const prefix = longestPrefixIn(q, s);
  const suffix = longestSuffixIn(q, s);
  if (prefix >= MIN_PROBE && suffix >= MIN_PROBE) return 'partial';
  if (prefix >= MIN_PROBE || suffix >= MIN_PROBE) return 'fabricated';
  return 'not_found';
}

/** 从回答里拆出全部引用标记及其紧邻引文 */
export function parseCitations(answer: string): Citation[] {
  const out: Citation[] = [];
  const re = new RegExp(CITE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer))) {
    const inner = m[1];
    const book = /《([^》]+)》/.exec(inner);
    // 页码只认「P182」与「第182页」两种写法：「第3版」这类版次不算页码
    const page = /(?:[Pp]\s*(\d+))|(?:第\s*(\d+)\s*页)/.exec(inner);
    const before = answer.slice(0, m.index);
    const quote = /[“"]([^”"]{2,})[”"]\s*$/.exec(before);
    out.push({
      book: book ? book[1].trim() : null,
      page: page ? Number(page[1] ?? page[2]) : null,
      quote: quote ? quote[1].trim() : '',
      raw: m[0],
    });
  }
  return out;
}

const RANK: Record<CiteStatus, number> = { exact: 3, partial: 2, fabricated: 1, not_found: 0 };

/**
 * 在一批笔记里核验一段引文，取最佳命中：给了 path 就只比那一篇，
 * 否则全库扫描。供 verify_quote 工具与回答核验共用。
 */
export function lookupQuote(
  quote: string,
  docs: Map<string, string>,
  path?: string
): { status: CiteStatus; sourcePath: string | null } {
  let best: CiteStatus = 'not_found';
  let bestPath: string | null = null;
  for (const [p, content] of docs) {
    if (!p.endsWith('.md')) continue;
    if (path && p !== path) continue;
    const status = verifyQuote(quote, strippedSource(content));
    if (RANK[status] > RANK[best]) { best = status; bestPath = p; }
  }
  return { status: best, sourcePath: bestPath };
}

/** 路径基名（去目录、去 .md），用于书名匹配 */
const baseName = (path: string): string => path.replace(/\.md$/, '').split('/').pop()!;

/** 书名限定匹配：与 medIndex.bookMatches 同口径（多段 = 每段都要出现；单段 = 双向包含） */
function bookMatches(base: string, wanted: string, path: string): boolean {
  if (!wanted.trim()) return true;
  const n = base.toLowerCase();
  const parts = wanted.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.every((p) => path.toLowerCase().includes(p));
  const q = parts[0];
  return n.includes(q) || q.includes(n) || path.toLowerCase().includes(q);
}

/** 核验结果缓存：同一份 docs（Map 实例）下，同一 (书名, 引文) 只扫一遍库。
 *  面板每次保存都会换新 Map 实例，旧实例随 WeakMap 一起回收；
 *  流式重渲 / 同一答案重复渲染因此不再「每条引用 × 每篇笔记」重扫全库。
 *  注意：以 Map 实例为界——同一实例被就地改写（set/delete）不会失效，调用方应换新 Map。 */
const VERIFY_CACHE = new WeakMap<Map<string, string>, Map<string, CitationResult>>();

/** 结果缓存的键：书名 + 引文（页码/原文标记不属于核验输入，命中后按当前引用回填） */
const citeKey = (c: Citation): string => `${c.book ?? ''}\u0000${c.quote}`;

/**
 * 逐条核验回答里的引用：在库内（有书名则限定同名笔记）找最佳命中来源。
 * 无引文的标记（quote 为空）状态记 not_found，由调用方决定是否展示。
 * 另统计 exact 命中篇数 hits；hits > 1 记 ambiguous（出处不唯一）。
 */
export function verifyCitations(answer: string, docs: Map<string, string>): CitationResult[] {
  let cache = VERIFY_CACHE.get(docs);
  if (!cache) { cache = new Map<string, CitationResult>(); VERIFY_CACHE.set(docs, cache); }
  const bucket = cache;
  return parseCitations(answer).map((c) => {
    const cached = bucket.get(citeKey(c));
    // 缓存只存核验结论；页码/原始标记随当前引用回填（同 quote 同书名的两条引用页码可能不同）
    if (cached) return { ...cached, book: c.book, page: c.page, quote: c.quote, raw: c.raw };

    let best: CiteStatus = 'not_found';
    let bestPath: string | null = null;
    let hits = 0;
    for (const [path, content] of docs) {
      if (!path.endsWith('.md')) continue;
      const base = baseName(path);
      if (c.book && !bookMatches(base, c.book, path)) {
        continue;
      }
      const status = c.quote ? verifyQuote(c.quote, strippedSource(content)) : 'not_found';
      if (status === 'exact') hits++;
      if (RANK[status] > RANK[best]) { best = status; bestPath = path; }
    }
    const result: CitationResult = { ...c, status: best, sourcePath: bestPath, hits, ambiguous: hits > 1 };
    bucket.set(citeKey(c), result);
    return { ...result };
  });
}

/** 四档结论的中文标签与徽标，视图与工具共用 */
export const CITE_LABEL: Record<CiteStatus, string> = {
  exact: '逐字命中',
  partial: '部分命中',
  fabricated: '未逐字命中',
  not_found: '未找到出处',
};

export const CITE_MARK: Record<CiteStatus, string> = {
  exact: '✓',
  partial: '~',
  fabricated: '✗',
  not_found: '?',
};
