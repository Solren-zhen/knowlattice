import { describe, expect, it } from 'vitest';
import { anydocErrorCode } from '../anydoc';

describe('anydocErrorCode', () => {
  it('读取字符串 code', () => {
    expect(anydocErrorCode({ code: 'needsOcr' })).toBe('needsOcr');
    expect(anydocErrorCode(Object.assign(new Error('x'), { code: 'malformed' }))).toBe('malformed');
  });

  it('无 code 或非字符串 code 返回 null', () => {
    expect(anydocErrorCode(new Error('x'))).toBeNull();
    expect(anydocErrorCode(null)).toBeNull();
    expect(anydocErrorCode(undefined)).toBeNull();
    expect(anydocErrorCode('needsOcr')).toBeNull();
    expect(anydocErrorCode({ code: 42 })).toBeNull();
    expect(anydocErrorCode({ code: null })).toBeNull();
  });
});
