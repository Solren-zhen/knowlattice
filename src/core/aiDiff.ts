/**
 * 行级 diff（LCS）：AI 笔记助手的修改预览用。
 * - diffLines：逐行比较新旧正文，产出 add/del/same 序列
 * - collapseDiff：把长段未变化行折叠成 gap，卡片里只留改动点 ± 上下文
 * LCS 空间是 (n+1)*(m+1) 个 Int32；超上限（超长笔记 + 重写全文）时退化为
 * 「去公共前后缀，中间整体删加」——不够精细，但不会把内存顶爆。
 */

export interface DiffRow {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface GapRow {
  type: 'gap';
  /** 折叠掉的未变行数 */
  count: number;
}

export type CollapsedRow = DiffRow | GapRow;

/** LCS 单元格数超过该值就退化为粗粒度对比（约 24MB Int32） */
const LCS_CELL_LIMIT = 6_000_000;

export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  // 快路径：完全一致 / 一边为空（split('\n') 对 '' 会返回 ['']，所以要按字符串判空）
  if (oldText === newText) return a.map((text) => ({ type: 'same' as const, text }));
  if (oldText === '') return b.map((text) => ({ type: 'add' as const, text }));
  if (newText === '') return a.map((text) => ({ type: 'del' as const, text }));

  if (a.length * b.length > LCS_CELL_LIMIT) return coarseDiff(a, b);

  // LCS 长度表：lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs = new Int32Array((a.length + 1) * (b.length + 1));
  const at = (i: number, j: number) => i * (b.length + 1) + j;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[at(i, j)] = a[i] === b[j]
        ? lcs[at(i + 1, j + 1)] + 1
        : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  // 回溯出编辑脚本
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ type: 'same', text: a[i] }); i++; j++; continue; }
    if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < a.length) { rows.push({ type: 'del', text: a[i] }); i++; }
  while (j < b.length) { rows.push({ type: 'add', text: b[j] }); j++; }
  return rows;
}

/** 超长输入的兜底：公共前后缀保持原样，中间整块「删旧加新」 */
function coarseDiff(a: string[], b: string[]): DiffRow[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [
    ...a.slice(0, start).map((text) => ({ type: 'same' as const, text })),
    ...a.slice(start, endA).map((text) => ({ type: 'del' as const, text })),
    ...b.slice(start, endB).map((text) => ({ type: 'add' as const, text })),
    ...a.slice(endA).map((text) => ({ type: 'same' as const, text })),
  ];
}

/** 连续未变行超过 2*context+1 时折叠中段，改动点前后各保留 context 行 */
export function collapseDiff(rows: DiffRow[], context = 2): CollapsedRow[] {
  const out: CollapsedRow[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= context * 2 + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, context));
      out.push({ type: 'gap', count: run.length - context * 2 });
      out.push(...run.slice(run.length - context));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'same') run.push(row);
    else { flush(); out.push(row); }
  }
  flush();
  return out;
}
