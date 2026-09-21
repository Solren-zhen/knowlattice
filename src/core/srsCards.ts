/**
 * M6+ · 复习卡片的粒度：一篇笔记 → 若干张卡。
 *
 * 起因：一篇笔记（例如「7.8 心律失常全+心脏骤停」，19,420 字符 / 20 个 `##` / 38 个 `###`）
 * 以前只算一张卡——正面给标题和属性键，背面把整篇甩出来。回忆变成全有全无，FSRS 拿到的
 * 评分也没有信息量：一次「忘了」把整章重置，一次「简单」把整章推远。
 * 而真实笔记里 `##`/`###` 就是天然的知识点边界（考频、首选检查、心电图诊断…），
 * 按小节切卡才符合「一次记一个点」。
 *
 * 切卡规则（纯函数，可单测）：
 *   1. 有 `##` 就按 `##` 切；没有 `##` 才退回 `###`；两者都没有 → 整篇一张卡，**键就是 path**
 *      （与旧数据完全同键，既有调度一格不动）。
 *   2. 第一个小节标题之前的正文单独成一张「总览」卡；正文为空则不出卡。
 *   3. 卡键 = `<path>#<小节标题>`：**标题改名 = 新卡，重新排序不会串卡**（用序号做键会串）。
 *      同一篇里标题重复时补 `#2`、`#3`。
 *   4. 每张卡带上本小节里的属性键，供正面做回忆提示。
 *   5. 整篇只有标题、没有任何正文时退回整篇卡——别让笔记从队列里消失。
 */
import { parseFrontmatter } from './parser';

export interface ReviewCard {
  /** 调度键：`<path>`（整篇卡）或 `<path>#<小节标题>`（小节卡） */
  key: string;
  /** 所属笔记路径 */
  path: string;
  /** 笔记标题（出自哪一篇） */
  noteTitle: string;
  /** 小节标题；整篇卡为空字符串 */
  heading: string;
  /** 这张卡的答案正文（小节卡只含本小节，含其下的 ### 子标题） */
  body: string;
  /** 本小节里的属性键（正面提示，值不给） */
  hints: string[];
  /**
   * 迁移用：该篇笔记若还留着旧的「整篇卡」调度，键记在这里（只有首张卡会带）。
   * 首次评分时把旧调度写到自己键下并删掉旧键，进度不丢、也不会被算两次。
   */
  legacyKey?: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * 属性键：`- 键: 值` 形式（键里不含空格，避免把整句正文当成键）。
 * 与新建向导的骨架（`- 定义: `）同口径，正面只给键、不给值。
 */
export function cardHints(body: string): string[] {
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^(\s*-\s*)([^:\n【[]{1,12})(\s*):/.exec(line);
    if (m && !/\s/.test(m[2])) keys.push(m[2].trim());
  }
  return keys;
}

/** 整篇卡（没有小节、或整篇只有标题时的兜底） */
function wholeNoteCard(path: string, noteTitle: string, body: string): ReviewCard {
  return { key: path, path, noteTitle, heading: '', body: body.trim(), hints: cardHints(body) };
}

export function splitNoteIntoCards(path: string, raw: string): ReviewCard[] {
  const { body, title } = parseFrontmatter(raw);
  const noteTitle = title || path.replace(/\.md$/, '').split('/').pop() || path;
  const lines = body.split('\n');
  // H1 是笔记标题（正面已经以「出自」显示），不参与切卡：
  // 否则「总览」卡里只剩一行标题，还会把「只有标题的笔记」误判成有内容
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 >= 0) lines.splice(h1, 1);

  // 用最浅的一级标题切：有 ## 就按 ##，没有才退回 ###
  let level = 0;
  for (const l of lines) {
    const m = HEADING_RE.exec(l);
    if (!m) continue;
    const n = m[1].length;
    if (n < 2) continue;
    if (!level || n < level) level = n;
    if (level === 2) break;
  }
  if (!level) return [wholeNoteCard(path, noteTitle, body)];

  const sections: Array<{ heading: string; lines: string[] }> = [];
  const introLines: string[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const l of lines) {
    const m = HEADING_RE.exec(l);
    if (m && m[1].length === level) {
      cur = { heading: m[2].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    // 更深的标题（### 及以下）留在所属小节里，成为这张卡正文的一部分
    if (cur) cur.lines.push(l);
    else introLines.push(l);
  }

  const used = new Map<string, number>();
  const keyFor = (heading: string) => {
    const n = (used.get(heading) ?? 0) + 1;
    used.set(heading, n);
    return n === 1 ? `${path}#${heading}` : `${path}#${heading}#${n}`;
  };

  const cards: ReviewCard[] = [];
  const intro = introLines.join('\n').trim();
  if (intro) {
    cards.push({ key: `${path}#~总览`, path, noteTitle, heading: '总览', body: intro, hints: cardHints(intro) });
  }
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    if (!text) continue; // 只有标题、没有正文的小节不出卡
    cards.push({ key: keyFor(s.heading), path, noteTitle, heading: s.heading, body: text, hints: cardHints(text) });
  }
  if (!cards.length) return [wholeNoteCard(path, noteTitle, body)];

  // 首张卡继承旧的整篇卡调度（迁移只发生一次，见 srs.applyReview）
  cards[0].legacyKey = path;
  return cards;
}

/** 全库建卡：只取 .md，按传入顺序（与队列顺序一致） */
export function buildCards(paths: string[], docs: Map<string, string>): ReviewCard[] {
  const out: ReviewCard[] = [];
  for (const p of paths) {
    if (!p.endsWith('.md')) continue;
    out.push(...splitNoteIntoCards(p, docs.get(p) ?? ''));
  }
  return out;
}
