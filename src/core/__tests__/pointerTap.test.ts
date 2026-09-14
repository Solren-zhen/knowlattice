import { describe, expect, it } from 'vitest';
import { PointerTap } from '../pointerTap';

describe('PointerTap', () => {
  it('原地按下抬起算一次点击', () => {
    const t = new PointerTap();
    t.down(1, 100, 100, 5);
    expect(t.up(1, 102, 101)).toBe(true); // 阈值内的小抖动仍算点击
  });

  it('位移超过阈值算拖拽，不算点击', () => {
    const t = new PointerTap();
    t.down(1, 100, 100, 5);
    t.move(1, 140, 100);
    expect(t.up(1, 140, 100)).toBe(false);
  });

  it('抬起时的位置离起点太远也判为拖拽（没吃到 move 事件也不漏判）', () => {
    const t = new PointerTap();
    t.down(1, 100, 100, 5);
    expect(t.up(1, 200, 200)).toBe(false);
  });

  it('双指按下（缩放）不算点击', () => {
    const t = new PointerTap();
    t.down(1, 100, 100, 5);
    t.down(2, 200, 200, 5);
    expect(t.up(2, 200, 200)).toBe(false);
    expect(t.up(1, 100, 100)).toBe(false);
  });

  it('pointercancel 之后不算点击', () => {
    const t = new PointerTap();
    t.down(1, 100, 100, 5);
    t.cancel(1);
    expect(t.up(1, 100, 100)).toBe(false);
  });

  it('取消/多指之后的新手势重新可判为点击', () => {
    const t = new PointerTap();
    t.down(1, 10, 10, 5);
    t.down(2, 20, 20, 5); // 双指 → 被拦
    t.up(1, 10, 10);
    t.up(2, 20, 20);
    t.down(3, 50, 50, 5);
    expect(t.up(3, 50, 50)).toBe(true);
  });

  it('未按下就抬起不算点击', () => {
    const t = new PointerTap();
    expect(t.up(9, 0, 0)).toBe(false);
  });
});
