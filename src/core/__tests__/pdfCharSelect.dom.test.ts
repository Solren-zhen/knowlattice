// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHighlights, selectByGeometry } from '../pdfCharSelect';
import type { TextBox } from '../pdfSelect';

const BOX = new Map<HTMLElement, TextBox>();

function rect(b: TextBox): DOMRect {
  return {
    x: b.left, y: b.top, left: b.left, top: b.top, right: b.right, bottom: b.bottom,
    width: b.right - b.left, height: b.bottom - b.top, toJSON: () => ({}),
  } as DOMRect;
}

// jsdom has no layout: fake element boxes, and derive a Range rect from the
// parent span box plus the character offsets (treat chars as equal width).
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    const b = BOX.get(this as HTMLElement);
    return b ? rect(b) : rect({ left: 0, top: 0, right: 0, bottom: 0 });
  };
  Range.prototype.getBoundingClientRect = function () {
    const node = this.startContainer as Text;
    const el = node.parentElement;
    const b = el ? BOX.get(el) : undefined;
    const base = b ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const len = (node.textContent ?? '').length || 1;
    const w = base.right - base.left;
    const left = base.left + (this.startOffset / len) * w;
    const right = base.left + (this.endOffset / len) * w;
    return rect({ left, top: base.top, right, bottom: base.bottom });
  };
});

afterEach(() => {
  BOX.clear();
  document.body.innerHTML = '';
});

function paneWith(text: string) {
  const pane = document.createElement('div');
  const el = document.createElement('span');
  el.className = 'rpv-core__text-layer-text';
  el.textContent = text;
  pane.appendChild(el);
  BOX.set(el, { left: 0, top: 0, right: 60, bottom: 20 });
  document.body.appendChild(pane);
  return { pane, el };
}

describe('selectByGeometry (jsdom)', () => {
  it('returns empty for a click without a drag', () => {
    const { pane } = paneWith('abcdef');
    expect(selectByGeometry(pane, { x: 30, y: 10 }, { x: 31, y: 10 })).toBe('');
    expect(pane.querySelectorAll('.pdf-geo-hl').length).toBe(0);
  });

  it('highlights only the covered characters on a drag', () => {
    const { pane, el } = paneWith('abcdef');
    expect(selectByGeometry(pane, { x: 0, y: 10 }, { x: 30, y: 10 })).toBe('abc');
    const hl = pane.querySelectorAll('.pdf-geo-hl');
    expect(hl.length).toBe(1);
    expect(hl[0].textContent).toBe('abc');
    expect(el.textContent).toBe('abcdef');
    clearHighlights(pane);
    expect(pane.querySelectorAll('.pdf-geo-hl').length).toBe(0);
    expect(el.textContent).toBe('abcdef');
  });
});
