/**
 * 按压反馈（第 8 项）：按下 0.96 压缩 + 深度内阴影（CSS 的 :active 负责），
 * 释放时的轻微超调回弹（这一段 CSS 给不出来，必须由 JS 加一个一次性动画类）。
 *
 * 为什么是「委托 + 一个类」而不是给每个按钮写 hook：
 * - 全仓按钮角色有 8 类（.btn / .btn-small / .btn-icon / .btn-primary / .rate /
 *   .opt / .rail-btn / .toolbar-search），逐个改组件既吵又容易漏；
 * - 委托在 document 上挂在捕获阶段，子元素 stopPropagation 也拦不住（列表行里有
 *   「点错因不打开笔记」这类拦截，不能依赖冒泡）；
 * - 只加一个类，弹不弹、弹多快仍然全在 CSS 里，改手感不用碰 JS。
 *
 * 拖拽不算按压：复用 core/pointerTap.ts（位移超过 4px、多指、pointercancel
 * 都不算一次点击）——否则在列表里拖一下松手，按钮会莫名弹一下。
 */
import { PointerTap } from './pointerTap';
import { motionAllowed } from './motionPrefs';

/** 参与按压回弹的按钮角色。.tree-row / .backlink-item 这类行不参与（它们不是按钮）。 */
export const PRESS_SELECTOR = [
  '.btn',
  '.btn-small',
  '.btn-icon',
  '.btn-primary',
  '.rate',
  '.opt',
  '.rail-btn',
  '.toolbar-search',
].join(', ');

/** 位移超过这个距离就算拖拽，不算按压（px） */
const TAP_SLOP = 4;
/** 动画兜底时长：animationend 没来（被打断/元素被卸载）也要把类摘掉 */
const REBOUND_MS = 400;

export function initPressFeedback(): () => void {
  if (typeof document === 'undefined') return () => {};
  const tap = new PointerTap();
  const timers = new Set<number>();
  let pressed: HTMLElement | null = null;

  const isDisabled = (el: HTMLElement) =>
    el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

  function release(el: HTMLElement) {
    el.classList.remove('press-released');
    // 读一次布局，确保连续快速点击时动画能重放（同一个类名连加不会重启动画）
    void el.offsetWidth;
    el.classList.add('press-released');
    const done = () => {
      el.classList.remove('press-released');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
    const id = window.setTimeout(() => {
      timers.delete(id);
      done();
    }, REBOUND_MS);
    timers.add(id);
  }

  function onDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = (e.target as Element | null)?.closest?.(PRESS_SELECTOR) as HTMLElement | null;
    if (!el || isDisabled(el)) return;
    if (!motionAllowed()) {
      // 允许动效以外的情况：不进回弹逻辑（按下态仍由 CSS :active 负责）
      return;
    }
    // 上一次的回弹还没放完就再按：先摘掉，别让动画盖住 :active
    el.classList.remove('press-released');
    pressed = el;
    tap.down(e.pointerId, e.clientX, e.clientY, TAP_SLOP);
  }

  function onUp(e: PointerEvent) {
    const el = pressed;
    pressed = null;
    if (!el) return;
    const isTap = tap.up(e.pointerId, e.clientX, e.clientY);
    if (!isTap || !motionAllowed() || !el.isConnected) return;
    release(el);
  }

  function onCancel(e: PointerEvent) {
    pressed = null;
    tap.cancel(e.pointerId);
  }

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);

  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
  };
}
