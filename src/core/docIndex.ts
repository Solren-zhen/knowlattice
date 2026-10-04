/**
 * 可寻址证据单元：把一篇笔记切成「小节 → 段落」两级，每段带上所属小节、页码与字符区间，
 * 供检索（先定位章节、再段内细检）与引用核验共用同一套坐标，避免页码/小节各造一份元数据。
 *
 * 短笔记（< LONG_NOTE）退化为整篇一个单元，行为与旧的整篇检索一致，
 * 只有长教材笔记才承担切分开销——长文里「整篇打分」必然失焦。
 * 页码锚点独占一行，切分时按「页标记」跳过，不作为段落内容。
 */
import { parseOutline } from './outline';
import { PAGE_ANCHOR_LINE_RE, pageAnchors, stripPageAnchors } from './pageAnchor';

/** 超过该长度才做父子切分；短笔记整篇一个单元 */
export const LONG_NOTE = 4_000;

export interface EvidenceUnit {
  path: string;
  /** 所属小节标题（'' = 正文前 / 无标题） */
  heading: string;
  /** 小节标题所在行号（1-based，0 = 无） */
  headingLine: number;
  /** 最近的页码锚点页号（无锚点则 null） */
  page: number | null;
  /** 在原文 content 中的字符起点 */
  start: number;
  /** 字符终点（不含） */
  end: number;
  /** 单元正文（已剥离页码锚点） */
  text: string;
}

/** 切分缓存：检索与引用核验会反复切分同一批长笔记，同一篇（路径 + 内容）只算一次。
 *  预算与逐出策略与 citeVerify 的 SOURCE_PREP_CACHE 同口径（8M 字符、逐出最旧），防内存膨胀。 */
const CHUNK_CACHE = new Map<string, EvidenceUnit[]>();
const CHUNK_CACHE_MAX_CHARS = 8_000_000;
let chunkCacheChars = 0;

/**
 * 把一篇笔记切成证据单元：以空行为段落边界，每段继承上方最近的标题与页码。
 * content 传原文（含锚点）；单元 text 已剥离锚点，可直接用于匹配与展示。
 * 结果按 (path, content) 缓存：命中时返回数组浅拷贝，调用方 sort/push 不会污染缓存
 * （单元对象本身复用，调用方只读）。
 */
export function buildChunks(content: string, path: string): EvidenceUnit[] {
  const key = `${path}\u0000${content}`;
  const hit = CHUNK_CACHE.get(key);
  if (hit) return hit.slice();

  const units = buildChunksUncached(content, path);
  chunkCacheChars += key.length;
  CHUNK_CACHE.set(key, units);
  while (CHUNK_CACHE.size > 1 && chunkCacheChars > CHUNK_CACHE_MAX_CHARS) {
    const oldest = CHUNK_CACHE.keys().next().value!;
    chunkCacheChars -= oldest.length;
    CHUNK_CACHE.delete(oldest);
  }
  return units.slice();
}

/** buildChunks 的实际切分逻辑（不缓存） */
function buildChunksUncached(content: string, path: string): EvidenceUnit[] {
  const anchors = pageAnchors(content);
  if (content.length < LONG_NOTE) {
    return [{
      path, heading: '', headingLine: 0,
      page: anchors.length ? anchors[0].page : null,
      start: 0, end: content.length, text: stripPageAnchors(content),
    }];
  }

  const lines = content.split('\n');
  const lineStart: number[] = [];
  {
    let pos = 0;
    for (const l of lines) { lineStart.push(pos); pos += l.length + 1; }
  }
  const heads = parseOutline(content);

  const headingAt = (lineIdx: number): { text: string; line: number } => {
    let h = { text: '', line: 0 };
    for (const o of heads) {
      if (o.line - 1 <= lineIdx) h = { text: o.text, line: o.line };
      else break;
    }
    return h;
  };
  const pageAt = (idx: number): number | null => {
    let page: number | null = null;
    for (const a of anchors) {
      if (a.index <= idx) page = a.page;
      else break;
    }
    return page;
  };

  const units: EvidenceUnit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim() || PAGE_ANCHOR_LINE_RE.test(lines[i])) { i++; continue; }
    const startLine = i;
    let j = i;
    while (j < lines.length && lines[j].trim() && !PAGE_ANCHOR_LINE_RE.test(lines[j])) j++;
    const endLine = j - 1;
    const start = lineStart[startLine];
    const end = lineStart[endLine] + lines[endLine].length;
    const h = headingAt(startLine);
    units.push({
      path,
      heading: h.text,
      headingLine: h.line,
      page: pageAt(start),
      start,
      end,
      text: content.slice(start, end),
    });
    i = j;
  }
  return units;
}

/** 一次切分多篇笔记（仅 .md），返回 path → 单元数组 */
export function buildDocChunks(docs: Map<string, string>): Map<string, EvidenceUnit[]> {
  const out = new Map<string, EvidenceUnit[]>();
  for (const [path, content] of docs) {
    if (!path.endsWith('.md')) continue;
    out.set(path, buildChunks(content, path));
  }
  return out;
}
