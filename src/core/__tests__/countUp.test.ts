import { describe, expect, it } from 'vitest';
import { countEase, interpolateCount } from '../countUp';

describe('countEase', () => {
  it('端点固定 0 / 1', () => {
    expect(countEase(0)).toBe(0);
    expect(countEase(1)).toBe(1);
  });

  it('中段快于线性（缓出）', () => {
    expect(countEase(0.5)).toBeGreaterThan(0.5);
  });

  it('越界被夹在 [0,1]', () => {
    expect(countEase(-2)).toBe(0);
    expect(countEase(5)).toBe(1);
  });
});

describe('interpolateCount', () => {
  it('p=0 全为 0，p=1 落到目标', () => {
    expect(interpolateCount([12], '{0} 张', 0)).toBe('0 张');
    expect(interpolateCount([12], '{0} 张', 1)).toBe('12 张');
  });

  it('多个数字用同一进度一起插值（比值同步滚）', () => {
    expect(interpolateCount([1, 13], '{0}/{1}', 1)).toBe('1/13');
    // countEase(0.5) = 0.875 → 10 × 0.875 = 8.75 → 9
    expect(interpolateCount([10, 10], '{0}/{1}', 0.5)).toBe('9/9');
  });

  it('模板里越界的占位符按 0 处理', () => {
    expect(interpolateCount([5], '{0}/{1}', 1)).toBe('5/0');
  });

  it('没有占位符时原样返回模板', () => {
    expect(interpolateCount([5], '共 {0} 题', 1)).toBe('共 5 题');
  });
});
