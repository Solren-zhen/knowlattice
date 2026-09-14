import { describe, expect, it } from 'vitest';
import { pickCharParts } from '../pdfCharSelect';
import type { TextBox } from '../pdfSelect';

const box = (top: number, left: number, width = 60, height = 20): TextBox => ({
  top, left, right: left + width, bottom: top + height,
});

// Four visual lines, two boxes each; DOM order is intentionally scrambled.
const mk = (top: number, left: number, text: string) => ({ box: box(top, left), text });
const items = [
  mk(0, 10, 'abcdef'), mk(0, 100, 'ghijkl'),   // line 1 -> 0,1
  mk(40, 10, 'uvwxyz'), mk(40, 100, 'mnopqr'), // line 3 -> 2,3
  mk(20, 10, 'stuvwx'), mk(20, 100, 'yzabcd'), // line 2 -> 4,5
  mk(60, 10, 'efghij'), mk(60, 100, 'klmnop'), // line 4 -> 6,7
];

const charAt = (i: number, x: number): number => {
  const b = items[i].box;
  const len = items[i].text.length;
  return Math.max(0, Math.min(len, Math.round(((x - b.left) / (b.right - b.left)) * len)));
};

const read = (parts: ReturnType<typeof pickCharParts>) =>
  parts.map((p) => items[p.index].text.slice(p.start, p.end)).join('|');

describe('pickCharParts', () => {
  it('trims a single line to the exact character range', () => {
    expect(pickCharParts(items, { x: 40, y: 10 }, { x: 130, y: 10 }, charAt))
      .toEqual([{ index: 0, start: 3, end: 6 }, { index: 1, start: 0, end: 3 }]);
  });

  it('keeps middle lines whole and trims start/end lines', () => {
    const parts = pickCharParts(items, { x: 35, y: 5 }, { x: 70, y: 45 }, charAt);
    expect(read(parts)).toBe('def|ghijkl|stuvwx|yzabcd|uvwxyz');
  });

  it('also works when dragging upwards', () => {
    const parts = pickCharParts(items, { x: 35, y: 45 }, { x: 70, y: 5 }, charAt);
    expect(read(parts)).toBe('ghijkl|stuvwx|yzabcd|uvw');
  });
});

describe('pickCharParts columnMode', () => {
  const rows = [
    { y: 0, l: 'abcdef', r: 'ghijkl' },
    { y: 20, l: 'mnopqr', r: 'stuvwx' },
    { y: 40, l: 'yzabcd', r: 'efghij' },
  ];
  const twoCol = rows.flatMap((row) => [
    { box: { left: 10, top: row.y, right: 70, bottom: row.y + 20 }, text: row.l },
    { box: { left: 200, top: row.y, right: 260, bottom: row.y + 20 }, text: row.r },
  ]);
  const at = (i: number, x: number): number => {
    const b = twoCol[i].box;
    const len = twoCol[i].text.length;
    return Math.max(0, Math.min(len, Math.round(((x - b.left) / (b.right - b.left)) * len)));
  };
  const text = (parts: ReturnType<typeof pickCharParts>) =>
    parts.map((p) => twoCol[p.index].text.slice(p.start, p.end)).join('|');

  it('skips the far column on every line when enabled', () => {
    const parts = pickCharParts(twoCol, { x: 40, y: 5 }, { x: 40, y: 45 }, at, { columnMode: true });
    expect(text(parts)).toBe('def|mnopqr|yza');
  });

  it('keeps both columns when disabled', () => {
    const parts = pickCharParts(twoCol, { x: 40, y: 5 }, { x: 40, y: 45 }, at);
    expect(text(parts)).toBe('def|ghijkl|mnopqr|stuvwx|yza');
  });
});
