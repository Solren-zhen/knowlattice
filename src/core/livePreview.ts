/**
 * M8 · 所见即所得混合预览（CM6 decorations）——Obsidian 式。
 * 光标所在行显示源码，其余行实时渲染为排版效果——新手看到的是"排好版的文档"，
 * 点任何位置即回到源码可编辑，无需学习任何 md 语法。
 *
 * 支持渲染：标题 / 列表（有序自动编号）/ 引用块 / 分割线 /
 * **加粗** / *斜体* / ***粗斜体*** / ==高亮== / `行内代码` / 围栏代码块 /
 * 图片 ![](路径) / Obsidian 嵌入 ![[图片.png]] / ![[笔记]] / 标准链接 / [[双链]] / 「属性: 」键加粗。
 * 标记符（** == ` *）一律隐藏，只留排版效果。
 * 未覆盖的语法保持源码原样显示，不破坏可编辑性。
 *
 * 实现要点：
 * 1. 装饰集放在 StateField（静态值）而不是 ViewPlugin——CM 规定 ViewPlugin 的动态装饰
 *    不允许 block 部件与跨行替换（会抛 RangeError），StateField 没有这个限制。
 * 2. 加粗/斜体等用整段 replace 部件渲染（标记符随之隐藏）；候选按优先级去重叠，
 *    避免 replace 部件互相嵌套冲突（如 **[[双链]]** 里双链优先）。
 * 3. 部件 ignoreEvent 返回 false——CM 默认忽略部件内一切事件，不重写覆盖
 *    会导致实时预览里的双链/链接点击完全失效。
 */
import { EditorState, StateEffect, StateField, RangeSet, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { isPathwayLang, renderPathwaySvg } from './pathway';

export type ReadFileFn = (path: string) => string | undefined;

const imgExtRe = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// ---------- 渲染小部件 ----------

class HtmlWidget extends WidgetType {
  private html: string;
  private cls: string;
  constructor(html: string, cls: string) {
    super();
    this.html = html;
    this.cls = cls;
  }
  eq(o: HtmlWidget) { return o.html === this.html && o.cls === this.cls; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    s.innerHTML = this.html;
    return s;
  }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'lp-hr';
    return d;
  }
}

/**
 * 行内标记的零宽部件：只吃掉「首尾标记符」本身（`**` / `==` / `` ` ``），
 * 中间内容保持原文本、只是加一层样式。
 *
 * 关键差异：以前是「整段 replace」——内容变成原子的，光标进不去，只能靠「光标行显示源码」
 * 让人看得见、改得动，于是 `**` 就露出来了。现在标记符单独吃掉、内容不原子，
 * 光标可以自由落进加粗文字里继续改字，标记符在任何行（含光标行）都不显示。
 */
class ZeroWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lp-mark-hidden';
    return s;
  }
}

// ---------- 行内语法扫描（纯函数，便于单测） ----------

/** 行内语法种类：前四种整段变成原子部件，后五种只吃掉标记符、内容仍可编辑 */
export type InlineKind = 'embed' | 'img' | 'wiki' | 'link' | 'tri' | 'bold' | 'code' | 'highlight' | 'italic';

/** 命中一段行内语法：位置 + 种类 + 优先级 + 两个捕获组（去重叠与渲染由调用方负责） */
export interface InlineHit {
  from: number;
  to: number;
  prio: number;
  kind: InlineKind;
  a: string;
  b: string;
}

/** 只吃标记符的种类的标记长度：做嵌套判定时要扣掉外层标记符本身，避免两层标记符相撞 */
const DELIM_LEN: Partial<Record<InlineKind, number>> = { tri: 3, bold: 2, code: 1, highlight: 2, italic: 1 };

/** 原子部件（嵌入/图片/双链/链接）：内部没有可标注的文本，光标也进不去 */
const ATOMIC: ReadonlySet<InlineKind> = new Set<InlineKind>(['embed', 'img', 'wiki', 'link']);

/**
 * 扫描一行里所有行内语法候选，按优先级排序（数值小的先渲染）。
 * 优先级：嵌入 > 标准图片 > 双链 > 链接 > 粗斜体 > 加粗 > 行内代码 > 高亮 > 斜体。
 *
 * 加粗的内容为什么不是 `\*\*([^*]+)\*\*`：那种写法遇到「内容里带单个星号」（`**a*b**`）
 * 或「三星号粗斜体」（`***x***`）就匹配不上，星号会裸露在正文里——而 `***…***` 正是
 * Word 转换器（convert.ts）会产出的写法。这里改成「非星号字符 或 单个星号（后面不跟
 * 星号）」的内容式，并在开闭处用 `(?<!\*)` / `(?!\*)` 卡住边界：三星号整段交给 tri，
 * `**a*b**` 交给 bold，两边都不再漏标记符。
 */
/**
 * 行内扫描规则（模块级共享）：正则字面量每次求值都会新建 RegExp 对象，
 * 原来定义在函数体内意味着每扫一行分配 9 个正则——叠加「每次按键全文档重扫」
 * 是可观的 GC 压力。matchAll 内部克隆正则、不动共享实例的 lastIndex，共享安全。
 */
const INLINE_RULES: ReadonlyArray<readonly [RegExp, number, InlineKind]> = [
  [/!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, 0, 'embed'],
  [/!\[([^\]]*)\]\(([^)]+)\)/g, 1, 'img'],
  [/(?<!!)\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, 2, 'wiki'],
  [/(?<!!)\[([^\]\n]+?)\]\(([^)]+)\)/g, 3, 'link'],
  [/(?<!\*)\*\*\*(?!\*)((?:[^*\n]|\*(?!\*\*))+?)\*\*\*(?!\*)/g, 4, 'tri'],
  [/(?<!\*)\*\*(?!\*)((?:[^*\n]|\*(?!\*))+?)\*\*(?!\*)/g, 5, 'bold'],
  [/`([^`\n]+)`/g, 6, 'code'],
  [/==([^=\n]+)==/g, 7, 'highlight'],
  [/(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, 8, 'italic'],
];

/** 行内标记的起始字符：一行里没有这些字符就不可能命中任何行内语法。
 *  纯正文/列表/引用行（绝大多数）一次测试就跳过 9 个正则。 */
const INLINE_HINT = /[*`=![]/;

/** 扫描结果缓存（键 = 行文本，纯函数于文本所以跨构建复用安全）：
 *  重建装饰时未改动的行（以及全文重复的短行、表格单元格）全部命中，
 *  只有本次编辑的那一两行真正跑正则。有界，满了整表重建。 */
const SCAN_CACHE_MAX = 2048;
const scanCache = new Map<string, InlineHit[]>();

export function scanInline(lineText: string): InlineHit[] {
  const hit = scanCache.get(lineText);
  if (hit) return hit;
  const out = scanInlineUncached(lineText);
  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.clear();
  scanCache.set(lineText, out);
  return out;
}

function scanInlineUncached(lineText: string): InlineHit[] {
  if (!INLINE_HINT.test(lineText)) return [];
  const hits: InlineHit[] = [];
  for (const [re, prio, kind] of INLINE_RULES) {
    for (const m of lineText.matchAll(re)) {
      hits.push({ from: m.index, to: m.index + m[0].length, prio, kind, a: m[1] ?? '', b: m[2] ?? '' });
    }
  }
  hits.sort((x, y) => x.prio - y.prio || x.from - y.from);
  return hits;
}

/**
 * 从候选里挑出真正要渲染的那些（顺序即渲染顺序）：与已接受范围重叠的丢弃，
 * 唯一例外是「只吃标记符」的两层嵌套——`==*高亮*==` 的内层星号必须一起吃掉。
 * 嵌套要求内层完全落在外层的内容区间（扣掉外层标记符）里：两层标记符一旦重叠，
 * CM 的 replace 装饰会直接抛错。这段判定单独抽出来就是为了能单测。
 */
export function pickInline(hits: InlineHit[], editable = false): InlineHit[] {
  const taken: InlineHit[] = [];
  for (const c of hits) {
    if (editable && ATOMIC.has(c.kind)) continue;
    const clash = taken.some((t) => {
      if (!(c.from < t.to && c.to > t.from)) return false;
      const d = DELIM_LEN[t.kind] ?? 0;
      return !(d > 0 && DELIM_LEN[c.kind] && c.from >= t.from + d && c.to <= t.to - d);
    });
    if (clash) continue;
    taken.push(c);
  }
  return taken;
}

const FORMAT_KINDS: ReadonlySet<InlineKind> = new Set(['tri', 'bold', 'highlight', 'italic', 'code']);

/** Render editable inline emphasis inside table cells without interpreting HTML. */
function appendInlineText(parent: HTMLElement, text: string): void {
  const hits = pickInline(scanInline(text), false)
    .filter((hit) => FORMAT_KINDS.has(hit.kind))
    .sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const hit of hits) {
    if (hit.from < cursor) continue;
    if (hit.from > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, hit.from)));
    if (hit.kind === 'code') {
      const code = document.createElement('code');
      code.className = 'lp-code';
      code.textContent = hit.a;
      parent.appendChild(code);
    } else {
      const span = document.createElement('span');
      span.className = hit.kind === 'tri' ? 'lp-bold lp-italic' : hit.kind === 'bold' ? 'lp-bold' : hit.kind === 'highlight' ? 'lp-highlight' : 'lp-italic';
      appendInlineText(span, hit.a);
      parent.appendChild(span);
    }
    cursor = hit.to;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

/** 表格块：整块替换为真实 <table>（跨多行，须为块级部件 + block 装饰） */
class TableWidget extends WidgetType {
  private rows: string[];
  constructor(rows: string[]) {
    super();
    this.rows = rows;
  }
  ignoreEvent() { return false; }
  eq(o: TableWidget) { return o.rows.join('\n') === this.rows.join('\n'); }
  toDOM() {
    const split = (s: string) =>
      s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const rows = this.rows;
    const header = split(rows[0]);
    // 分隔行推断每列对齐：:---: 居中，:--- 左，---: 右
    const align = split(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : 'left'));
    const table = document.createElement('table');
    table.className = 'lp-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    header.forEach((h, i) => {
      const th = document.createElement('th');
      th.style.textAlign = align[i] ?? 'left';
      appendInlineText(th, h);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of rows.slice(2)) {
      const tr = document.createElement('tr');
      split(r).forEach((c, i) => {
        const td = document.createElement('td');
        td.style.textAlign = align[i] ?? 'left';
        appendInlineText(td, c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }
}

/** 图片部件：真实 <img>（dataURL 经 vault readFile 解析）；block 装饰时独占整行 */
class ImgWidget extends WidgetType {
  private src: string;
  private alt: string;
  constructor(src: string, alt: string) {
    super();
    this.src = src;
    this.alt = alt;
  }
  ignoreEvent() { return false; }
  eq(o: ImgWidget) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'lp-img';
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    return img;
  }
}

/** 附件缺失的图片嵌入：占位卡（导入图片附件后自动变成真图） */
class EmbedMissingWidget extends WidgetType {
  private name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  ignoreEvent() { return false; }
  eq(o: EmbedMissingWidget) { return o.name === this.name; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lp-embed-missing';
    s.textContent = `${this.name}（图片未导入）`;
    return s;
  }
}

/** 标准链接部件：点开外链（data-lp-url 供 DOM 目标可靠取 URL） */
class LinkWidget extends WidgetType {
  private url: string;
  private text: string;
  constructor(text: string, url: string) {
    super();
    this.text = text;
    this.url = url;
  }
  ignoreEvent() { return false; }
  eq(o: LinkWidget) { return o.text === this.text && o.url === this.url; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lp-link';
    s.textContent = this.text;
    s.setAttribute('data-lp-url', this.url);
    return s;
  }
}

/** 双链部件：点击跳转笔记（data-lp-target 存目标名，DOM 目标可靠） */
class WikiWidget extends WidgetType {
  private label: string;
  private target: string;
  constructor(label: string, target: string) {
    super();
    this.label = label;
    this.target = target;
  }
  ignoreEvent() { return false; }
  eq(o: WikiWidget) { return o.label === this.label && o.target === this.target; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lp-wiki';
    s.textContent = this.label;
    s.setAttribute('data-lp-target', this.target);
    return s;
  }
}

/** 围栏代码块部件：跨行 <pre>（保留原文；块级部件 + block 装饰） */
class CodeBlockWidget extends WidgetType {
  private text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  ignoreEvent() { return false; }
  eq(o: CodeBlockWidget) { return o.text === this.text; }
  toDOM() {
    const pre = document.createElement('pre');
    pre.className = 'lp-codeblock';
    pre.textContent = this.text;
    return pre;
  }
}

/** 通路图部件：```pathway 块 → 内联 SVG（节点可点击跳笔记，事件委托同 .lp-wiki） */
class PathwayWidget extends WidgetType {
  private text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  ignoreEvent() { return false; }
  eq(o: PathwayWidget) { return o.text === this.text; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'lp-pathway';
    wrap.setAttribute('aria-label', '医学通路图，点击后可选中并删除或编辑源码');
    wrap.setAttribute('role', 'img');
    wrap.innerHTML = renderPathwaySvg(this.text);
    return wrap;
  }
}

const isTableRow = (t: string) => /^\s*\|.*\|\s*$/.test(t);/** 分隔行：形如 | --- | :---: | ---: |，须含至少一个连字符 */
const isTableSep = (t: string) => /^\s*\|[\s:|-]+\|\s*$/.test(t) && /-/.test(t);

// ---------- 块级行判定正则（模块级：buildSet 每行每键都会跑，避免逐行新建） ----------

const ACTIVE_HEAD_RE = /^(\s*)(#{1,4})\s+/;        // 光标行标题
const LIST_RE = /^(\s*)([-*]|\d+\.)\s+/;           // 列表标记
const KEY_RE = /^([^:：\s][^:：]{0,13}?)\s*[:：]/;  // 列表项「属性:」键
const PLAIN_KEY_RE = /^([^:：\-*#> ][^:：]{0,13}?)\s*[:：]/; // 段落里的属性键
const FENCE_RE = /^(\s*)(```+|~~~+)\s*([^\s`]*)/;  // 围栏代码块开头
const FENCE_CLOSE_RE = /^\s*(`+|~+)\s*$/;          // 同类字符的闭合围栏行
const HR_RE = /^(-{3,}|\*{3,})$/;
const HEAD_RE = /^(#{1,4})\s+/;
const QUOTE_RE = /^>\s?/;
const EMBED_LINE_RE = /^\s*!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]\s*$/;
const IMG_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/;

// ---------- 开关 ----------

const toggleEffect = StateEffect.define<null>();
export const livePreviewOn = StateField.define<boolean>({
  create: () => true,
  update: (v, tr) => (tr.effects.some((e) => e.is(toggleEffect)) ? !v : v),
});

/** 工具栏调用：切换实时预览 */
export function toggleLivePreview(view: EditorView): boolean {
  view.dispatch({ effects: toggleEffect.of(null) });
  return true;
}

// ---------- 装饰构建 ----------

function buildSet(state: EditorState, getReadFile?: () => ReadFileFn | undefined): DecorationSet {
  const doc = state.doc;
  const activeLine = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];
  const pushMark = (from: number, to: number, cls: string) => ranges.push(Decoration.mark({ class: cls }).range(from, to));
  const pushReplace = (from: number, to: number, w: WidgetType, block = false) =>
    ranges.push(Decoration.replace({ widget: w, block }).range(from, to));
  /** 行内标记：首尾标记符换成零宽部件，中间内容原样保留并加样式（见 ZeroWidget） */
  const pushDelim = (from: number, to: number, dlen: number, cls: string) => {
    if (to - from <= dlen * 2) return; // 空内容不成对，保持源码
    pushReplace(from, from + dlen, new ZeroWidget());
    pushMark(from + dlen, to - dlen, cls);
    pushReplace(to - dlen, to, new ZeroWidget());
  };
  const readFile = getReadFile?.();
  /** 嵌入名 → 附件内容（先按原名，再按 _attachments/ 约定路径） */
  const resolveImage = (name: string): string | undefined =>
    readFile?.(name) ?? readFile?.(`_attachments/${name}`);

  /**
   * 行内标记：scanInline 扫候选 → pickInline 去重叠 → 渲染。
   * editable=true（光标所在行）：只渲染「标记符被吃掉、内容仍可编辑」的行内样式；
   * 嵌入/图片/双链/链接会变成原子部件、光标进不去，那一行就不渲染它们，保留源码。
   */
  const inlineMarks = (lineText: string, start: number, editable = false) => {
    for (const c of pickInline(scanInline(lineText), editable)) {
      const f = start + c.from;
      const to = start + c.to;
      switch (c.kind) {
        case 'embed': {
          const name = c.a.trim();
          if (imgExtRe.test(name)) {
            const data = resolveImage(name);
            pushReplace(f, to, data ? new ImgWidget(data, c.b || name) : new EmbedMissingWidget(name));
          } else {
            pushReplace(f, to, new WikiWidget(c.b || name, name));
          }
          break;
        }
        case 'img': {
          const data = readFile?.(c.b.trim());
          if (data) pushReplace(f, to, new ImgWidget(data, c.a));
          break; // 解析不到附件就保留原文
        }
        case 'wiki': pushReplace(f, to, new WikiWidget(c.b || c.a, c.a)); break;
        case 'link': pushReplace(f, to, new LinkWidget(c.a, c.b)); break;
        case 'tri': pushDelim(f, to, 3, 'lp-bold lp-italic'); break;
        case 'bold': pushDelim(f, to, 2, 'lp-bold'); break;
        case 'code': pushDelim(f, to, 1, 'lp-code'); break;
        case 'highlight': pushDelim(f, to, 2, 'lp-highlight'); break;
        case 'italic': pushDelim(f, to, 1, 'lp-italic'); break;
      }
    }
  };

  /** 有序列表自动编号状态：同层级连续行递增 */
  let ordered: { indent: number; num: number } | null = null;

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const t = line.text;
    if (!t.trim()) { ordered = null; continue; }

    // 光标行：结构源码照旧显示（#、-、表格便于编辑），但行内标记仍然渲染——
    // 标记符只是被吃掉的零宽字符、内容照旧可编辑，所以 ** 在任何行都不会露出来。
    if (ln === activeLine) {
      const hm = ACTIVE_HEAD_RE.exec(t);
      if (hm) {
        const contentStart = line.from + hm[0].length;
        pushReplace(line.from + hm[1].length, contentStart, new HtmlWidget('', ''));
        pushMark(contentStart, line.to, `lp-h${hm[2].length}`);
        inlineMarks(t.slice(hm[0].length), contentStart, true);
        ordered = null;
        continue;
      }
      const lm = LIST_RE.exec(t);
      const base = lm ? lm[0].length : 0;
      const km = KEY_RE.exec(t.slice(base));
      if (km && !km[1].includes('[') && !km[1].includes(']')) {
        pushMark(line.from + base, line.from + base + km[0].length, 'lp-key');
      } else if (!lm) {
        const pk = PLAIN_KEY_RE.exec(t);
        if (pk) pushMark(line.from, line.from + pk[0].length, 'lp-key');
      }
      inlineMarks(t.slice(base), line.from + base, true);
      ordered = null;
      continue;
    }

    // ---------- 围栏代码块：``` / ~~~ → 整块 <pre>；```pathway → 通路图（block 部件） ----------
    const fenceM = FENCE_RE.exec(t);
    if (fenceM) {
      const ch = fenceM[2][0];
      const len = fenceM[2].length;
      const info = (fenceM[3] ?? '').toLowerCase();
      let end = ln; // 开围栏行
      const codeLines: string[] = [];
      while (end + 1 <= doc.lines) {
        const nt = doc.line(end + 1).text;
        end += 1;
        // 闭合围栏行：纳入替换范围后结束（否则会被当成新的开围栏吞掉后文）
        // 同类字符、长度不小于开围栏（原来是按 ch/len 动态 new RegExp，每块一次分配）
        const close = FENCE_CLOSE_RE.test(nt) ? nt.trim() : '';
        if (close.length >= len && close[0] === ch) break;
        codeLines.push(nt);
      }
      // 光标落在代码块内时不渲染（显示源码，可编辑）
      if (activeLine >= ln && activeLine <= end) { ordered = null; ln = end; continue; }
      const code = codeLines.join('\n');
      pushReplace(
        line.from,
        doc.line(end).to,
        isPathwayLang(info) ? new PathwayWidget(code) : new CodeBlockWidget(code),
        true,
      );
      ordered = null;
      ln = end;
      continue;
    }

    // ---------- 表格块：| 表头 | + 分隔行 + 数据行 → 整块渲染为 <table>（block 部件） ----------
    if (isTableRow(t) && ln + 1 <= doc.lines && isTableSep(doc.line(ln + 1).text)) {
      let end = ln;
      while (end + 1 <= doc.lines && isTableRow(doc.line(end + 1).text)) end++;
      // 光标落在表格块内时不渲染（显示源码，便于编辑）
      if (activeLine >= ln && activeLine <= end) { ordered = null; ln = end; continue; }
      const rows: string[] = [];
      for (let k = ln; k <= end; k++) rows.push(doc.line(k).text);
      pushReplace(doc.line(ln).from, doc.line(end).to, new TableWidget(rows), true);
      ordered = null;
      ln = end;
      continue;
    }

    // 分割线 --- / ***
    if (HR_RE.test(t.trim())) {
      pushReplace(line.from, line.to, new HrWidget());
      ordered = null;
      continue;
    }
    // 标题 # ~ ####
    const hm = HEAD_RE.exec(t);
    if (hm) {
      pushReplace(line.from, line.from + hm[0].length, new HtmlWidget('', ''));
      pushMark(line.from + hm[0].length, line.to, `lp-h${hm[1].length}`);
      ordered = null;
      continue;
    }
    // 引用 >
    if (t.startsWith('>')) {
      const contentStart = line.from + QUOTE_RE.exec(t)![0].length;
      pushReplace(line.from, contentStart, new HtmlWidget('▍', 'lp-quote-mark'));
      ranges.push(Decoration.line({ class: 'lp-quote-line' }).range(line.from));
      pushMark(contentStart, line.to, 'lp-quote-text');
      inlineMarks(t.slice(contentStart - line.from), contentStart);
      ordered = null;
      continue;
    }
    // 列表 - / * / 1.（保留缩进；有序自动编号）
    const lm = LIST_RE.exec(t);
    if (lm) {
      const indent = lm[1].length;
      const isOrdered = /^\d/.test(lm[2]);
      let marker: string;
      if (isOrdered) {
        if (ordered && ordered.indent === indent) ordered.num += 1;
        else ordered = { indent, num: (parseInt(lm[2], 10) || 1) };
        marker = `${ordered.num}. `;
      } else {
        ordered = null;
        marker = '• ';
      }
      pushReplace(line.from + lm[1].length, line.from + lm[1].length + lm[2].length, new HtmlWidget(marker, 'lp-bullet'));
      const contentStart = line.from + lm[0].length;
      // 属性键：「- 定义: 」的键名加粗
      const km = KEY_RE.exec(t.slice(lm[0].length));
      if (km && !km[1].includes('[') && !km[1].includes(']')) pushMark(contentStart, contentStart + km[0].length, 'lp-key');
      inlineMarks(t.slice(lm[0].length), contentStart);
      continue;
    }

    // ---------- 独占一行的图片 / 图片嵌入：整行替换（block 部件） ----------
    const embedLine = EMBED_LINE_RE.exec(t);
    const imgLine = IMG_LINE_RE.exec(t);
    if (embedLine && imgExtRe.test(embedLine[1].trim())) {
      const name = embedLine[1].trim();
      const data = resolveImage(name);
      pushReplace(line.from, line.to, data ? new ImgWidget(data, embedLine[2] || name) : new EmbedMissingWidget(name), true);
      ordered = null;
      continue;
    }
    if (imgLine) {
      const data = readFile?.(imgLine[2].trim());
      if (data) { pushReplace(line.from, line.to, new ImgWidget(data, imgLine[1]), true); ordered = null; continue; }
    }

    // 普通段落里的「属性: 」键
    const pk = PLAIN_KEY_RE.exec(t);
    if (pk) pushMark(line.from, line.from + pk[0].length, 'lp-key');
    inlineMarks(t, line.from);
    ordered = null;
  }
  return RangeSet.of(ranges, true);
}

// ---------- 装饰状态字段 ----------

/** 整个扩展：开关状态 + 装饰 StateField（getReadFile 用于解析图片 dataURL） */
export function livePreview(getReadFile?: () => ReadFileFn | undefined): Extension {
  const decoField = StateField.define<DecorationSet>({
    create: (state) => (state.field(livePreviewOn) ? buildSet(state, getReadFile) : Decoration.none),
    update(value, tr) {
      const toggled = tr.effects.some((e) => e.is(toggleEffect));
      if (!toggled && !tr.docChanged && !tr.selection) return value;
      if (!tr.state.field(livePreviewOn)) return Decoration.none;
      // 文档没变、活动行号也没变（同行内移动光标/框选）：buildSet 的输出只由
      // 「文档 + head 所在行号」决定，重建结果必然相同 → 直接复用旧值。
      // 方向键逐字移动、同行点击是编辑里的高频动作，原来每次都全篇重扫。
      // 跨行移动仍然重建（活动行渲染规则不同）；docChanged 也重建（内容变了）。
      if (!toggled && !tr.docChanged
        && tr.startState.doc.lineAt(tr.startState.selection.main.head).number
          === tr.state.doc.lineAt(tr.state.selection.main.head).number) {
        return value;
      }
      return buildSet(tr.state, getReadFile);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [livePreviewOn, decoField];
}
