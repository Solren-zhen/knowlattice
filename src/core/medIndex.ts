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
import { buildChunks, type EvidenceUnit } from './docIndex';
import { expandQuery } from './medSynonyms';
import { queryFragments } from './aiAgent';
import { pageAnchor, pageAnchors, stripPageAnchors } from './pageAnchor';

/** 单条命中正文的展示上限，避免一次工具结果撑爆上下文 */
export const MED_HIT_TEXT_LIMIT = 900;

/** 每本书最多返回的命中段落数：段落数量不该被书数卡死（两本书 × limit=6 只出 2 条太窄） */
export const MED_HITS_PER_BOOK = 3;

export interface MedBookHit {
  /** 教材名（文件名去扩展名，如「内科学（第10版）」） */
  book: string;
  /** 印刷页码（= PDF 物理页 − 偏移；未设偏移时两者相同，0 = 该段无页码锚点） */
  page: number;
  /** 段落终点页（跨页段落与 page 不同）；0 = 无 */
  endPage: number;
  /** 所属小节标题（'' = 无） */
  section: string;
  /** 命中的段落原文（已剥离页码锚点） */
  text: string;
  /** 稳定标识：书名 + 段落起点 */
  chunkId: string;
  /** 弱命中：全书只有个别关键词片段出现，建议换更具体的词再查 */
  weak?: boolean;
  score: number;
}

export interface MedBookInfo {
  title: string;
  pages: number;
  /** 有文字的页数（扫描页为 0） */
  extractablePages: number;
}

/** 检索输入：lower / pageOffset 由调用方（medBooks）按缓存与设置提供，纯函数自身不算 */
export interface MedBookInput {
  name: string;
  text: string;
  /** 全文小写（缓存友好：教材全文百万字级，每次查询现算 toLowerCase 是重复开销） */
  lower?: string;
  /** 页码偏移 = PDF 物理页 − 印刷页 */
  pageOffset?: number;
}

/** 由逐页文本拼成带页码锚点的 Markdown（页码从 1 起） */
export function pagesToMarkdown(pages: string[]): string {
  return pages
    .map((t, i) => `${pageAnchor(i + 1)}\n${t.replace(/\r\n?/g, '\n').trim()}`)
    .join('\n\n');
}

/** 物理页 → 印刷页（偏移可把页码压到 1 以下时取 1） */
export function printedPage(pdfPage: number, offset = 0): number {
  return Math.max(1, pdfPage - Math.max(0, offset));
}

/**
 * 从带页码锚点的 Markdown 里取某物理页的整页正文（锚点间内容，已剥离锚点）。
 * 页不存在返回 null；页码按锚点实际值匹配，空页也能取到（返回空串）。
 */
export function extractPage(markdown: string, page: number): string | null {
  const anchors = pageAnchors(markdown);
  const at = anchors.findIndex((a) => a.page === page);
  if (at < 0) return null;
  const start = anchors[at].index + pageAnchor(anchors[at].page).length;
  const end = at + 1 < anchors.length ? anchors[at + 1].index : markdown.length;
  return stripPageAnchors(markdown.slice(start, end)).trim();
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
 * 再按相邻两字滑窗做片段召回（与 searchNotes 同一规则）。
 *
 * 两级打分：书级（片段是否出现在书名/正文，决定这本书进不进结果）＋
 * 段落级（命中片段最密集的证据单元胜出）。每本书取最密集的前 MED_HITS_PER_BOOK 段，
 * 全局按分排序后截断——书少时也能凑满 limit。
 */
export function searchMedBooks(
  books: MedBookInput[],
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
    const lower = b.lower ?? content.toLowerCase();
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
    // 弱命中：原词的片段一个都没出现、纯靠等价词表召回（如查「心梗」只命中文本里的「心肌梗死」）。
    // 这类命中仍返回，但打上标记让模型自己判断要不要换词再查。
    const origFrags = new Set<string>();
    for (const term of terms) for (const frag of queryFragments(term)) origFrags.add(frag);
    let origMatched = false;
    for (const frag of origFrags) if (matchedFrags.has(frag)) { origMatched = true; break; }
    const weak = !origMatched;

    // 段落级细检：命中片段最密集的前几段胜出，各段继承小节与页码
    const scored: Array<{ unit: EvidenceUnit; score: number }> = [];
    for (const u of buildChunks(content, `${b.name}.md`)) {
      // 纯标题单元（文本就是标题行）不算命中候选：标题只是坐标，不是可引用的正文
      if (u.heading && u.text.replace(/^#+\s*/, '').trim() === u.heading) continue;
      const ul = u.text.toLowerCase();
      let s = 0;
      for (const frag of matchedFrags) {
        let at = ul.indexOf(frag);
        while (at >= 0) { s++; at = ul.indexOf(frag, at + frag.length); }
      }
      const hl = u.heading.toLowerCase();
      for (const frag of matchedFrags) if (hl.includes(frag)) s += 2;
      if (s > 0) scored.push({ unit: u, score: s });
    }
    scored.sort((a, z) => z.score - a.score);

    const offset = b.pageOffset ?? 0;
    for (const { unit, score } of scored.slice(0, MED_HITS_PER_BOOK)) {
      const page = unit.page ? printedPage(unit.page, offset) : 0;
      const endPage = unit.endPage && unit.endPage !== unit.page ? printedPage(unit.endPage, offset) : 0;
      hits.push({
        book: b.name,
        page,
        endPage,
        section: unit.heading,
        text: unit.text,
        chunkId: `${b.name}#${unit.start}`,
        weak: weak || undefined,
        score: docScore + score,
      });
    }
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
      const span = h.endPage && h.endPage !== h.page ? `${h.page}-${h.endPage}` : `${h.page}`;
      const where = `《${h.book}》${h.page ? ` P${span}` : ''}${h.section ? ` §${h.section}` : ''}`
        + (h.weak ? '（弱命中：仅个别关键词出现，建议换更具体的关键词再查）' : '');
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
