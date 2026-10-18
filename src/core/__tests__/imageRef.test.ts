/**
 * 图片引用解析：尺寸写法与找图顺序对齐 Obsidian（用户的库里真在用 `![[fig/x.png|300]]`）。
 * 这些是纯函数，编辑器实时预览与右侧预览共用同一份规则。
 */
import { describe, expect, it } from 'vitest';
import { attachmentCandidates, basenameIndex, parseEmbedSpec } from '../imageRef';

describe('parseEmbedSpec：尺寸 vs 说明文字', () => {
  it('没有管道内容时按文件名作 alt、不带尺寸', () => {
    expect(parseEmbedSpec('fig/间断点1-可去.png')).toEqual({
      name: 'fig/间断点1-可去.png', alt: '间断点1-可去.png', size: {},
    });
  });

  it('|300 是宽度，不是说明文字', () => {
    expect(parseEmbedSpec('fig/间断点1-可去.png|300')).toMatchObject({ size: { width: 300 } });
  });

  it('|640x480 宽高都钉（x 与 × 都认）', () => {
    expect(parseEmbedSpec('图.png|640x480').size).toEqual({ width: 640, height: 480 });
    expect(parseEmbedSpec('图.png|640 × 480').size).toEqual({ width: 640, height: 480 });
  });

  it('| 后面不是数字就是说明文字，原样当 alt', () => {
    expect(parseEmbedSpec('图.png|这是说明')).toEqual({
      name: '图.png', alt: '这是说明', size: {},
    });
  });

  it('管道内容前后空格不影响判定', () => {
    expect(parseEmbedSpec('图.png| 300 ').size).toEqual({ width: 300 });
  });

});

describe('找图顺序', () => {
  it('只写文件名：原路径 → _attachments/ 前缀 → 全库唯一同名', () => {
    const idx = basenameIndex(['_attachments/fig/曲率-定义.png', '_attachments/其它.md', '_attachments/其他.png']);
    expect(attachmentCandidates('曲率-定义.png', idx))
      .toEqual(['曲率-定义.png', '_attachments/曲率-定义.png', '_attachments/fig/曲率-定义.png']);
  });

  it('带子目录：只在原路径与 _attachments/ 前缀里找（与 Obsidian 的库相对路径一致）', () => {
    const idx = basenameIndex(['_attachments/fig/a.png']);
    expect(attachmentCandidates('fig/a.png', idx)).toEqual(['fig/a.png', '_attachments/fig/a.png']);
  });

  it('给了笔记目录时，再按「与笔记同级」找一遍（Obsidian 的相对路径写法）', () => {
    const idx = basenameIndex(['_attachments/数一/高数/fig/a.png']);
    expect(attachmentCandidates('fig/a.png', idx, '数一/高数/')).toEqual([
      'fig/a.png',
      '_attachments/fig/a.png',
      '数一/高数/fig/a.png',
      '_attachments/数一/高数/fig/a.png',
    ]);
    // 重名时也能靠「与笔记同级」定下来，不必退化成歧义
    const dup = basenameIndex(['_attachments/一章/fig/a.png', '_attachments/二章/fig/a.png']);
    expect(attachmentCandidates('fig/a.png', dup, '二章/')).toContain('_attachments/二章/fig/a.png');
  });

  it('同名的多张图算歧义：不给第三候选，宁可显示「未导入」也不猜错', () => {
    const idx = basenameIndex(['_attachments/一章/a.png', '_attachments/二章/a.png']);
    expect(idx.get('a.png')).toBeNull();
    expect(attachmentCandidates('a.png', idx)).toEqual(['a.png', '_attachments/a.png']);
  });

  it('已经是 _attachments/ 全路径的引用不再加前缀', () => {
    const idx = basenameIndex(['_attachments/a.png']);
    expect(attachmentCandidates('_attachments/a.png', idx)).toEqual(['_attachments/a.png']);
  });
});

describe('尺寸边界', () => {
  it('超过上限按上限算（笔误不该让浏览器布局一张 10 万像素宽的图）', () => {
    expect(parseEmbedSpec('图.png|99999').size).toEqual({ width: 4000 });
    expect(parseEmbedSpec('图.png|99999x99999').size).toEqual({ width: 4000, height: 4000 });
  });

  it('上限之内的尺寸原样保留', () => {
    expect(parseEmbedSpec('图.png|4000').size).toEqual({ width: 4000 });
  });

  it('|0 当作没写尺寸：width=0 等于把图藏起来', () => {
    expect(parseEmbedSpec('图.png|0').size).toEqual({});
    expect(parseEmbedSpec('图.png|0x480').size).toEqual({ width: undefined, height: 480 });
  });

  it('文件名里的空格不影响解析（路径与尺寸分开看）', () => {
    expect(parseEmbedSpec('Screenshot 2026-10-17 at 10.30.11.png|300')).toEqual({
      name: 'Screenshot 2026-10-17 at 10.30.11.png',
      alt: 'Screenshot 2026-10-17 at 10.30.11.png',
      size: { width: 300 },
    });
  });
});
