/**
 * M8 · 所见即所得混合预览（CM6 decorations）——Obsidian 式。
 * 光标所在行显示源码，其余行实时渲染为排版效果——新手看到的是"排好版的文档"，
 * 点任何位置即回到源码可编辑，无需学习任何 md 语法。
 *
 * 支持渲染：标题 / 列表（有序自动编号）/ 引用块 / 分割线 /
 * **加粗** / *斜体* / ==高亮== / `行内代码` / 围栏代码块 /
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

/** 行内排版部件：整段替换，标记符随之隐藏（加粗/斜体/高亮/行内代码） */
class InlineMarkWidget extends WidgetType {
  private cls: string;
  private text: string;
  constructor(cls: string, text: string) {
    super();
    this.cls = cls;
    this.text = text;
  }
  ignoreEvent() { return false; }
  eq(o: InlineMarkWidget) { return o.cls === this.cls && o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    s.textContent = this.text;
    return s;
  }
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
      th.textContent = h;
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
        td.textContent = c;
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

const isTableRow = (t: string) => /^\s*\|.*\|\s*$/.test(t);
/** 分隔行：形如 | --- | :---: | ---: |，须含至少一个连字符 */
const isTableSep = (t: string) => /^\s*\|[\s:|-]+\|\s*$/.test(t) && /-/.test(t);

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
  const readFile = getReadFile?.();
  /** 嵌入名 → 附件内容（先按原名，再按 _attachments/ 约定路径） */
  const resolveImage = (name: string): string | undefined =>
    readFile?.(name) ?? readFile?.(`_attachments/${name}`);

  /**
   * 行内标记：收集候选 → 按优先级去重叠（replace 部件不允许互相嵌套）→ 渲染。
   * 优先级：嵌入 > 标准图片 > 双链 > 链接 > 加粗 > 行内代码 > 高亮 > 斜体。
   */
  const inlineMarks = (lineText: string, start: number) => {
    const embedRe = /!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
    const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const wikiRe = /(?<!!)\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
    const linkRe = /(?<!!)\[([^\]\n]+?)\]\(([^)]+)\)/g;
    const boldRe = /\*\*([^*\n]+)\*\*/g;
    const codeRe = /`([^`\n]+)`/g;
    const hlRe = /==([^=\n]+)==/g;
    const itRe = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;

    type Cand = { from: number; to: number; prio: number; kind: string; a: string; b: string };
    const cands: Cand[] = [];
    const collect = (re: RegExp, prio: number, kind: string) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText))) cands.push({ from: m.index, to: m.index + m[0].length, prio, kind, a: m[1] ?? '', b: m[2] ?? '' });
    };
    collect(embedRe, 0, 'embed');
    collect(imgRe, 1, 'img');
    collect(wikiRe, 2, 'wiki');
    collect(linkRe, 3, 'link');
    collect(boldRe, 4, 'bold');
    collect(codeRe, 5, 'code');
    collect(hlRe, 6, 'highlight');
    collect(itRe, 7, 'italic');

    cands.sort((x, y) => x.prio - y.prio || x.from - y.from);
    const taken: Array<{ from: number; to: number }> = [];
    const hits = (from: number, to: number) => taken.some((t) => from < t.to && to > t.from);
    for (const c of cands) {
      if (hits(c.from, c.to)) continue;
      taken.push({ from: c.from, to: c.to });
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
        case 'bold': pushReplace(f, to, new InlineMarkWidget('lp-bold', c.a)); break;
        case 'code': pushReplace(f, to, new InlineMarkWidget('lp-code', c.a)); break;
        case 'highlight': pushReplace(f, to, new InlineMarkWidget('lp-highlight', c.a)); break;
        case 'italic': pushReplace(f, to, new InlineMarkWidget('lp-italic', c.a)); break;
      }
    }
  };

  /** 有序列表自动编号状态：同层级连续行递增 */
  let ordered: { indent: number; num: number } | null = null;

  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln === activeLine) continue; // 活动行显示源码
    const line = doc.line(ln);
    const t = line.text;
    if (!t.trim()) { ordered = null; continue; }

    // ---------- 围栏代码块：``` / ~~~ → 整块 <pre>（block 部件） ----------
    const fenceM = /^(\s*)(```+|~~~+)/.exec(t);
    if (fenceM) {
      const ch = fenceM[2][0];
      const len = fenceM[2].length;
      let end = ln; // 开围栏行
      const codeLines: string[] = [];
      while (end + 1 <= doc.lines) {
        const nt = doc.line(end + 1).text;
        end += 1;
        // 闭合围栏行：纳入替换范围后结束（否则会被当成新的开围栏吞掉后文）
        if (new RegExp(`^\\s*${ch}{${len},}\\s*$`).test(nt)) break;
        codeLines.push(nt);
      }
      // 光标落在代码块内时不渲染（显示源码，可编辑）
      if (activeLine >= ln && activeLine <= end) { ordered = null; ln = end; continue; }
      pushReplace(line.from, doc.line(end).to, new CodeBlockWidget(codeLines.join('\n')), true);
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
    if (/^(-{3,}|\*{3,})$/.test(t.trim())) {
      pushReplace(line.from, line.to, new HrWidget());
      ordered = null;
      continue;
    }
    // 标题 # ~ ####
    const hm = /^(#{1,4})\s+/.exec(t);
    if (hm) {
      pushReplace(line.from, line.from + hm[0].length, new HtmlWidget('', ''));
      pushMark(line.from + hm[0].length, line.to, `lp-h${hm[1].length}`);
      ordered = null;
      continue;
    }
    // 引用 >
    if (t.startsWith('>')) {
      const contentStart = line.from + /^>\s?/.exec(t)![0].length;
      pushReplace(line.from, contentStart, new HtmlWidget('▍', 'lp-quote-mark'));
      ranges.push(Decoration.line({ class: 'lp-quote-line' }).range(line.from));
      pushMark(contentStart, line.to, 'lp-quote-text');
      inlineMarks(t.slice(contentStart - line.from), contentStart);
      ordered = null;
      continue;
    }
    // 列表 - / * / 1.（保留缩进；有序自动编号）
    const lm = /^(\s*)([-*]|\d+\.)\s+/.exec(t);
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
      const km = /^([^:：\s][^:：]{0,13}?)\s*[:：]/.exec(t.slice(lm[0].length));
      if (km && !km[1].includes('[') && !km[1].includes(']')) pushMark(contentStart, contentStart + km[0].length, 'lp-key');
      inlineMarks(t.slice(lm[0].length), contentStart);
      continue;
    }

    // ---------- 独占一行的图片 / 图片嵌入：整行替换（block 部件） ----------
    const embedLine = /^\s*!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]\s*$/.exec(t);
    const imgLine = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(t);
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
    const pk = /^([^:：\-*#> ][^:：]{0,13}?)\s*[:：]/.exec(t);
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
      // 活动行随光标移动而变，选区变化也需重建
      if (!toggled && !tr.docChanged && !tr.selection) return value;
      if (!tr.state.field(livePreviewOn)) return Decoration.none;
      return buildSet(tr.state, getReadFile);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [livePreviewOn, decoField];
}
