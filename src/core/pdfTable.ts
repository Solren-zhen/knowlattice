/**
 * PDF 表格抽取：x 聚类出列、y 聚类出行，输出二维表与 CSV / Markdown。
 *
 * 纯函数、不依赖 pdf.js：调用方把文本层 items 归一成 `TableTextItem`
 * （str + 左下角 x/y + 宽高）即可。这样同一套算法既能给 PDF 用，
 * 也能给 docx / 图片 OCR 的版面块用。
 */

export interface TableTextItem {
  str: string;
  /** 左下角 x */
  x: number;
  /** 左下角 y */
  y: number;
  w: number;
  h: number;
}

export interface TableRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TableOptions {
  /** 列聚类容差（px），缺省按行高中位数推算 */
  columnTolerance?: number;
  /** 行聚类容差（px），缺省按行高比例 */
  rowTolerance?: number;
  /** 非空单元占比下限 */
  minFill?: number;
  minRows?: number;
  minCols?: number;
}

export interface ColumnCluster {
  x: number;
  items: TableTextItem[];
}

export interface RowCluster {
  y: number;
  h: number;
  items: TableTextItem[];
}

export interface TableGrid {
  header: string[];
  rows: string[][];
  columns: number;
  xEdges: number[];
}

export interface TableExtraction extends TableGrid {
  rect: TableRect;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function unionRect(items: readonly TableTextItem[]): TableRect {
  if (items.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const item of items) {
    left = Math.min(left, item.x);
    bottom = Math.min(bottom, item.y);
    right = Math.max(right, item.x + item.w);
    top = Math.max(top, item.y + item.h);
  }
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

/** 按左下角 x 聚类成列。 */
export function columnClusters(items: readonly TableTextItem[], tolerance?: number): ColumnCluster[] {
  if (items.length === 0) return [];
  const tol = tolerance ?? Math.max(2, median(items.map((item) => item.h).filter((h) => h > 0)) * 0.8);
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const clusters: ColumnCluster[] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(item.x - last.x) <= tol) last.items.push(item);
    else clusters.push({ x: item.x, items: [item] });
  }
  return clusters;
}

/** 按垂直中心聚类成行，返回按 y 从上到下排序。 */
export function rowClusters(items: readonly TableTextItem[], tolerance?: number): RowCluster[] {
  if (items.length === 0) return [];
  const tol = tolerance ?? Math.max(1.5, median(items.map((item) => item.h).filter((h) => h > 0)) * 0.6);
  const sorted = [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const rows: RowCluster[] = [];
  for (const item of sorted) {
    const center = item.y + item.h / 2;
    let hit: RowCluster | undefined;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (Math.abs(rows[i].y + rows[i].h / 2 - center) <= tol) {
        hit = rows[i];
        break;
      }
    }
    if (hit) {
      hit.items.push(item);
      const top = Math.max(hit.y + hit.h, item.y + item.h);
      hit.y = Math.min(hit.y, item.y);
      hit.h = top - hit.y;
    } else {
      rows.push({ y: item.y, h: item.h, items: [item] });
    }
  }
  return rows.sort((a, b) => a.y - b.y);
}

function cellText(items: readonly TableTextItem[]): string {
  return [...items]
    .sort((a, b) => a.x - b.x)
    .map((item) => item.str.trim())
    .filter((text) => text !== '')
    .join(' ');
}

export function columnEdges(clusters: readonly ColumnCluster[]): number[] {
  return clusters.map((cluster) => cluster.x);
}

/** 从一页（或一个区域）的 item 里抽表格；不像表格返回 null。 */
export function extractTable(items: readonly TableTextItem[], options: TableOptions = {}): TableExtraction | null {
  if (items.length === 0) return null;
  const rows = rowClusters(items, options.rowTolerance);
  const columns = columnClusters(items, options.columnTolerance);
  const minRows = options.minRows ?? 2;
  const minCols = options.minCols ?? 2;
  if (rows.length < minRows || columns.length < minCols) return null;

  const matrix: string[][] = rows.map((row) => {
    const buckets: TableTextItem[][] = columns.map(() => []);
    for (const item of row.items) {
      let best = 0;
      let bestDist = Infinity;
      columns.forEach((column, index) => {
        const dist = Math.abs(item.x - column.x);
        if (dist < bestDist) {
          bestDist = dist;
          best = index;
        }
      });
      buckets[best].push(item);
    }
    return buckets.map((bucket) => cellText(bucket));
  });

  // 全空行（表格里的横线、装饰）丢掉
  const nonEmpty = matrix.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length < minRows) return null;

  const populated = nonEmpty.reduce((sum, row) => sum + row.filter((cell) => cell !== '').length, 0);
  const fill = populated / (nonEmpty.length * columns.length);
  if (fill < (options.minFill ?? 0.45)) return null;

  return {
    header: nonEmpty[0],
    rows: nonEmpty.slice(1),
    columns: columns.length,
    xEdges: columnEdges(columns),
    rect: unionRect(items),
  };
}

/** 合并单元格的降级：空单元按上方最近的非空值补齐。 */
export function fillDown(grid: TableGrid): string[][] {
  const filled = grid.rows.map((row) => [...row]);
  filled.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (cell !== '') return;
      for (let r = rowIndex - 1; r >= 0; r -= 1) {
        const above = filled[r][colIndex];
        if (above !== '') {
          filled[rowIndex][colIndex] = above;
          break;
        }
      }
    });
  });
  return filled;
}

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function tableToCsv(grid: TableGrid, options: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.header !== false && grid.header.some((cell) => cell !== '')) {
    lines.push(grid.header.map(csvCell).join(','));
  }
  for (const row of grid.rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\n');
}

export function gridToMarkdown(grid: TableGrid): string {
  const header = grid.header.length ? grid.header : new Array(grid.columns).fill('');
  const pad = (row: string[]): string[] => {
    const copy = [...row];
    while (copy.length < grid.columns) copy.push('');
    return copy.slice(0, grid.columns);
  };
  const lines: string[] = [];
  lines.push('| ' + pad(header).map((cell) => cell || ' ').join(' | ') + ' |');
  lines.push('| ' + new Array(grid.columns).fill('---').join(' | ') + ' |');
  for (const row of grid.rows) lines.push('| ' + pad(row).map((cell) => cell || ' ').join(' | ') + ' |');
  return lines.join('\n');
}
