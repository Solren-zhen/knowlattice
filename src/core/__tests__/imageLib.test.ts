/**
 * 图片库的纯逻辑：从附件路径里挑出图片、排序、生成 Markdown。
 *
 * 这里的规则若出错，用户看到的是「图裂了」或「图不在库里」——都不是崩溃，
 * 只会被当成「这软件怪怪的」，所以单独钉一遍。
 */
import { describe, expect, it } from 'vitest';
import { filterImages, imageEntries, imageLibSummary, imageMarkdown } from '../imageLib';

const PATHS = [
  '_attachments/膀胱三角.png',
  '_attachments/生理学/动作电位.webp',
  '_attachments/讲义.pdf',
  '_attachments/note.md',
  '/_attachments/空格 名字.jpg',
  'notes/图.png',
];

describe('imageEntries', () => {
  it('只留图片，按路径排序，拆出文件名与目录', () => {
    const got = imageEntries(PATHS);
    expect(got.map((e) => e.path)).toEqual([
      '_attachments/生理学/动作电位.webp',
      '_attachments/空格 名字.jpg',
      '_attachments/膀胱三角.png',
      'notes/图.png',
    ].sort((a, b) => a.localeCompare(b)));
    expect(got.find((e) => e.name === '动作电位.webp')?.dir).toBe('_attachments/生理学');
    // pdf / md 不是图片
    expect(got.some((e) => e.name === '讲义.pdf')).toBe(false);
    expect(got.some((e) => e.name === 'note.md')).toBe(false);
  });

  it('没有目录前缀时 dir 为空串而不是 undefined', () => {
    const got = imageEntries(['封面.png']);
    expect(got).toEqual([{ path: '封面.png', name: '封面.png', dir: '' }]);
  });

  it('空列表返回空数组', () => {
    expect(imageEntries([])).toEqual([]);
  });
});

describe('filterImages', () => {
  const entries = imageEntries(PATHS);

  it('按文件名过滤，大小写不敏感', () => {
    expect(filterImages(entries, 'WEBP')).toHaveLength(1);
    expect(filterImages(entries, '生理学')).toHaveLength(1);
  });

  it('空查询原样返回（同一个数组引用，避免每次输入都重建）', () => {
    expect(filterImages(entries, '   ')).toBe(entries);
  });

  it('没有命中返回空数组', () => {
    expect(filterImages(entries, '不存在的图')).toEqual([]);
  });
});

describe('imageMarkdown', () => {
  it('普通路径直接写', () => {
    expect(imageMarkdown('_attachments/图.png', '图')).toBe('![图](_attachments/图.png)');
  });

  it('路径含空格或括号时用尖括号包起来（否则地址会被截断成两段）', () => {
    expect(imageMarkdown('_attachments/空格 名字.jpg')).toBe('![](<_attachments/空格 名字.jpg>)');
    expect(imageMarkdown('_attachments/图(1).png')).toBe('![](<_attachments/图(1).png>)');
  });
});

describe('imageLibSummary', () => {
  it('单目录时把目录名报出来', () => {
    expect(imageLibSummary(imageEntries(['_attachments/a.png']))).toBe('1 张图片（_attachments）');
  });

  it('多目录只说数量', () => {
    expect(imageLibSummary(imageEntries(['_attachments/a.png', 'notes/b.png']))).toContain('2 张图片（2 个目录）');
  });

  it('空库只报数量', () => {
    expect(imageLibSummary([])).toBe('0 张图片');
  });
});
