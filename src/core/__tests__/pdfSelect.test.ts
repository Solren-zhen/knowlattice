import { describe, expect, it } from 'vitest';
import {
  groupLines,
  isDragGesture,
  joinOrderedText,
  orderByReadingOrder,
  pickLineAt,
  pickLineRange,
  type TextBox,
} from '../pdfSelect';

/** 造一个高 20 的文字块 */
const box = (top: number, left: number, width = 60, height = 20): TextBox => ({
  top, left, right: left + width, bottom: top + height,
});

/** 四行，每行两个块；DOM 顺序被故意打乱成 1、3、2、4 行 */
const scrambled: TextBox[] = [
  box(0, 10), box(0, 100),     // 0,1  第 1 行
  box(40, 10), box(40, 100),   // 2,3  第 3 行
  box(20, 10), box(20, 100),   // 4,5  第 2 行
  box(60, 10), box(60, 100),   // 6,7  第 4 行
];

describe('orderByReadingOrder', () => {
  it('不管 DOM 顺序如何，都按先行后列返回', () => {
    expect(orderByReadingOrder(scrambled)).toEqual([0, 1, 4, 5, 2, 3, 6, 7]);
  });

  it('同一行内按横坐标排序（双栏排版）', () => {
    const cols: TextBox[] = [box(0, 300, 200), box(0, 20, 200), box(0, 160, 100)];
    expect(orderByReadingOrder(cols)).toEqual([1, 2, 0]);
  });
});

describe('pickLineAt', () => {
  it('只取点中那一行，不带上相邻行', () => {
    expect(pickLineAt(scrambled, 30, 20).sort()).toEqual([4, 5]); // 第 2 行
    expect(pickLineAt(scrambled, 10, 20).sort()).toEqual([0, 1]); // 第 1 行
  });

  it('行内仍按从左到右排列', () => {
    const line: TextBox[] = [box(20, 100), box(20, 10)];
    expect(pickLineAt(line, 30, 20)).toEqual([1, 0]);
  });
});

describe('pickLineRange', () => {
  it('拖拽跨多行时返回阅读顺序（扫描版跳行的核心修复）', () => {
    // 从第 1 行拖到第 4 行：结果必须是 1→2→3→4 行，而不是 DOM 顺序的 1→3→2→4
    expect(pickLineRange(scrambled, 5, 5, 5, 70)).toEqual([0, 1, 4, 5, 2, 3, 6, 7]);
  });

  it('竖直拖动时不漏掉行内靠左的块（旧的矩形相交算法会漏）', () => {
    // 拖拽的横向范围就是一条竖线（x 都在 35）：三行都要整行选中，
    // 尤其第 1 行右栏那块（下标 1）——按矩形相交会被漏掉
    expect(pickLineRange(scrambled, 35, 5, 35, 45)).toEqual([0, 1, 4, 5, 2, 3]);
  });

  it('横向拖拽明显时，起点/终点行按横向端点截取', () => {
    const row: TextBox[] = [box(20, 10), box(20, 100)]; // 10..70、100..160
    expect(pickLineRange(row, 5, 30, 70, 30)).toEqual([0]); // 只取左侧块
    expect(pickLineRange(row, 5, 30, 160, 30)).toEqual([0, 1]); // 拖到右侧块
  });

  it('中间行整行纳入，不受横向范围限制', () => {
    // 起点行（第 1 行）整行；中间行（第 2 行）整行，右栏的块不丢；
    // 终点行（第 3 行）按 x≤70 截取，故只取左栏
    expect(pickLineRange(scrambled, 5, 5, 70, 45)).toEqual([0, 1, 4, 5, 2]);
  });

  it('向上拖动同样成立（起点是下方那行）', () => {
    expect(pickLineRange(scrambled, 5, 70, 5, 5)).toEqual([0, 1, 4, 5, 2, 3, 6, 7]);
  });
});

describe('groupLines', () => {
  it('按视觉行分组，行内从左到右', () => {
    expect(groupLines(scrambled)).toEqual([
      [0, 1], [4, 5], [2, 3], [6, 7],
    ]);
  });
});

describe('isDragGesture', () => {
  it('微小位移算点选，明显位移算拖拽', () => {
    expect(isDragGesture(100, 100, 102, 101)).toBe(false);
    expect(isDragGesture(100, 100, 140, 100)).toBe(true);
  });
});

describe('joinOrderedText', () => {
  it('中文块之间的大间隙不产生空格', () => {
    const parts = [
      { text: '甲状腺', box: box(0, 100, 30) },
      { text: '结节', box: { top: 0, left: 140, right: 170, bottom: 20 } },
    ];
    expect(joinOrderedText(parts)).toBe('甲状腺结节');
  });

  it('英文块之间的间隙补空格', () => {
    const parts = [
      { text: 'clinical', box: box(0, 100, 60) },
      { text: 'outcome', box: { top: 0, left: 166, right: 230, bottom: 20 } },
    ];
    expect(joinOrderedText(parts)).toBe('clinical outcome');
  });

  it('跨行拼接后不丢内容', () => {
    const parts = [
      { text: '临床', box: box(0, 100, 40) },
      { text: '结局', box: box(20, 100, 40) },
    ];
    expect(joinOrderedText(parts)).toBe('临床结局');
  });
});

describe('joinOrderedText paragraph gaps', () => {
  const part = (top: number, text: string) => ({
    text, box: { top, left: 0, right: 30, bottom: top + 20 },
  });

  it('keeps a blank line when the vertical gap is large', () => {
    expect(joinOrderedText([part(0, 'one'), part(40, 'two')])).toBe('one\n\ntwo');
  });

  it('still joins normal consecutive lines with a space', () => {
    expect(joinOrderedText([part(0, 'one'), part(20, 'two')])).toBe('one two');
  });
});
