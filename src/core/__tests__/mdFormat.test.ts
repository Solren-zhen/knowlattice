import { describe, expect, it } from 'vitest';
import { toggleMark, wikiLink, type MdEdit } from '../mdFormat';

/** 把编辑描述套用到原文上，得到「按下快捷键之后文档长什么样」 */
function apply(doc: string, edit: MdEdit): { text: string; selected: string } {
  let text = doc;
  for (const c of [...edit.changes].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, c.from) + c.insert + text.slice(c.to);
  }
  const { anchor, head } = edit.selection;
  return { text, selected: text.slice(Math.min(anchor, head), Math.max(anchor, head)) };
}

const BOLD = '**';
const BOLDED = `${BOLD}氧解离曲线右移${BOLD}`;

describe('toggleMark 加粗 / 高亮', () => {
  it('选中文字后包一层，光标落在标记之后', () => {
    const src = '氧解离曲线右移';
    const { text, selected } = apply(src, toggleMark(src, 0, src.length, BOLD, '加粗内容'));
    expect(text).toBe(BOLDED);
    expect(selected).toBe('');
  });

  it('空选区插入占位文字并选中它，直接打字即可替换', () => {
    const { text, selected } = apply('', toggleMark('', 0, 0, BOLD, '加粗内容'));
    expect(text).toBe('**加粗内容**');
    expect(selected).toBe('加粗内容');
  });

  it('选中的文字自带一对标记时取消标记', () => {
    const { text } = apply(BOLDED, toggleMark(BOLDED, 0, BOLDED.length, BOLD, '加粗内容'));
    expect(text).toBe('氧解离曲线右移');
  });

  it('标记紧贴选区外侧时取消标记', () => {
    const { text } = apply(
      BOLDED,
      toggleMark(BOLDED, BOLD.length, BOLDED.length - BOLD.length, BOLD, '加粗内容'),
    );
    expect(text).toBe('氧解离曲线右移');
  });

  it('只有单侧有标记时不误判为「已包裹」', () => {
    const doc = '**ab**';
    const { text } = apply(doc, toggleMark(doc, doc.length, doc.length, BOLD, '加粗内容'));
    expect(text).toBe('**ab****加粗内容**');
  });

  it('高亮用同一套逻辑，标记换成 ==', () => {
    const { text } = apply('右移', toggleMark('右移', 0, 2, '==', '高亮内容'));
    expect(text).toBe('==右移==');
  });

  it('斜体用同一套逻辑，标记换成单星号', () => {
    expect(apply('右移', toggleMark('右移', 0, 2, '*', '斜体内容')).text).toBe('*右移*');
    expect(apply('*右移*', toggleMark('*右移*', 0, 4, '*', '斜体内容')).text).toBe('右移');
  });

  it('斜体的单星号不会被误当成加粗', () => {
    const src = '**粗**';
    // 整段选中按加粗 → 取消加粗，而不是把星号当斜体标记
    expect(apply(src, toggleMark(src, 0, src.length, '**', '加粗内容')).text).toBe('粗');
  });
});

/**
 * 选区边界卡在标记内侧时的行为：实时预览把标记符渲染成零宽部件后，行首 Shift+Home
 * 会少吃掉左侧的 `**`，这类选区以前会被当成「没加粗过」再包一层，正文里留下
 * `****文案****` 这种谁也识别不了的残标记。
 */
describe('toggleMark 边界归一化（选区落在标记内侧）', () => {
  it('少吃掉左侧标记的整行选区 → 取消加粗，而不是包出 ****文案****', () => {
    const src = '**测E**';
    // 选区 [2, 7]：从内容开头到行尾，左侧 `**` 在选区外
    expect(apply(src, toggleMark(src, 2, src.length, BOLD, '加粗内容')).text).toBe('测E');
  });

  it('只选中加粗段的一部分 → 整段取消，不留下半个标记', () => {
    const src = '**测E**';
    expect(apply(src, toggleMark(src, 2, 3, BOLD, '加粗内容')).text).toBe('测E');
    expect(apply(src, toggleMark(src, 3, 4, BOLD, '加粗内容')).text).toBe('测E');
  });

  it('选区起点压在开标记上、终点在内容里 → 整段取消', () => {
    const src = '**测E**';
    expect(apply(src, toggleMark(src, 0, 3, BOLD, '加粗内容')).text).toBe('测E');
  });

  it('选区切在收尾标记的两个星号之间 → 整段取消', () => {
    const src = '**测E**';
    expect(apply(src, toggleMark(src, 2, 5, BOLD, '加粗内容')).text).toBe('测E');
  });

  it('同一行相邻两对标记只影响被碰到的那一对', () => {
    const src = '**甲**乙**丙**';
    expect(apply(src, toggleMark(src, 2, 4, BOLD, '加粗内容')).text).toBe('甲乙**丙**');
  });

  it('高亮的 == 同样归一化', () => {
    const src = '==重点==';
    expect(apply(src, toggleMark(src, 2, src.length, '==', '高亮内容')).text).toBe('重点');
  });

  it('空选区停在加粗段内部仍插入占位，不会整段取消', () => {
    const src = '**测E**';
    expect(apply(src, toggleMark(src, 3, 3, BOLD, '加粗内容')).text).toBe('**测**加粗内容**E**');
  });

  it('没有标记的普通选区照常包一层', () => {
    const src = '波尔效应';
    expect(apply(src, toggleMark(src, 2, 4, BOLD, '加粗内容')).text).toBe('波尔**效应**');
  });
});

describe('反方向选区（从右往左拖选）', () => {
  it('from > to 时同样能加粗，不会拼出非法区间', () => {
    const src = '波尔效应';
    const edit = toggleMark(src, 4, 2, BOLD, '加粗内容');
    for (const c of edit.changes) expect(c.from).toBeLessThanOrEqual(c.to);
    expect(apply(src, edit).text).toBe('波尔**效应**');
  });

  it('from > to 时同样能取消加粗', () => {
    const src = '**波尔效应**';
    const edit = toggleMark(src, src.length, 0, BOLD, '加粗内容');
    for (const c of edit.changes) expect(c.from).toBeLessThanOrEqual(c.to);
    expect(apply(src, edit).text).toBe('波尔效应');
  });

  it('双链在反方向选区内也能包住选中文字', () => {
    expect(apply('波尔效应', wikiLink('波尔效应', 4, 0)).text).toBe('[[波尔效应]]');
  });
});

describe('wikiLink 双链', () => {
  it('空选区插入 [[]] 且光标落在中间（补全在此触发）', () => {
    const edit = wikiLink('', 0, 0);
    expect(apply('', edit).text).toBe('[[]]');
    expect(edit.selection.anchor).toBe(2);
  });

  it('选中文字则包成 [[选中文字]]', () => {
    expect(apply('波尔效应', wikiLink('波尔效应', 0, 4)).text).toBe('[[波尔效应]]');
  });

  it('在句子中间插入时只改选区范围', () => {
    const doc = '见 波尔效应 一节';
    expect(apply(doc, wikiLink(doc, 2, 6)).text).toBe('见 [[波尔效应]] 一节');
  });
});
