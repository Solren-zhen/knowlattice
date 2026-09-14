import { describe, expect, it } from 'vitest';
import { normalizeMarkdownSpacing } from '../mdSpace';

describe('normalizeMarkdownSpacing', () => {
  it('removes spaces between CJK characters', () => {
    expect(normalizeMarkdownSpacing('中文 中文')).toBe('中文中文');
  });

  it('removes a space before CJK punctuation', () => {
    expect(normalizeMarkdownSpacing('中文 ，中文')).toBe('中文，中文');
  });

  it('keeps CJK-Latin spaces and English word spacing', () => {
    expect(normalizeMarkdownSpacing('中 A 文')).toBe('中 A 文');
    expect(normalizeMarkdownSpacing('clinical outcome')).toBe('clinical outcome');
  });

  it('fixes split subscripts like PO 2', () => {
    expect(normalizeMarkdownSpacing('PO 2 A')).toBe('PO2 A');
  });

  it('keeps heading lines untouched', () => {
    expect(normalizeMarkdownSpacing('# 中文 中文')).toBe('# 中文 中文');
  });

  it('keeps list markers, inline code and fenced code', () => {
    expect(normalizeMarkdownSpacing('- 中文 中文')).toBe('- 中文中文');
    expect(normalizeMarkdownSpacing('1. 中文 中文')).toBe('1. 中文中文');
    expect(normalizeMarkdownSpacing('中文 `a  b` 中文')).toBe('中文 `a  b` 中文');
    expect(normalizeMarkdownSpacing('```\na  b\n```')).toBe('```\na  b\n```');
  });

  it('cleans table cells but keeps the pipe layout', () => {
    expect(normalizeMarkdownSpacing('| 中文 中文 | x |')).toBe('| 中文中文 | x |');
  });
});
