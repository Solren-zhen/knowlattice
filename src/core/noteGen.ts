/**
 * 智能草稿（「一」期 · AI 讲义→原子笔记草稿）。
 * 纯前端规则引擎：把讲义/教材段落按语义拆成原子笔记骨架（定义/机制/特点/分类/鉴别/治疗…），
 * 生成「属性: 内容」键值对大纲，人工审核后入库。零成本、离线可用。
 * （若日后接入真 LLM，只需替换本模块内部的分类与标题推断逻辑。）
 */
import { serializeFrontmatter } from './parser';

export interface Draft {
  title: string;
  chapter: string;
  source: string;
  tags: string[];
  body: string;
}

export type DraftFormat = 'structured' | 'excerpt';

/** 语义分类：匹配到的句子归入对应「属性键」 */
const CATEGORIES: Array<[RegExp, string]> = [
  [/定义|是什么|是指|指的是|俗称|又称|由.*引起/, '定义'],
  [/来源于|产生于|由.*(?:合成|分泌|产生)|分泌并分泌/, '来源'],
  [/机制|原理|环节|过程|途径/, '机制'],
  [/作用|功能|效应|表现为|有效应/, '作用'],
  [/特点|特征|特性|表现|症状|临床表现|体征/, '临床表现'],
  [/分类|类型|分型|包括|分为|可分为/, '分类'],
  [/鉴别|区别|对比|区分|根本区别/i, '鉴别'],
  [/治疗|处理|用药|疗法|原则|干预/, '治疗'],
  [/意义|作用|价值|重要|核心|评价/, '临床意义'],
  [/口诀|记忆|要点|记住|巧记|归纳/, '口诀'],
  [/检查|化验|试验|影像|辅助检查|指标/, '辅助检查'],
];

const ORDER = ['定义', '来源', '机制', '分类', '临床意义', '作用', '临床表现', '鉴别', '辅助检查', '治疗', '口诀', '要点'];

/** 枚举标记：1) 1、一、A. ① 等开头的「序号序列」 */
const MARKER_RE = /^\s*(?:(\d{1,2})[.、．)]|([一二三四五六七八九十]{1,3})[、.．]|([A-Ha-h])[.、)]|([①②③④⑤⑥⑦⑧⑨⑩]))\s*(.+)$/;

/** 拆条：既按句末（。；）也按「序号前」断开，保留序号便于恢复有序列表 */
function splitClauses(text: string): string[] {
  const t = text
    .replace(/\u00a0/g, ' ')
    .replace(/[#*`>]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return [];
  // 在「空格 + 序号标记」处断开（首个序号因无前导空格而保留在句首）
  const parts = t.split(/(?<=\s)(?=(?:\d{1,2}[.、．)]|[一二三四五六七八九十]{1,3}[、.．]|[A-Ha-h][.、)]|[①②③④⑤⑥⑦⑧⑨⑩]))/);
  const out: string[] = [];
  for (const p of parts) {
    for (const seg of p.split(/[。；;]/)) {
      const s = seg.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function splitMarker(s: string): { marker: string; rest: string } | null {
  const m = MARKER_RE.exec(s);
  return m ? { marker: m[1] || m[2] || m[3] || m[4] || '', rest: m[5].trim() } : null;
}

/** 正文：无序号段落按语义归组；带序号（1、/一、/A./①）的条款整体保序还原为有序列表 */
function buildBody(clauses: string[]): string {
  const numbered: string[] = [];
  const prose: string[] = [];
  for (const c of clauses) {
    const sm = splitMarker(c);
    if (sm) numbered.push(sm.rest);
    else prose.push(c);
  }

  // 语义分组（仅对无序号段落）
  const groups: Record<string, string[]> = {};
  const orderSeen: string[] = [];
  for (const s of prose) {
    const hit = CATEGORIES.find(([re]) => re.test(s));
    const key = hit ? hit[1] : '要点';
    if (!groups[key]) {
      groups[key] = [];
      orderSeen.push(key);
    }
    groups[key].push(s);
  }
  const lines: string[] = [];
  for (const cat of ORDER) {
    const arr = groups[cat];
    if (!arr?.length) continue;
    if (arr.length === 1) lines.push(`- ${cat}: ${arr[0]}`);
    else {
      lines.push(`- ${cat}:`);
      for (const s of arr) lines.push(`\t- ${s}`);
    }
  }
  for (const key of orderSeen) {
    if (ORDER.includes(key)) continue;
    const arr = groups[key];
    if (arr.length === 1) lines.push(`- ${key}: ${arr[0]}`);
    else lines.push(`- ${key}:`, ...arr.map((s) => `\t- ${s}`));
  }

  // 序号序列 → 保序还原为 md 有序列表（识别 1、/一、/A./① 等子母序列）
  if (numbered.length >= 2) {
    lines.push('- 内容:');
    numbered.forEach((s, i) => lines.push(`\t${i + 1}. ${s}`));
  } else if (numbered.length === 1) {
    lines.push(`- 内容: ${numbered[0]}`);
  }

  lines.push('', '- 我的理解: '); // 个人批注留白
  return lines.join('\n');
}

/** 从首个含「是/指/由」的句子提取主题词作为标题 */
function inferTitle(firstSentence: string, fallback: string): string {
  const m = /^(.{2,16}?)(?:是指|是|属于|即|定义|主要由|由|包括|见于|发生于|指)/.exec(firstSentence);
  if (m) return m[1].trim();
  const noun = /([\u4e00-\u9fa5A-Za-z]{3,14})/.exec(firstSentence);
  if (noun) return noun[1];
  return fallback || firstSentence.slice(0, 12);
}

/** 生成草稿：纯文本 → 标题 + 键值对正文 */
export function generateDraft(
  text: string,
  opts: { chapter?: string; source?: string; tags?: string; format?: DraftFormat } = {},
): Draft {
  const clauses = splitClauses(text);
  if (!clauses.length) throw new Error('没有可生成的内容，请粘贴讲义段落');

  const title = inferTitle(clauses[0], '');
  const body = opts.format === 'excerpt' ? text.trim() : buildBody(clauses);
  return {
    title,
    chapter: (opts.chapter ?? '').trim(),
    source: (opts.source ?? '讲义摘录').trim(),
    tags: (opts.tags ?? '').split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    body,
  };
}

/** 将一段摘录追加到已有 Markdown 笔记末尾，保留原笔记正文和 frontmatter。 */
export function appendExcerpt(markdown: string, excerpt: string): string {
  const text = excerpt.trim();
  if (!text) return markdown;
  return `${markdown.trimEnd()}\n\n${text}\n`;
}

/** 组装为完整 md 笔记（含 frontmatter），供「入库」保存 */
export function draftToMarkdown(d: Draft): string {
  const fm = serializeFrontmatter({
    aliases: [d.title],
    tags: d.tags,
    chapter: d.chapter,
    source: d.source,
    created: new Date().toISOString().slice(0, 10),
    exam: [],
  });
  return `${fm}\n# ${d.title}\n\n${d.body}\n`;
}
