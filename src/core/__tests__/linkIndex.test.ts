import { describe, expect, it } from 'vitest';
import { backlinks, extractLinks, rebuildLinkIndex, updateLinksForPath } from '../linkIndex';

describe('extractLinks', () => {
  it('提取 [[目标]] 并去重（别名语法 [[目标|显示]] 时记录目标）', () => {
    const links = extractLinks('a [[氧解离曲线]] b [[氧解离曲线]] c [[肺|肺牵张反射]]');
    expect(links).toEqual(['氧解离曲线', '肺']);
  });

  it('无链接返回空数组', () => {
    expect(extractLinks('普通文本')).toEqual([]);
  });
});

// 独立首尾不含双链
const A = '[[B]]';
const B = '[[c]] 提到 [[A]]';
const C = '普通文本';

function makeDocs() {
  return new Map<string, string>([
    ['a.md', A],
    ['b.md', B],
    ['c.md', C],
  ]);
}

describe('rebuildLinkIndex / updateLinksForPath / backlinks', () => {
  it('全量重建：outgoing 与 incoming 配对', () => {
    const idx = rebuildLinkIndex(makeDocs());
    expect(idx.outgoing.get('a.md')).toEqual(['B']);
    expect(idx.outgoing.get('b.md')).toEqual(['c', 'A']);
    expect(idx.incoming.get('b'.toLowerCase())).toEqual(['a.md']);
    expect(idx.incoming.get('c'.toLowerCase())).toEqual(['b.md']);
    expect(idx.incoming.get('a'.toLowerCase())).toEqual(['b.md']);
  });

  it('incoming 不区分大小写', () => {
    const idx = rebuildLinkIndex(makeDocs());
    expect(backlinks(idx, 'B')).toEqual(['a.md']);
    expect(backlinks(idx, 'b')).toEqual(['a.md']);
  });

  it('增量更新：修改一篇只影响该篇的反链', () => {
    const idx = rebuildLinkIndex(makeDocs());
    // b.md 改为链接 a 与 z（c 的引用被移除后又加回，出链顺序按正文出现顺序）
    updateLinksForPath(idx, 'b.md', '[[A]] 不再提 [[c]]，现在链接 [[z]]');
    expect(backlinks(idx, 'c')).toEqual(['b.md']);
    expect(idx.incoming.get('z'.toLowerCase())).toEqual(['b.md']);
    expect(idx.outgoing.get('b.md')).toEqual(['A', 'c', 'z']);
  });

  it('删链接再增链接不产生重复条目（大小写不同指向同一目标）', () => {
    const idx = rebuildLinkIndex(makeDocs());
    updateLinksForPath(idx, 'a.md', '[[b]] [[B]]');
    expect(backlinks(idx, 'b')).toEqual(['a.md']);
  });

  it('content 空串等于删除该篇的链接参与', () => {
    const idx = rebuildLinkIndex(makeDocs());
    updateLinksForPath(idx, 'a.md', '');
    expect(idx.outgoing.get('a.md')).toEqual([]);
    expect(backlinks(idx, 'B')).toEqual([]);
  });

  it('非 .md 路径不参与索引', () => {
    const idx = rebuildLinkIndex(new Map([['img.png', '[[x]]']]));
    expect(idx.outgoing.get('img.png')).toEqual([]);
    expect(idx.incoming.size).toBe(0);
  });
});
