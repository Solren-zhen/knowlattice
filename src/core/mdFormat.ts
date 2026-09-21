/**
 * 编辑器行内标记的纯函数实现：加粗 / 高亮 / 斜体 / 双链。
 *
 * 抽成纯函数是因为工具栏按钮、右键菜单与快捷键必须走同一段逻辑——几处各写一遍，迟早出现
 * 「点按钮能取消加粗、按快捷键只会再套一层」这种同功能不同行为的不一致。
 * 输入是文档字符串 + 选区，输出是可直接交给 EditorView.dispatch 的编辑描述。
 * 标记符（`**` / `==` / `*`）只落在文件里，界面由 livePreview 把首尾标记符吃成零宽，
 * 因此使用者在编辑器里永远看不到它们。
 *
 * 文件末尾另附 `FORMAT_KEYS`：四个格式命令的键位定义，界面提示与快捷键绑定同源。
 */

export interface MdEdit {
  changes: Array<{ from: number; to: number; insert: string }>;
  selection: { anchor: number; head: number };
}

/** 成对标记的查找式，必须与 livePreview 渲染时用的保持一致：能加粗的段落 = 界面上看得见加粗的段落。 */
const PAIR_RE: Record<string, RegExp> = {
  '**': /\*\*([^*\n]+)\*\*/g,
  '==': /==([^=\n]+)==/g,
  '*': /(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
};

/**
 * 选区只要碰到某一对标记，就把选区扩到这一对的完整范围（可能连锁扩大，故循环到不动点）。
 *
 * 为什么必须有这一步：实时预览把标记符渲染成零宽部件后，「行首 Shift+Home」这类原生光标移动
 * 常常少吃掉左边的 `**`，选区于是正好卡在标记内侧。此时按「标记紧贴选区外侧 → 去掉」判定不成立，
 * 代码只好再包一层，正文里就留下 `****文案****` 这种谁也识别不了的残标记——正是要消灭的乱码。
 * 扩到完整标记对之后，包/拆的判定才与界面上看到的排版一致（所见即所改）。
 */
function expandToPairs(doc: string, from: number, to: number, marker: string): [number, number] {
  const re = PAIR_RE[marker];
  if (!re || from >= to) return [from, to]; // 空选区不扩，否则光标停在加粗文字里按快捷键会整段取消
  let f = from;
  let t = to;
  for (let grew = true; grew; ) {
    grew = false;
    re.lastIndex = 0;
    for (let m = re.exec(doc); m; m = re.exec(doc)) {
      if (f < m.index + m[0].length && t > m.index) {
        const nf = Math.min(f, m.index);
        const nt = Math.max(t, m.index + m[0].length);
        // 只有真的变大才算「还在扩」：已完全包住的重叠若也置 true，这一圈会永远转下去
        if (nf !== f || nt !== t) { f = nf; t = nt; grew = true; }
      }
    }
  }
  return [f, t];
}

/**
 * 成对标记的开关：`**粗**` ⇄ `粗`。
 * - 选区自带一对标记 → 去掉；
 * - 标记紧贴选区外侧 → 去掉；
 * - 否则包一层；空选区插入占位文字并选中它，直接打字即可替换。
 */
export function toggleMark(doc: string, from: number, to: number, marker: string, placeholder: string): MdEdit {
  const len = marker.length;
  // 从右往左拖选时 CM 的 selection 会带着 anchor>head 的方向信息，from 可能大于 to；
  // 不归一化就会拼出 {from: 888, to: 0} 这种非法区间，dispatch 直接抛 RangeError、按钮毫无反应。
  if (from > to) [from, to] = [to, from];
  [from, to] = expandToPairs(doc, from, to, marker);
  const selected = doc.slice(from, to);

  if (selected.length > len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(len, -len);
    return { changes: [{ from, to, insert: inner }], selection: { anchor: from, head: from + inner.length } };
  }

  const outerFrom = from - len;
  if (outerFrom >= 0 && doc.slice(outerFrom, from) === marker && doc.slice(to, to + len) === marker) {
    return {
      changes: [
        { from: outerFrom, to: from, insert: '' },
        { from: to, to: to + len, insert: '' },
      ],
      selection: { anchor: outerFrom, head: outerFrom + (to - from) },
    };
  }

  const text = selected.length > 0 ? selected : placeholder;
  const wrapped = marker + text + marker;
  return {
    changes: [{ from, to, insert: wrapped }],
    selection:
      selected.length > 0
        ? { anchor: from + wrapped.length, head: from + wrapped.length }
        : { anchor: from + len, head: from + len + text.length },
  };
}

/** 双链：空选区插入 `[[]]` 且光标落在中间（触发补全）；有选区则包成 `[[选中文字]]`。 */
export function wikiLink(doc: string, from: number, to: number): MdEdit {
  if (from > to) [from, to] = [to, from]; // 同上：反方向选区也要能正常包双链
  const selected = doc.slice(from, to);
  if (selected.length > 0) {
    const insert = `[[${selected}]]`;
    const end = from + insert.length;
    return { changes: [{ from, to, insert }], selection: { anchor: end, head: end } };
  }
  return { changes: [{ from, to, insert: '[[]]' }], selection: { anchor: from + 2, head: from + 2 } };
}

/**
 * 键位定义已移到 `./formatKeys`（叶子模块，没有依赖）——首页在入口包里也要读这张表，
 * 留在这里会把整个 mdFormat 拖进首屏。这里重新导出，老引用（Editor.tsx 等）不用改。
 */
export { FORMAT_KEYS } from './formatKeys';
export type { FormatKey } from './formatKeys';
