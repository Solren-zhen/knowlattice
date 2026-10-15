/**
 * 滚轮 → 缩放倍数的换算（纯函数）。守三件事：
 *   ① 三种 deltaMode 都归一到像素——设备/浏览器给的单位不同，不归一就会「同样滚一格跳得不一样」；
 *   ② 方向符合直觉（向上滚放大），且是指数映射（放大再缩回原处得到原倍数，不漂移）；
 *   ③ 上下限只认 ZOOM_MIN / ZOOM_MAX——库的 `scale()` 自己不夹，夹漏了就能缩到 0.01 倍。
 */
import { describe, expect, it } from 'vitest';
import { WHEEL_ZOOM_BASE, ZOOM_MAX, ZOOM_MIN, clampZoom, wheelDeltaPx, wheelZoomFactor } from '../mindmapZoom';

/** 像素模式（最常见）：deltaMode 0 */
const px = (deltaY: number) => ({ deltaY, deltaMode: 0, viewportHeight: 800 });

describe('滚轮缩放换算', () => {
  it('deltaMode 归一：像素原样、行 ×40、页 ×视口高', () => {
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 0, viewportHeight: 800 })).toBe(3);
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1, viewportHeight: 800 })).toBe(120);
    expect(wheelDeltaPx({ deltaY: 2, deltaMode: 2, viewportHeight: 800 })).toBe(1600);
  });

  it('方向：向上滚放大、向下滚缩小、deltaY=0 不动', () => {
    expect(wheelZoomFactor(px(-100))).toBeGreaterThan(1);
    expect(wheelZoomFactor(px(100))).toBeLessThan(1);
    expect(wheelZoomFactor(px(0))).toBe(1);
  });

  it('一格（deltaY=100）约 12%，小 delta 只走一小步（触控板也平滑）', () => {
    expect(wheelZoomFactor(px(100))).toBeCloseTo(Math.exp(-100 / WHEEL_ZOOM_BASE), 6);
    expect(1 - wheelZoomFactor(px(100))).toBeGreaterThan(0.1);
    expect(1 - wheelZoomFactor(px(100))).toBeLessThan(0.15);
    // 4px 的触控板微动 → 0.5%：这才叫平滑，而不是「每来一个事件就跳一档」
    expect(wheelZoomFactor(px(4))).toBeCloseTo(0.995, 3);
  });

  it('指数映射无漂移：放大再缩回原处得到原倍数', () => {
    expect(wheelZoomFactor(px(100)) * wheelZoomFactor(px(-100))).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(px(37)) * wheelZoomFactor(px(-37))).toBeCloseTo(1, 12);
  });

  it('上下限：clampZoom 夹在 0.3~3，极端 delta 也越不过去', () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(wheelZoomFactor(px(1e6)))).toBe(ZOOM_MIN);
    expect(clampZoom(wheelZoomFactor(px(-1e6)))).toBe(ZOOM_MAX);
  });
});
