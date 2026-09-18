import { describe, expect, it } from 'vitest';
import { pickInline, scanInline } from '../livePreview';

/** 只取某一类的原始命中（未去重叠） */
const only = (text: string, kind: string) => scanInline(text).filter((h) => h.kind === kind);
/** 走完去重叠、真正会被渲染的命中 */
const picked = (text: string, editable = false) => pickInline(scanInline(text), editable).map((h) => h.kind);

describe('scanInline 强调标记', () => {
  it('普通加粗：`**粗**` 只产出 bold，不会顺带当成斜体', () => {
    const hits = scanInline('**粗**');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'bold', from: 0, to: 5, a: '粗' });
    expect(only('**粗**', 'italic')).toHaveLength(0);
  });

  it('三星号粗斜体整段交给 tri，首尾星号不会被少吃一个', () => {
    expect(scanInline('***强***')).toHaveLength(1);
    expect(scanInline('***强***')[0]).toMatchObject({ kind: 'tri', from: 0, to: 7, a: '强' });
  });

  it('内容里带单个星号的加粗能匹配（`**a*b**`）', () => {
    expect(scanInline('**a*b**')).toHaveLength(1);
    expect(scanInline('**a*b**')[0]).toMatchObject({ kind: 'bold', from: 0, to: 7, a: 'a*b' });
  });

  it('粗斜体里带单个星号同样整段吃掉', () => {
    expect(only('***a*b***', 'tri')[0]).toMatchObject({ from: 0, to: 9, a: 'a*b' });
  });

  it('同一行相邻两对各自成段', () => {
    expect(only('**粗**和**细**', 'bold').map((h) => [h.from, h.to])).toEqual([[0, 5], [6, 11]]);
  });

  it('加粗里嵌斜体：两层都命中，且内层落在外层内容区间内', () => {
    const bold = only('**粗 *斜* 体**', 'bold')[0];
    const italic = only('**粗 *斜* 体**', 'italic')[0];
    expect(bold).toMatchObject({ from: 0, to: 11 });
    expect(italic).toMatchObject({ from: 4, to: 7 });
    expect(italic.from).toBeGreaterThanOrEqual(bold.from + 2);
    expect(italic.to).toBeLessThanOrEqual(bold.to - 2);
  });

  it('四个星号这类残标记不产出任何加粗：宁可原样显示也不漏星号', () => {
    expect(only('****空****', 'tri').concat(only('****空****', 'bold'))).toHaveLength(0);
  });
});

describe('scanInline 其它语法与优先级', () => {
  it('按优先级排序：嵌入在加粗之前', () => {
    expect(scanInline('![[图.png]] 与 **粗**').map((h) => h.kind)).toEqual(['embed', 'bold']);
  });

  it('双链、图片、行内代码、高亮的位置与内容', () => {
    expect(only('见 [[波尔效应]] 一节', 'wiki')[0]).toMatchObject({ from: 2, to: 10, a: '波尔效应' });
    expect(only('![](a.png)', 'img')[0]).toMatchObject({ from: 0, to: 10, b: 'a.png' });
    expect(only('用 `==` 高亮', 'code')[0]).toMatchObject({ a: '==' });
    expect(only('==重点==', 'highlight')[0]).toMatchObject({ from: 0, to: 6, a: '重点' });
  });
});

describe('pickInline 去重叠', () => {
  it('高亮里嵌斜体（`==*高亮*==`）两层都留下', () => {
    expect(picked('==*高亮*==')).toEqual(['highlight', 'italic']);
  });

  it('加粗里的双链只渲染双链（原子部件优先，外层标记符跟着消失）', () => {
    expect(picked('**[[波尔效应]]**')).toEqual(['wiki']);
  });

  it('行内代码与加粗重叠时按既有优先级只留加粗', () => {
    expect(picked('`**x**`')).toEqual(['bold']);
  });

  it('内层紧贴外层内容边界时不算冲突（`==*a*b*==`）', () => {
    const hits = pickInline(scanInline('==*a*b*=='));
    expect(hits.map((h) => h.kind)).toEqual(['highlight', 'italic']);
    expect(hits[1]).toMatchObject({ from: 2, to: 5 });
  });

  it('光标行（editable）不渲染原子部件，避免光标进不去', () => {
    expect(picked('![[图.png]] 与 **粗**', true)).toEqual(['bold']);
    expect(picked('![[图.png]] 与 **粗**', false)).toEqual(['embed', 'bold']);
  });
});
