/**
 * 指针跟光（v4）：指针在列表行 / 卡片上移动时，一块柔光跟着指针走，
 * 让「指针在哪、这一行的可点范围到哪」一眼可见。
 *
 * 与 core/cardTilt.ts 的分工：那边给磁贴卡片做 3D 倾斜 + 流光（动 transform，
 * 文字会被 3D 合成层栅格化放糊），所以只挂 .dash-card / .wb-card；
 * 这里是**不做位移**的平面柔光，只写两个自定义属性、由 CSS 画 radial-gradient，
 * 因此可以安全地铺到任意多行（列表行、搜索命中、待办项）而不伤文字。
 *
 * 为什么用 background-image 而不是伪元素：这些行已经用了 ::before
 * （.tree-row.active 的竖条、.dash-card 的描边环），再抢一个伪元素会和既有装饰打架；
 * background-image 与既有的 background-color 分层共存、互不覆盖，
 * 也不需要给行加 position:relative。
 *
 * 开销控制：同一时刻只有一个元素在发光（指针只能指一个地方），矩形在「换元素」时
 * 测一次并缓存，之后只写属性、不再读布局；离开 / 滚动 / 失焦即清空内联属性，
 * 静止画面与改动前逐像素一致。开关口径与 cardTilt 完全一致：
 * 精确定位指针（鼠标 / 触控笔）+ 允许动效。
 */

import { clamp } from './motion';
import { hasFinePointer, motionAllowed, subscribeMotionAllowed } from './motionPrefs';

/** 参与跟光的表面。用选择器而不是逐个组件打标记：新增列表行不用记得加属性。 */
export const GLOW_SELECTOR = '[data-glow], .qs-item, .tree-row, .todo-item, .todo-side__item';

/** 正在发光的标记（CSS 据此才画柔光，避免给静态元素常驻一层 gradient） */
export const GLOW_ATTR = 'data-glow-on';

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 指针在元素内的局部坐标（px），越界夹到边界内。
 * 纯函数——同样输入永远同样输出，回归可断言。
 */
export function glowPoint(rect: RectLike, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: clamp(clientX - rect.left, 0, Math.max(0, rect.width)),
    y: clamp(clientY - rect.top, 0, Math.max(0, rect.height)),
  };
}

export function initHoverGlow(): () => void {
  if (typeof document === 'undefined') return () => {};

  let current: HTMLElement | null = null;
  let rect: DOMRect | null = null;

  const enabled = () => motionAllowed() && hasFinePointer();

  function clear(el: HTMLElement | null) {
    if (!el) return;
    el.removeAttribute(GLOW_ATTR);
    el.style.removeProperty('--glow-x');
    el.style.removeProperty('--glow-y');
  }

  function drop() {
    clear(current);
    current = null;
    rect = null;
  }

  function onMove(e: PointerEvent) {
    if (!enabled()) return;
    const next = (e.target as Element | null)?.closest?.(GLOW_SELECTOR) as HTMLElement | null;
    if (!next) {
      drop();
      return;
    }
    if (next !== current) {
      clear(current);
      current = next;
      rect = next.getBoundingClientRect();
      next.setAttribute(GLOW_ATTR, '');
    } else if (!rect) {
      rect = next.getBoundingClientRect();
    }
    if (!rect) return;
    const p = glowPoint(rect, e.clientX, e.clientY);
    next.style.setProperty('--glow-x', `${p.x.toFixed(1)}px`);
    next.style.setProperty('--glow-y', `${p.y.toFixed(1)}px`);
  }

  function onOut(e: PointerEvent) {
    if (!current) return;
    const to = e.relatedTarget as Element | null;
    if (to && current.contains(to)) return;
    drop();
  }

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  // 缓存矩形在滚动 / 缩放后失效：宁可这一帧不亮，也不要让流光停在错误的位置
  window.addEventListener('blur', drop);
  window.addEventListener('scroll', drop, { passive: true, capture: true });
  window.addEventListener('resize', drop, { passive: true });
  const unsubscribe = subscribeMotionAllowed((allowed) => {
    if (!allowed) drop();
  });
  if (!enabled()) drop();

  return () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerout', onOut);
    window.removeEventListener('blur', drop);
    window.removeEventListener('scroll', drop, true);
    window.removeEventListener('resize', drop);
    unsubscribe();
    drop();
  };
}
