/**
 * 块级锚点：给笔记里的某一段分配稳定 id，并用 `[[笔记#^id]]` 精确指到那一段。
 *
 * 为什么不用行号：行号会因为「在上面插了一行」整体作废；块 id 跟着文字走，改到哪都还能找回来。
 * 为什么把 `^id` 放在段末：与 Obsidian 同一口径——渲染时整段是一个块，标记放末尾既不打断阅读，
 * 也不会被误当成正文；剥离与写入都在这里做，界面层不各写一遍。
 *
 * 只处理「空白行分隔的段落」这一种块：标题、列表项、引用块都在段落内部，能覆盖笔记里的绝大多数场合；
 * 刻意不做嵌套块（Obsidian 的 `^id` 也只认段末）。
 */

import type { MdEdit } from './mdFormat';

/** 行尾块标记：前面要有一个空白，或整行只有它 */
export const BLOCK_ID_RE = /(?:^|\s)\^([a-z0-9]{4,10})\s*$/;

/** 取行尾/段尾的块 id；没有则 null */
export function blockIdOf(text: string): string | null {
  const tail = text.trimEnd().split('\n').pop() ?? '';
  const m = BLOCK_ID_RE.exec(tail);
  return m ? m[1] : null;
}

/**
 * 渲染前剥掉所有行尾块标记（连同它前面的空白）。
 * 不剥的话正文里会露出 `^k3f9x2` 这种谁也看不懂的尾巴。
 */
export function stripBlockIds(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s*\^([a-z0-9]{4,10})\s*$/, ''))
    .join('\n');
}

/**
 * 稳定 id：由块正文算出来，同一段文字永远是同一个 id。
 *
 * 用内容做种子而不是随机数：撤销/重做、或者把同一段复制到别处时，随机 id 会两处撞成「一对多」，
 * 而内容哈希天然让「同一段」归同一个 id（真要区分时改一个字即可）。
 */
export function makeBlockId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 再搅一次，避免短文本（比如两个字）落在同一区间
  h = (h ^ (h >>> 15)) >>> 0;
  const id = h.toString(36).padStart(6, '0').slice(0, 6);
  // 纯数字开头没有歧义，但 base36 里可能出现 '0' 连续，这里不做额外修饰：id 只要求唯一与稳定
  return id;
}

/** 光标所在段落的字符区间（空白行分隔；文档边界也算分隔） */
export function paragraphBounds(doc: string, pos: number): { from: number; to: number } {
  const clamped = Math.max(0, Math.min(pos, doc.length));
  let lineStart = doc.lastIndexOf('\n', Math.max(0, clamped - 1)) + 1;
  let lineEnd = doc.indexOf('\n', clamped);
  if (lineEnd < 0) lineEnd = doc.length;
  // 光标落在空行上：就地当成一个空段落，交给调用方判断（ensureBlockId 会因为没内容返回 null）。
  // 必须先判空再向外扩——否则「上一段\n\n光标\n\n下一段」会把上一段的空行和下一段连成一个块。
  if (!doc.slice(lineStart, lineEnd).trim()) return { from: lineStart, to: lineEnd };
  let from = lineStart;
  let to = lineEnd;
  while (from > 0) {
    const prevStart = doc.lastIndexOf('\n', Math.max(0, from - 2)) + 1;
    const prev = doc.slice(prevStart, from - 1);
    if (!prev.trim()) break;
    from = prevStart;
  }
  while (to < doc.length) {
    const nextEnd = doc.indexOf('\n', to + 1);
    const stop = nextEnd < 0 ? doc.length : nextEnd;
    const next = doc.slice(to + 1, stop);
    if (!next.trim()) break;
    to = stop;
  }
  return { from, to };
}

/**
 * 给光标所在段落补一个块 id。
 * 已经有 id 就不动文档（只把 id 交回去）；段落是空的返回 null——空块没有内容可指。
 */
export function ensureBlockId(doc: string, pos: number): { id: string; edit: MdEdit | null } | null {
  const { from, to } = paragraphBounds(doc, pos);
  const block = doc.slice(from, to);
  if (!block.trim()) return null;
  const existing = blockIdOf(block);
  if (existing) return { id: existing, edit: null };
  const id = makeBlockId(block);
  const tail = doc[to - 1] === ' ' || doc[to - 1] === '\t' ? `^${id}` : ` ^${id}`;
  const edit: MdEdit = {
    changes: [{ from: to, to, insert: tail }],
    selection: { anchor: to + tail.length, head: to + tail.length },
  };
  return { id, edit };
}

/** `[[笔记#^id]]`；笔记名里已有扩展名时去掉（vault 里链的是名字不是路径） */
export function blockRef(noteName: string, id: string): string {
  const name = noteName.replace(/\.md$/i, '').trim();
  return `[[${name}#^${id}]]`;
}

/**
 * 拆开「笔记#^id」：给点击跳转用。
 * 只认 `#^xxx`（块引用）；`#标题` 那种片段原样留在名字里，交回给原来的双链逻辑。
 */
export function splitBlockTarget(target: string): { name: string; block: string | null } {
  const m = /^(.*)#\^([a-z0-9]{4,10})$/i.exec(target.trim());
  if (!m) return { name: target.trim(), block: null };
  return { name: m[1].trim(), block: m[2].toLowerCase() };
}

/** 在一篇笔记正文里找出某个块（含 ^id 的那一段，已剥标记），供引用时回显或跳转定位 */
export function findBlockText(doc: string, id: string): string | null {
  const lines = doc.split('\n');
  const idx = lines.findIndex((line) => new RegExp(`\\^${id}\\s*$`, 'i').test(line));
  if (idx < 0) return null;
  let from = idx;
  let to = idx;
  while (from > 0 && lines[from - 1].trim()) from -= 1;
  while (to < lines.length - 1 && lines[to + 1].trim()) to += 1;
  return stripBlockIds(lines.slice(from, to + 1).join('\n')).trim();
}
