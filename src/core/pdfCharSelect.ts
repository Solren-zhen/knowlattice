/**
 * Character-level geometric selection for the PDF text layer.
 *
 * Whole-line snapping stopped a drag from grabbing the whole page, but it also
 * auto-selected a full line on a simple click and made half-line selection
 * impossible. This keeps the visual-order line grouping while trimming the
 * start/end lines to the exact character.
 *
 * pickCharParts is pure (unit-tested); selectByGeometry / clearHighlights are
 * the DOM glue used by PdfSplitView.
 */
import { groupLines, isDragGesture, joinOrderedText, type TextBox } from './pdfSelect';

export interface TextItem { box: TextBox; text: string; }
/** Character range [start, end) inside one text box. */
export interface CharPart { index: number; start: number; end: number; }
/** Map an x position to a character index (0..len) inside item index. */
export type CharAtX = (index: number, x: number) => number;

/** Vertical top/bottom of each visual line. */
function bandsOf(lines: number[][], boxes: TextBox[]): Array<{ top: number; bottom: number }> {
  return lines.map((idxs) => {
    let top = Infinity, bottom = -Infinity;
    for (const i of idxs) {
      top = Math.min(top, boxes[i].top);
      bottom = Math.max(bottom, boxes[i].bottom);
    }
    return { top, bottom };
  });
}

/** Pick the line containing y (small tolerance), else the nearest one. */
function lineNear(bands: Array<{ top: number; bottom: number }>, y: number) {
  let inside = -1, insideDist = Infinity, nearest = -1, nearestDist = Infinity;
  bands.forEach((b, i) => {
    const d = Math.abs((b.top + b.bottom) / 2 - y);
    if (y >= b.top - 6 && y <= b.bottom + 6 && d < insideDist) { insideDist = d; inside = i; }
    if (d < nearestDist) { nearestDist = d; nearest = i; }
  });
  return inside >= 0 ? inside : nearest;
}

export function pickCharParts(
  items: TextItem[],
  anchor: { x: number; y: number },
  focus: { x: number; y: number },
  charAtX: CharAtX,
  options?: { columnMode?: boolean },
): CharPart[] {
  const boxes = items.map((it) => it.box);
  const lines = groupLines(boxes);
  if (lines.length === 0) return [];
  const bands = bandsOf(lines, boxes);
  const al = lineNear(bands, anchor.y);
  const fl = lineNear(bands, focus.y);
  if (al < 0 || fl < 0) return [];
  const out: CharPart[] = [];
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const push = (index: number, start: number, end: number) => {
    const len = items[index].text.length;
    const s = clamp(start, len), e = clamp(end, len);
    if (e > s) out.push({ index, start: s, end: e });
  };
  const at = (index: number, x: number) => {
    const v = charAtX(index, x);
    return Number.isFinite(v) ? v : 0;
  };

  // Same line: trim to the horizontal interval, character by character.
  if (al === fl) {
    const lo = Math.min(anchor.x, focus.x);
    const hi = Math.max(anchor.x, focus.x);
    for (const i of lines[al]) {
      const b = boxes[i];
      if (b.right < lo || b.left > hi) continue;
      const start = b.left >= lo ? 0 : at(i, lo);
      const end = b.right <= hi ? items[i].text.length : at(i, hi);
      push(i, start, end);
    }
    return out;
  }

  // Across lines: trim start/end line to the anchor/focus character, keep the
  // lines in between whole so a vertical drag never drops a row.
  const forward = al < fl;
  const startLine = forward ? al : fl;
  const endLine = forward ? fl : al;
  const startX = forward ? anchor.x : focus.x;
  const endX = forward ? focus.x : anchor.x;
  for (let li = startLine; li <= endLine; li++) {
    for (const i of lines[li]) {
      const b = boxes[i];
      if (options?.columnMode) {
        const pad = Math.max(10, b.bottom - b.top);
        const px = Math.min(anchor.x, focus.x) - pad;
        const qx = Math.max(anchor.x, focus.x) + pad;
        const mid = (b.left + b.right) / 2;
        if (mid < px || mid > qx) continue;
      }
      const full = items[i].text.length;
      const start = li === startLine && b.left < startX ? at(i, startX) : 0;
      const end = li === endLine && b.right > endX ? at(i, endX) : full;
      push(i, start, end);
    }
  }
  return out;
}

/* ---------------- DOM glue ---------------- */

const TEXT_SPAN_SELECTOR = '.rpv-core__text-layer-text';
const HIGHLIGHT_CLASS = 'pdf-geo-hl';
const WRAP_ATTR = 'data-pdf-hl-wrap';

interface SpanInfo { el: HTMLElement; text: string; box: TextBox; }

// Per-drag layout cache: measure every span once on pointerdown, reuse on
// pointermove. Cleared by endGeometrySelection().
let spanCache: { pane: HTMLElement; spans: SpanInfo[] } | null = null;

export function beginGeometrySelection(pane: HTMLElement | null) {
  spanCache = pane ? { pane, spans: collectSpans(pane) } : null;
}

export function endGeometrySelection() {
  spanCache = null;
}

function collectSpans(pane: HTMLElement): SpanInfo[] {
  return Array.from(pane.querySelectorAll<HTMLElement>(TEXT_SPAN_SELECTOR))
    .filter((s) => (s.textContent ?? '').trim().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        text: el.textContent ?? '',
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      };
    });
}

/** Map screen x to a character index inside one span, via Range binary search. */
function charIndexAtX(el: HTMLElement, x: number): number {
  const node = el.firstChild;
  if (node && node.nodeType === 3) {
    const len = (node as Text).data.length;
    if (len > 0) {
      const range = document.createRange();
      let lo = 0, hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        range.setStart(node, 0);
        range.setEnd(node, mid + 1);
        if (range.getBoundingClientRect().right > x) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    return 0;
  }
  const r = el.getBoundingClientRect();
  const len = (el.textContent ?? '').length;
  if (len === 0 || r.width <= 0) return 0;
  return Math.max(0, Math.min(len, Math.round(((x - r.left) / r.width) * len)));
}

function rangeBox(el: HTMLElement, start: number, end: number, fallback: TextBox): TextBox {
  const node = el.firstChild;
  if (node && node.nodeType === 3) {
    const len = (node as Text).data.length;
    const range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(start, len)));
    range.setEnd(node, Math.max(0, Math.min(end, len)));
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return fallback;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return fallback;
}

/** Wrap [start, end) of a span in a highlight element (full span uses a class). */
function wrapRange(el: HTMLElement, start: number, end: number) {
  const node = el.firstChild;
  if (node && node.nodeType === 3) {
    const text = (node as Text).data;
    const mid = text.slice(start, end);
    if (mid.length === 0) return;
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(document.createTextNode(text.slice(0, start)));
    const hl = document.createElement('span');
    hl.className = HIGHLIGHT_CLASS;
    hl.setAttribute(WRAP_ATTR, '1');
    hl.textContent = mid;
    frag.appendChild(hl);
    if (end < text.length) frag.appendChild(document.createTextNode(text.slice(end)));
    el.replaceChild(frag, node);
    return;
  }
  el.classList.add(HIGHLIGHT_CLASS);
}

/** Remove the self-drawn highlight and restore the original text nodes. */
export function clearHighlights(root: HTMLElement | null) {
  if (root === null) return;
  root.querySelectorAll<HTMLElement>('.' + HIGHLIGHT_CLASS).forEach((el) => {
    if (el.getAttribute(WRAP_ATTR) === '1' && el.parentNode) {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent ?? ''), el);
      parent.normalize();
    } else {
      el.classList.remove(HIGHLIGHT_CLASS);
    }
  });
}

/**
 * Highlight and read back the drag selection. A plain click (no drag) returns
 * an empty string, so the view does not auto-select a whole line.
 */
export function selectByGeometry(
  pane: HTMLElement,
  anchor: { x: number; y: number },
  focus: { x: number; y: number },
  options?: { columnMode?: boolean },
): string {
  clearHighlights(pane);
  if (isDragGesture(anchor.x, anchor.y, focus.x, focus.y) === false) return '';
  const spans = spanCache && spanCache.pane === pane ? spanCache.spans : collectSpans(pane);
  if (spans.length === 0) return '';
  const parts = pickCharParts(
    spans.map((s) => ({ box: s.box, text: s.text })),
    anchor,
    focus,
    (i, x) => charIndexAtX(spans[i].el, x),
    options,
  );
  if (parts.length === 0) return '';
  const out: Array<{ text: string; box: TextBox }> = [];
  for (const p of parts) {
    const s = spans[p.index];
    const full = p.start === 0 && p.end === s.text.length;
    const box = full ? s.box : rangeBox(s.el, p.start, p.end, s.box);
    if (full) s.el.classList.add(HIGHLIGHT_CLASS);
    else wrapRange(s.el, p.start, p.end);
    out.push({ text: s.text.slice(p.start, p.end), box });
  }
  return joinOrderedText(out);
}
