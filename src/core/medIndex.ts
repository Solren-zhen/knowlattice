/**
 * 本机医学教材索引：把教材 PDF 抽成带页码锚点的 Markdown，切「小节 → 段落」两级，
 * 让助手像查笔记一样查教材——页码、章节、原文都来自本地，不依赖任何外部服务。
 *
 * 本模块只做**纯逻辑**（切分与检索），不碰存储、不碰 pdf.js：
 * - 存储见 storage/medStore.ts（IndexedDB）
 * - 导入见 core/medImport.ts（PDF → 文本）
 * 检索复用与笔记检索同一套片段规则（相邻两字滑窗 + 等价词表）与同一套证据单元
 * （docIndex.buildChunks），保证「教材」与「笔记」两处的引用坐标口径一致。
 */
import { buildChunks } from './docIndex';
import { expandQuery } from './medSynonyms';
import { queryFragments } from './aiAgent';
import { pageAnchor } from './pageAnchor';

/** 单条命中正文的展示上限，避免一次工具结果撑爆上下文 */
export const MED_HIT_TEXT_LIMIT = 900;

export interface MedBookHit {
  /** 教材名（文件名去扩展名，如「内科学（第10版）」） */
  book: string;
  /** PDF 物理页号（从封面第 1 页数起；0 = 该段无页码锚点）。可能与原书印刷页码有偏移 */
  page: number;
  /** 所属小节标题（'' = 无） */
  section: string;
  /** 命中的段落原文（已剥离页码锚点） */
  text: string;
  /** 稳定标识：书名 + 段落起点 */
  chunkId: string;
  score: number;
}

export interface MedBookInfo {
  title: string;
  pages: number;
  /** 有文字的页数（扫描页为 0） */
  extractablePages: number;
}

/** 由逐页文本拼成带页码锚点的 Markdown（页码从 1 起） */
export function pagesToMarkdown(pages: string[]): string {
  return pages
    .map((t, i) => `${pageAnchor(i + 1)}\n${t.replace(/\r\n?/g, '\n').trim()}`)
    .join('\n\n');
}

/**
 * 教材名匹配。模型给的 book 参数五花八门（「内科学」「内科学（第10版）」「内科学 第10版」），
 * 简单双向子串对「带空格的变体」会失效（'内科学（第10版）' 不含 '内科学 第10版'）。
 * 口径：多段（空格分隔）时每段都要在书名里出现（顺序不限）；单段沿用双向包含。
 * citeVerify 的书名限定同口径。
 */
export function bookMatches(name: string, wanted: string): boolean {
  if (!wanted.trim()) return true;
  const n = name.toLowerCase();
  const parts = wanted.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.every((p) => n.includes(p));
  const q = parts[0];
  return n.includes(q) || q.includes(n);
}

/**
 * 在教材集合里检索：空格分隔多关键词需同时命中，每个关键词先做等价词展开，
 * 再按相邻两字滑窗做片段召回（与 searchNotes 同一规则）。命中最密集的段落胜出，
 * 并继承其所属小节与页码。
 */
export function searchMedBooks(
  books: Array<{ name: string; text: string }>,
  query: string,
  limit = 6,
  book?: string
): MedBookHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const wanted = (book ?? '').trim();
  const hits: MedBookHit[] = [];

  for (const b of books) {
    if (!bookMatches(b.name, wanted)) continue;
    const content = b.text;
    const lower = content.toLowerCase();
    const lowerName = b.name.toLowerCase();

    let docScore = 0;
    // Set 去重：不同等价词常共享两字片段，重复片段会虚增段落密度分
    const matchedFrags = new Set<string>();
    let matchedAll = true;
    for (const term of terms) {
      let matched = false;
      for (const variant of expandQuery(term)) {
        const frags = queryFragments(variant);
        const need = Math.max(1, Math.ceil(frags.length / 2));
        let hit = 0;
        for (const frag of frags) {
          const inName = lowerName.includes(frag);
          const inText = lower.includes(frag);
          if (!inName && !inText) continue;
          hit++;
          if (inName) docScore += 5 / frags.length;
          if (inText) { docScore += 1 / frags.length; matchedFrags.add(frag); }
        }
        if (hit >= need) { matched = true; break; }
      }
      if (!matched) { matchedAll = false; break; }
    }
    if (!matchedAll || !matchedFrags.size) continue;

    // 段落级细检：命中片段最密集的证据单元胜出，并继承小节与页码
    let best = { heading: '', page: null as number | null, text: content, start: 0 };
    let bestScore = -1;
    for (const u of buildChunks(content, `${b.name}.md`)) {
      const ul = u.text.toLowerCase();
      let s = 0;
      for (const frag of matchedFrags) {
        let at = ul.indexOf(frag);
        while (at >= 0) { s++; at = ul.indexOf(frag, at + frag.length); }
      }
      const hl = u.heading.toLowerCase();
      for (const frag of matchedFrags) if (hl.includes(frag)) s += 2;
      if (s > bestScore) { bestScore = s; best = { heading: u.heading, page: u.page, text: u.text, start: u.start }; }
    }

    hits.push({
      book: b.name,
      page: best.page ?? 0,
      section: best.heading,
      text: best.text,
      chunkId: `${b.name}#${best.start}`,
      score: docScore + bestScore,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** 排版检索结果：书名 + 页码 + 章节，正文截断；空结果给出明确提示 */
export function formatMedHits(hits: MedBookHit[]): string {
  if (!hits.length) {
    return '教材库没有检索到相关段落。换更具体的解剖/病理/药物关键词再试，'
      + '或先用 list_medical_books 看有哪些教材；若清单为空，先在「设置 → 医学教材库」导入教材 PDF。';
  }
  return hits
    .map((h) => {
      const where = `《${h.book}》${h.page ? ` P${h.page}` : ''}${h.section ? ` §${h.section}` : ''}`;
      const text = h.text.replace(/\s+/g, ' ').trim();
      const shown = text.length > MED_HIT_TEXT_LIMIT ? `${text.slice(0, MED_HIT_TEXT_LIMIT)}…` : text;
      return `${where}\n  ｜ ${shown}\n  chunk_id=${h.chunkId}`;
    })
    .join('\n\n');
}

/** 排版教材清单 */
export function formatMedBooks(books: MedBookInfo[]): string {
  if (!books.length) {
    return '教材库为空：尚未导入任何教材。请到「设置 → 医学教材库」导入教材 PDF（可多选）。';
  }
  const lines = books.map((b) => `《${b.title}》 ${b.pages} 页（可检索 ${b.extractablePages} 页）`);
  return `已导入 ${books.length} 本教材：\n${lines.join('\n')}`;
}
