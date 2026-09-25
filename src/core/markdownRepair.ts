/** High-confidence repairs for Markdown imported from external sources. */

export type MarkdownRepairKind = 'escaped-table-pipe';

export interface MarkdownRepairChange {
  kind: MarkdownRepairKind;
  count: number;
}

export interface MarkdownRepairResult {
  content: string;
  changed: boolean;
  changes: MarkdownRepairChange[];
}

const FENCE_RE = /^\s*(```+|~~~+)/;
const TABLE_ROW_RE = /^\s*(?:\\+)?\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*(?:\\+)?\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

function isTableRow(line: string): boolean {
  return TABLE_ROW_RE.test(line);
}

function hasTableSeparator(lines: string[], index: number): boolean {
  return TABLE_SEPARATOR_RE.test(lines[index]);
}

function isEscapedPipeRow(line: string): boolean {
  return /^\s*\\+\|/.test(line);
}

/**
 * Restore only escaped pipes inside a confidently detected GFM table.
 * Fences are excluded so examples/code blocks remain byte-for-byte intact.
 */
export function repairMarkdown(content: string): MarkdownRepairResult {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const changes: MarkdownRepairChange[] = [];
  let fenceChar: string | null = null;
  let repaired = 0;

  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const marker = fence[1][0];
      if (fenceChar === null) fenceChar = marker;
      else if (fenceChar === marker) fenceChar = null;
      continue;
    }
    if (fenceChar !== null || !hasTableSeparator(lines, i)) continue;

    let start = i - 1;
    while (start >= 0 && isTableRow(lines[start])) start--;
    start += 1;
    let end = i + 1;
    while (end < lines.length && isTableRow(lines[end])) end++;
    if (end - start < 2) continue;

    for (let row = start; row < end; row++) {
      if (!isEscapedPipeRow(lines[row])) continue;
      lines[row] = lines[row].replace(/^(\s*)\\+\|/, '$1|');
      repaired += 1;
    }
  }

  if (repaired > 0) changes.push({ kind: 'escaped-table-pipe', count: repaired });
  const next = lines.join('\n');
  return {
    content: newline === '\n' ? next : next.replace(/\n/g, newline),
    changed: repaired > 0,
    changes,
  };
}
