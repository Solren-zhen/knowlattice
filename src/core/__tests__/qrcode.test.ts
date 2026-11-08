import { describe, expect, it } from 'vitest';
import { encodeQr, qrPathData } from '../qrcode';

/** B 站扫码登录链接，正好 131 个字符 */
const BILI_URL =
  'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=e1f5d1327d43be38fb4d1232998551a6&from=';

/** 7x7 定位图案：外环深色、内环浅色、中心 3x3 深色 */
function hasFinderPattern(matrix: boolean[][], left: number, top: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (matrix[top + y][left + x] !== (dist !== 2)) return false;
    }
  }
  return true;
}

describe('encodeQr', () => {
  it('131 字符的 B 站登录链接落在 version 8（49x49）', () => {
    expect(BILI_URL.length).toBe(131);
    const matrix = encodeQr(BILI_URL);
    // size = 4 * version + 17，version 8 即 4 * 8 + 17 = 49
    expect(matrix.length).toBe(49);
    expect(matrix.every((row) => row.length === 49)).toBe(true);
    expect(matrix.some((row) => row.some(Boolean))).toBe(true);
  });

  it('左上、右上、左下三个角有 7x7 定位图案', () => {
    const matrix = encodeQr(BILI_URL);
    const size = matrix.length;
    expect(hasFinderPattern(matrix, 0, 0)).toBe(true);
    expect(hasFinderPattern(matrix, size - 7, 0)).toBe(true);
    expect(hasFinderPattern(matrix, 0, size - 7)).toBe(true);
  });

  it('定位图案与数据区之间有浅色分隔符', () => {
    const matrix = encodeQr(BILI_URL);
    // 左上角：第 7 行/列的前 8 格应为浅色
    expect(matrix[7].slice(0, 8).every((cell) => !cell)).toBe(true);
    expect(matrix.slice(0, 8).map((row) => row[7]).every((cell) => !cell)).toBe(true);
  });

  it('短文本用 version 1（21x21），超出一个字符就升版本', () => {
    expect(encodeQr('a'.repeat(14)).length).toBe(21);
    expect(encodeQr('a'.repeat(15)).length).toBe(25);
  });

  it('中文按 UTF-8 字节数选择版本', () => {
    // 4 个汉字 = 12 字节，放得进 v1；5 个汉字 = 15 字节，需要 v2
    expect(encodeQr('知识晶格').length).toBe(21);
    expect(encodeQr('知识晶格啊').length).toBe(25);
  });

  it('文本过长时抛错', () => {
    expect(() => encodeQr('a'.repeat(214))).toThrow('text too long for QR version 1-10');
    expect(() => encodeQr('a'.repeat(1000))).toThrow('text too long for QR version 1-10');
  });
});

describe('qrPathData', () => {
  it('输出以 M 开头的矩形路径，且不含空段', () => {
    const matrix = encodeQr(BILI_URL);
    const path = qrPathData(matrix);
    expect(path.startsWith('M')).toBe(true);
    expect(path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    expect(path).not.toMatch(/NaN|undefined|M\s/);
  });

  it('空矩阵得到空字符串', () => {
    expect(qrPathData([])).toBe('');
  });
});
