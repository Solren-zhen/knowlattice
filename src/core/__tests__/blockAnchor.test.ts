/**
 * 块级锚点的纯函数测试。
 *
 * 钉住四件容易写错的事：段尾 id 的写入位置（多一个空格就渲染成两段）、已有 id 不重复写、
 * 同一段文字生成同一个 id（撤销重做不会变成两个块）、`#^id` 只在块引用形态下才拆开。
 */
import { describe, expect, it } from 'vitest';
import {
  blockIdOf,
  blockRef,
  ensureBlockId,
  findBlockText,
  makeBlockId,
  paragraphBounds,
  splitBlockTarget,
  stripBlockIds,
} from '../blockAnchor';

describe('块标记的读写', () => {
  it('读出段尾 id，没有就是 null', () => {
    expect(blockIdOf('细胞膜是半透膜 ^k3f9x2')).toBe('k3f9x2');
    expect(blockIdOf('细胞膜是半透膜')).toBeNull();
    // 只有 id 单独一行也算
    expect(blockIdOf('正文\n^k3f9x2')).toBe('k3f9x2');
  });

  it('剥离标记时连前面的空白一起剥，正文不留空尾', () => {
    expect(stripBlockIds('第一段 ^abc123\n第二段\n^def456')).toBe('第一段\n第二段\n');
  });

  it('同一段文字生成同一个 id，改一个字就变', () => {
    expect(makeBlockId('静息电位由钾外流决定')).toBe(makeBlockId('静息电位由钾外流决定'));
    expect(makeBlockId('静息电位由钾外流决定')).not.toBe(makeBlockId('静息电位由钠内流决定'));
    expect(makeBlockId('静息电位由钾外流决定')).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('给段落补 id', () => {
  it('插在段末且只插入一次', () => {
    const doc = '第一段\n\n第二段正文\n\n第三段';
    const pos = doc.indexOf('第二段');
    const r = ensureBlockId(doc, pos);
    expect(r).not.toBeNull();
    const after = doc.slice(0, r!.edit!.changes[0].from) + r!.edit!.changes[0].insert
      + doc.slice(r!.edit!.changes[0].to);
    expect(after).toContain(`第二段正文 ^${r!.id}`);
    // 再跑一次：已经有 id，不许文档再动
    const again = ensureBlockId(after, after.indexOf('第二段'));
    expect(again!.id).toBe(r!.id);
    expect(again!.edit).toBeNull();
  });

  it('跨行的段落被当成一个块，id 落在最后一行末尾', () => {
    const doc = '标题行\n续行内容\n\n下一段';
    const r = ensureBlockId(doc, 0);
    expect(r!.id).toBe(makeBlockId('标题行\n续行内容'));
    expect(r!.edit!.changes[0].from).toBe(doc.indexOf('续行内容') + '续行内容'.length);
  });

  it('空段落与空文档返回 null（没有内容可指）', () => {
    expect(ensureBlockId('', 0)).toBeNull();
    expect(ensureBlockId('前文\n\n\n后文', 4)).toBeNull();
  });
});

describe('引用串', () => {
  it('生成 [[笔记#^id]]，笔记名带 .md 时去掉扩展名', () => {
    expect(blockRef('生理学/细胞', 'k3f9x2')).toBe('[[生理学/细胞#^k3f9x2]]');
    expect(blockRef('生理学/细胞.md', 'k3f9x2')).toBe('[[生理学/细胞#^k3f9x2]]');
  });

  it('只拆块引用形态，#标题 片段保持原样', () => {
    expect(splitBlockTarget('生理学/细胞#^k3f9x2')).toEqual({ name: '生理学/细胞', block: 'k3f9x2' });
    expect(splitBlockTarget('生理学/细胞#静息电位')).toEqual({ name: '生理学/细胞#静息电位', block: null });
  });
});

describe('回读块正文', () => {
  it('找到含 id 的整段并剥掉标记', () => {
    const doc = '前一段\n\n静息电位由钾外流决定 ^k3f9x2\n第二行\n\n后一段';
    expect(findBlockText(doc, 'k3f9x2')).toBe('静息电位由钾外流决定\n第二行');
    expect(findBlockText(doc, 'zzzzzz')).toBeNull();
  });
});

describe('段落边界', () => {
  it('光标在中间行也扩到整段', () => {
    const doc = 'A\nB\nC\n\nD';
    expect(paragraphBounds(doc, 2)).toEqual({ from: 0, to: 5 });
  });
});
