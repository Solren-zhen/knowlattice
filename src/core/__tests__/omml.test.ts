// @vitest-environment jsdom
/**
 * OMML（Word 公式）→ LaTeX。
 * mammoth 完全不认 OMML，会把 `m:oMath` 当未知元素静默丢弃——公式就是在这一步永久消失的。
 * 这里钉住常见结构的还原，以及「解析不了时返回空串而不是崩溃」。
 */
import { describe, expect, it } from 'vitest';
import { ommlToLatex } from '../omml';

const r = (t: string) => `<m:r><m:t>${t}</m:t></m:r>`;

describe('ommlToLatex', () => {
  it('分式 → \\frac', () => {
    expect(ommlToLatex(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`)).toBe('\\frac{a}{b}');
  });

  it('上下标与上下标联合', () => {
    expect(ommlToLatex(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`)).toBe('{x}^{2}');
    expect(ommlToLatex(`<m:sSub><m:e>${r('a')}</m:e><m:sub>${r('n')}</m:sub></m:sSub>`)).toBe('{a}_{n}');
    expect(ommlToLatex(`<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`))
      .toBe('{x}_{i}^{2}');
  });

  it('根式 → \\sqrt', () => {
    expect(ommlToLatex(`<m:rad><m:e>${r('x')}</m:e></m:rad>`)).toBe('\\sqrt{x}');
  });

  it('接受 oMath 外壳；多个 run 按顺序拼接', () => {
    expect(ommlToLatex(`<m:oMath>${r('x')}${r('+')}${r('y')}</m:oMath>`)).toBe('x+y');
  });

  it('求和带上下限', () => {
    const x = `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr>`
      + `<m:sub>${r('i')}</m:sub><m:sup>${r('n')}</m:sup><m:e>${r('i')}</m:e></m:nary>`;
    expect(ommlToLatex(x)).toBe('\\sum_{i}^{n} i');
  });

  it('LaTeX 元字符被转义（公式里出现下划线等不破坏语法）', () => {
    expect(ommlToLatex(r('a_b'))).toBe('a\\_b');
  });

  it('解析不了时返回空串，不抛错', () => {
    expect(ommlToLatex('<m:oMath')).toBe('');
  });
});
