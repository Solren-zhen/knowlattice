/**
 * 简易表格：把「点格子选行列」和「选中的多行文字」变成标准 GFM 管道表。
 *
 * 与 mdFormat 同构：纯函数输入「文档 + 选区」，输出可直接交给 EditorView.dispatch 的编辑描述，
 * 因此工具栏按钮只负责取选区、不做字符串拼接。表格必须与前后段落空开一行，
 * 否则 markdown-it 不会把它识别成表格块、实时预览也不会渲染（这段边界处理收在 insertTable 里）。
 */
import type { MdEdit } from './mdFormat';

/** 分隔符探测顺序：制表符最可靠，其次是已有的竖线，再是常见中文标点 */
const DELIMS = ['\t', '|', ',', '，', '、', '；', ';'];

export const TABLE_MAX_ROWS = 8;
export const TABLE_MAX_COLS = 6;

function escCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 单元格矩阵 → GFM 管道表（第一行当表头，其余当数据行） */
function toTable(rows: string[][]): string {
  const width = rows[0].length;
  const head = `| ${rows[0].map(escCell).join(' | ')} |`;
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.map(escCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** 空白表格骨架：表头写「列1 列2 …」，下接 rows 行空白数据行（表头与分隔行另算） */
export function tableSkeleton(rows: number, cols: number): string {
  const r = Math.min(Math.max(0, Math.floor(rows)), TABLE_MAX_ROWS);
  const c = Math.min(Math.max(1, Math.floor(cols)), TABLE_MAX_COLS);
  const head = Array.from({ length: c }, (_, i) => `列${i + 1}`);
  const matrix = [head, ...Array.from({ length: r }, () => Array.from({ length: c }, () => ''))];
  return toTable(matrix);
}

/** 多行文本 → 表格；探测不到统一的列分隔符时返回 null（不硬拆，避免把句子切碎） */
export function textToTable(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  for (const d of DELIMS) {
    const rows = lines.map((l) => l.split(d).map((c) => c.trim()));
    const width = rows[0].length;
    if (width < 2) continue;
    if (rows.every((row) => row.length === width)) return toTable(rows);
  }
  return null;
}

/**
 * 把表格插到选区处（有选中文字则替换），并自动与前后段落空开一行；
 * 光标落在表头第一个单元格并选中它，直接打字即可替换。
 */
export function insertTable(doc: string, from: number, to: number, table: string): MdEdit {
  if (from > to) [from, to] = [to, from];
  const nl = doc.includes('\r\n') ? '\r\n' : '\n';
  const before = doc.slice(0, from);
  const after = doc.slice(to);

  let lead = '';
  if (before.length > 0) {
    if (before.endsWith(nl + nl)) lead = '';
    else if (before.endsWith(nl)) lead = nl;
    else lead = nl + nl;
  }
  const tail = after.length > 0 && !after.startsWith(nl) ? nl : '';

  const block = table.split('\n').join(nl);
  const insert = lead + block + tail;
  const firstLine = table.split('\n')[0];
  const firstCell = firstLine.slice(firstLine.indexOf('|') + 1).split('|')[0].trim();
  const anchor = from + lead.length + 2;

  return {
    changes: [{ from, to, insert }],
    selection: { anchor, head: anchor + firstCell.length },
  };
}
