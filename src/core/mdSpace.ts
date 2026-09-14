/**
 * Markdown-aware CJK whitespace cleanup for converted documents.
 *
 * PDF text extraction joins visual lines with spaces, which shows up as random
 * spaces inside Chinese words, before punctuation, and
 * between CJK and Latin. normalizePdfSelection already strips those, but it
 * must not damage Markdown structure (heading or list markers, code spans,
 * table pipes), so this module protects those parts first and cleans only the
 * text runs.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}\s/;
const STRUCT_PREFIX = /^(\s*(?:[-*+]|\d+[.)]|>)\s+)/;
const INLINE_PROTECT = /( ?`[^`]*` ?| ?\[[^\]]*\]\([^)]*\) ?)/g;

/** Collapse stray whitespace in text runs while keeping Markdown syntax. */
export function normalizeMarkdownSpacing(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = inFence === false;
      out.push(line);
      continue;
    }
    if (inFence || HEADING.test(line)) { out.push(line); continue; }
    out.push(cleanLine(line));
  }
  return out.join('\n');
}

function cleanLine(line: string): string {
  if (/^\s*\|/.test(line)) return cleanTableRow(line);
  const m = line.match(STRUCT_PREFIX);
  const prefix = m ? m[1] : '';
  const rest = prefix ? line.slice(prefix.length) : line;
  return prefix + cleanInline(rest);
}

/** Table rows: clean each cell text, keep pipe layout and padding. */
function cleanTableRow(line: string): string {
  const parts = line.split('|');
  for (let i = 1; i < parts.length - 1; i++) {
    const cell = parts[i].trim();
    if (cell.length > 0) parts[i] = ' ' + cleanCjkText(cell) + ' ';
  }
  return parts.join('|');
}

/** Protect inline code and links, clean the rest, then restore them. */
function cleanInline(text: string): string {
  const saved: string[] = [];
  const t = text.replace(INLINE_PROTECT, (hit) => {
    saved.push(hit);
    return '\u0000' + (saved.length - 1) + '\u0000';
  });
  return finishInline(cleanCjkText(t), saved);
}

/** Split sub/superscripts like "PO 2" -> "PO2", then restore protected runs. */
function finishInline(text: string, saved: string[]): string {
  const t = text.replace(/\b([A-Z]{1,3}) ([0-9])/g, '$1$2');
  return t.replace(/\u0000(\d+)\u0000/g, (_hit, i: string) => saved[Number(i)]);
}

const CJK = '\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff';
const CJK_PUNCT = '\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001\uff09\u300b\u3009\u300d\u300f\u201d\u2019';
const OPEN_PUNCT = '\uff08\u300a\u3008\u300c\u300e\u201c\u2018';

/**
 * Strip the whitespace that PDF line joining inserted inside Chinese text, while
 * keeping the spaces between CJK and Latin/digits (that typography is fine).
 */
function cleanCjkText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(new RegExp(`([${CJK}]) +(?=[${CJK}])`, 'g'), '$1')
    .replace(new RegExp(` +(?=[${CJK_PUNCT}])`, 'g'), '')
    .replace(new RegExp(`([${CJK_PUNCT}]) +(?=[${CJK}])`, 'g'), '$1')
    .replace(new RegExp(`([${CJK_PUNCT}]) +(?=[${CJK_PUNCT}])`, 'g'), '$1')
    .replace(new RegExp(`([${OPEN_PUNCT}]) +`, 'g'), '$1')
    .trim();
}
