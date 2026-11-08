/**
 * 颜色与对比度：把「这一对颜色够不够读」变成可计算、可断言的纯函数。
 *
 * 为什么要有：`src/styles/00-foundation.css` 的注释里已经手算过一批比值
 * （「白字压 #6366f1 只有 4.47:1 不达 AA」），但注释不会随改色自动失效报警。
 * 这里提供 WCAG 2.1 的实现，测试拿它去核对真实令牌，改色改到不达标的当场红。
 *
 * 只做计算，不读文件、不碰 DOM：解析 CSS 令牌的活在测试里。
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 支持 #rgb / #rrggbb / rgb() / rgba()；解析失败返回 null（调用方自己决定报错还是跳过）。 */
export function parseColor(input: string): RGB | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
    }
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/.exec(value);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if ([r, g, b].some((n) => n > 255)) return null;
    return { r, g, b };
  }
  return null;
}

/** rgba() 的不透明度；不带 alpha 时返回 1。用于把半透明淡底合成到父色上再算对比度。 */
export function parseAlpha(input: string): number {
  const m = /^rgba\(\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[,/]\s*([0-9.]+)\s*\)$/.exec(input.trim().toLowerCase());
  if (!m) return 1;
  const a = Number(m[1]);
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
}

/** 把半透明前景按 alpha 合成到不透明背景上（CSS 的 source-over 结果）。 */
export function blendOver(fg: RGB, bg: RGB, alpha: number): RGB {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度 */
export function relativeLuminance(color: RGB): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 对比度：1..21，顺序无关。颜色解析失败按 1 处理（最差）。 */
export function contrastRatio(a: string | RGB, b: string | RGB): number {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export interface ContrastRequirement {
  /** 正文（< 18.66px 粗体 / < 24px 常规） */
  normal: number;
  /** 大字 */
  large: number;
}

export const WCAG_AA: ContrastRequirement = { normal: 4.5, large: 3 };
export const WCAG_AAA: ContrastRequirement = { normal: 7, large: 4.5 };

export type ContrastLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

export function contrastLevel(ratio: number, large = false, requirement: ContrastRequirement = WCAG_AA): ContrastLevel {
  if (ratio >= WCAG_AAA.normal) return 'AAA';
  if (ratio >= requirement.normal) return large ? 'AAA' : 'AA';
  if (large && ratio >= requirement.large) return 'AA-large';
  return 'fail';
}
