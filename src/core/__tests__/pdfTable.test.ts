import { describe, expect, it } from 'vitest';
import {
  columnClusters,
  extractTable,
  fillDown,
  gridToMarkdown,
  rowClusters,
  tableToCsv,
  unionRect,
  type TableTextItem,
} from '../pdfTable';

/** 一张 3 列 × 3 行的合成表：列 x = 0 / 120 / 240，行 y = 0 / 20 / 40 */
function tableItems(): TableTextItem[] {
  const cells = [
    ['指标', '治疗前', '治疗后'],
    ['收缩压', '160', '128'],
    ['舒张压', '100', '82'],
  ];
  const out: TableTextItem[] = [];
  cells.forEach((row, r) => {
    row.forEach((text, c) => {
      out.push({ str: text, x: c * 120, y: r * 20, w: 60, h: 12 });
    });
  });
  return out;
}

describe('pdfTable', () => {
  it('按 x/y 聚成 3 列 3 行', () => {
    const items = tableItems();
    expect(columnClusters(items)).toHaveLength(3);
    expect(rowClusters(items)).toHaveLength(3);
    expect(rowClusters(items)[0].items.map((i) => i.str)).toEqual(['指标', '治疗前', '治疗后']);
  });

  it('抽表：首行作表头，其余作正文', () => {
    const table = extractTable(tableItems());
    expect(table).not.toBeNull();
    expect(table!.columns).toBe(3);
    expect(table!.header).toEqual(['指标', '治疗前', '治疗后']);
    expect(table!.rows).toEqual([
      ['收缩压', '160', '128'],
      ['舒张压', '100', '82'],
    ]);
    expect(table!.rect).toEqual({ x: 0, y: 0, w: 300, h: 52 });
  });

  it('不像表格时返回 null（列数不够 / 非空率太低）', () => {
    expect(extractTable([{ str: '一段普通正文', x: 0, y: 0, w: 100, h: 12 }])).toBeNull();
    const sparse = tableItems().filter((item) => item.str === '指标' || item.str === '收缩压');
    expect(extractTable(sparse)).toBeNull();
  });

  it('CSV 转义：逗号、引号、换行都按 RFC 4180 包起来', () => {
    const grid = { header: ['a,b', 'say "hi"'], rows: [['1', '2']], columns: 2, xEdges: [] };
    expect(tableToCsv(grid)).toBe('"a,b","say ""hi"""\n1,2');
    expect(tableToCsv(grid, { header: false })).toBe('1,2');
  });

  it('fillDown 用上方最近的非空值补空单元', () => {
    const grid = { header: ['a', 'b'], rows: [['x', ''], ['', 'y'], ['', '']], columns: 2, xEdges: [] };
    expect(fillDown(grid)).toEqual([['x', ''], ['x', 'y'], ['x', 'y']]);
  });

  it('Markdown 输出按列数补齐，空单元留空格', () => {
    const grid = { header: ['a'], rows: [['1', '2']], columns: 2, xEdges: [] };
    expect(gridToMarkdown(grid)).toBe('| a |   |\n| --- | --- |\n| 1 | 2 |');
  });

  it('unionRect 用左下角 + 宽高算外接框', () => {
    expect(unionRect([
      { str: 'a', x: 10, y: 5, w: 20, h: 10 },
      { str: 'b', x: 50, y: 20, w: 10, h: 6 },
    ])).toEqual({ x: 10, y: 5, w: 50, h: 21 });
  });
});
