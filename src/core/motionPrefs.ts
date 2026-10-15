/**
 * 动效开关：JS 驱动的动效必须自己看这两个条件。
 *
 * index.css 里已有 `@media (prefers-reduced-motion: reduce) { * { animation-duration:
 * 0.01ms !important; transition-duration: 0.01ms !important } }` 的全局兜底，但那只管
 * CSS 声明式动画：rAF 循环（卡片倾斜）和 JS 加的类（按压回弹）完全不归它管。
 * 所以凡是 JS 起的动效，先问这里。
 *
 * 另留一个全局急停开关：`<html class="no-motion">` 时一律不动 —— 排查「是不是动效
 * 惹的祸」不用改代码，也不用翻设置页。
 */

const REDUCED = '(prefers-reduced-motion: reduce)';
const FINE_POINTER = '(hover: hover) and (pointer: fine)';

function query(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

/** 用户在系统里开了「减少动态效果」 */
export function prefersReducedMotion(): boolean {
  return query(REDUCED)?.matches === true;
}

/** 有精确定位指针（鼠标 / 触控笔），而不是纯触摸：决定要不要做「跟随指针」类动效 */
export function hasFinePointer(): boolean {
  return query(FINE_POINTER)?.matches === true;
}

function killed(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('no-motion');
}

/** JS 动效总开关：系统减少动态效果 或 急停开关 → 不允许动 */
export function motionAllowed(): boolean {
  return !prefersReducedMotion() && !killed();
}

/**
 * 订阅「是否允许动效」的变化。切换系统设置或加/去 no-motion 类时回调。
 * 返回取消订阅。仍在动的 rAF 循环收到 false 时必须立刻停下并归位。
 */
export function subscribeMotionAllowed(onChange: (allowed: boolean) => void): () => void {
  const list = [query(REDUCED), query(FINE_POINTER)].filter(
    (m): m is MediaQueryList => m !== null,
  );
  const handler = () => onChange(motionAllowed());
  for (const m of list) m.addEventListener('change', handler);
  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(handler);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    for (const m of list) m.removeEventListener('change', handler);
    observer?.disconnect();
  };
}
