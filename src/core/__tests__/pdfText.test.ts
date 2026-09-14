import { describe, expect, it } from 'vitest';
import { normalizePdfSelection } from '../pdfText';

describe('normalizePdfSelection', () => {
  it('移除中文字符之间和标点前的 PDF 排版空格', () => {
    expect(normalizePdfSelection('甲 状 腺 结 节 ， 需 要 复 查 。')).toBe('甲状腺结节，需要复查。');
  });

  it('保留英文单词之间的空格并清理换行空白', () => {
    expect(normalizePdfSelection('clinical outcome\n需要 复 查')).toBe('clinical outcome需要复查');
  });

  it('移除软连字符和首尾空白', () => {
    expect(normalizePdfSelection('  hyper\u00adthyroidism  ')).toBe('hyperthyroidism');
  });
});

describe('normalizePdfSelection hyphenation + paragraphs', () => {
  it('joins an English word split across a line break', () => {
    expect(normalizePdfSelection('infor-\nmation')).toBe('information');
  });

  it('keeps blank-line paragraph breaks', () => {
    expect(normalizePdfSelection('first paragraph\n\nsecond paragraph'))
      .toBe('first paragraph\n\nsecond paragraph');
  });

  it('still collapses a single line break to a space', () => {
    expect(normalizePdfSelection('first line\nsecond line')).toBe('first line second line');
  });
});
