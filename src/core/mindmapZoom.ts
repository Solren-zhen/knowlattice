/**
 * 思维导图画布的缩放口径（纯函数，不碰 DOM）。
 *
 * 为什么单独成模块：滚轮位移 → 缩放倍数这段换算要能单测（jsdom 没布局引擎，量不了 transform
 * 矩阵）；而库自己的 `scale()` **不夹上下限**（dist 里就是 `this.scaleVal = e`），
 * 夹边界必须由我们保证，否则滚轮能一路缩到 0.01 或 40 倍。
 */

/** 缩放范围：与 init 时传给库的 scaleMin / scaleMax 用同一对常量 */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;

/** 每次点 ± 的倍率（1.25 ≈ 五档到一倍，手感接近常见导图 App） */
export const ZOOM_STEP = 1.25;

/**
 * 滚轮灵敏度：一格鼠标滚轮 deltaY ≈ 100px，exp(-100/800) ≈ 0.88，即一格约 12% 的缩放变化。
 *
 * 为什么用**指数**映射，而不是「每格跳一档」或线性累加：
 *   - 触控板每帧只给几个像素的 delta，指数映射会平滑累积，不会一顿一顿；
 *   - 放大再缩回原处得到的就是原倍数（线性累加会漂移）；
 *   - 不按格扣分，浏览器之间 deltaY 的绝对大小差异也不会放大成手感差异。
 */
export const WHEEL_ZOOM_BASE = 800;

/** 滚轮「行」的像素当量：与库一致（dist 里 DOM_DELTA_LINE 按 40px 折算） */
const LINE_PX = 40;

/**
 * 把滚轮位移归一到像素。deltaMode：0 = 像素、1 = 行、2 = 页。
 * 不归一就会出现「同样滚一格，有的跳 12% 有的跳 300%」——不同设备/浏览器给的单位不一样。
 */
export function wheelDeltaPx(e: { deltaY: number; deltaMode: number; viewportHeight: number }): number {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * e.viewportHeight;
  return e.deltaY;
}

/** 滚轮位移 → 缩放因子（<1 缩小、>1 放大；向上滚 deltaY < 0 → 放大，符合直觉） */
export function wheelZoomFactor(e: { deltaY: number; deltaMode: number; viewportHeight: number }): number {
  return Math.exp(-wheelDeltaPx(e) / WHEEL_ZOOM_BASE);
}

/** 夹到 ZOOM_MIN / ZOOM_MAX：库不夹，所以所有改倍数的地方（按钮 / 滚轮 / 适应）都要过这一道 */
export function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}
