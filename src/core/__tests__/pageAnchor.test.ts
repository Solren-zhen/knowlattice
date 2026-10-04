import { describe, expect, it } from 'vitest';
import { hasPageAnchors, PAGE_ANCHOR_LINE_RE, pageAnchor, pageAnchors, stripPageAnchors } from '../pageAnchor';

describe('pageAnchor', () => {
  it('生成锚点标记', () => {
    expect(pageAnchor(182)).toBe('<!--kb:P182-->');
  });

  it('剥离整行锚点，不留空行残字', () => {
    const src = '<!--kb:P1-->\n# 标题\n\n正文。\n<!--kb:P2-->\n第二页。';
    expect(stripPageAnchors(src)).toBe('# 标题\n\n正文。\n第二页。');
  });

  it('剥离行内残留锚点', () => {
    expect(stripPageAnchors('正文<!--kb:P3-->续')).toBe('正文续');
  });

  it('pageAnchors 按顺序给出页号与位置', () => {
    const src = '<!--kb:P1-->\na\n<!--kb:P2-->\nb';
    const hits = pageAnchors(src);
    expect(hits.map((h) => h.page)).toEqual([1, 2]);
    expect(src.slice(hits[1].index, hits[1].index + 12)).toBe('<!--kb:P2-->');
  });

  it('hasPageAnchors 判定', () => {
    expect(hasPageAnchors('<!--kb:P1-->')).toBe(true);
    expect(hasPageAnchors('普通正文')).toBe(false);
  });

  it('PAGE_ANCHOR_LINE_RE 只认独占一行的锚点', () => {
    expect(PAGE_ANCHOR_LINE_RE.test('<!--kb:P7-->')).toBe(true);
    expect(PAGE_ANCHOR_LINE_RE.test('  <!--kb:P7-->  ')).toBe(true);
    expect(PAGE_ANCHOR_LINE_RE.test('正文 <!--kb:P7-->')).toBe(false);
  });
});
