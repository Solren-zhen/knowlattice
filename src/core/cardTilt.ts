/**
 * 卡片指针倾斜（第 1 项）：跟随指针的 3D 透视 + 径向流光，松手用弹簧回正。
 *
 * 设计取舍：
 * - 只挂「磁贴级」卡片（当前是 [data-tilt] 标记的 .dash-card / .wb-card）。
 *   文字块与滚动容器（.card c-edit / c-tree / c-insp）不挂：Chromium 对 3D 合成层
 *   按布局尺寸栅格化再放大，正文会发糊，而且点击命中区会跟着位移。
 * - 只认「有精确定位指针」的环境（鼠标/触控笔）。触摸屏上不做：卡片吸收
 *   pointerdown 会抢走滚动，为了一个装饰效果牺牲滚动不值得；tiltAngles() 这个
 *   纯函数已经就位，将来要做「长按倾斜」直接用。
 * - 同一时刻只有一个元素在倾斜（指针只能指一个地方），rAF 随倾斜起、随静止停，
 *   静止时把 [data-tilt-active] 摘掉 —— 静止画面与改动前逐像素一致。
 */
import { SPRING, isResting, lerp, springStep, tiltAngles, type SpringState } from './motion';
import { hasFinePointer, motionAllowed, subscribeMotionAllowed } from './motionPrefs';

/** 挂了倾斜的卡片 */
const SELECTOR = '[data-tilt]';
/** 鼠标下的最大倾角（度）：再大文字就开始发糊，且显得在晃 */
const MAX_TILT = 6;
/** 静止判定：角度与角速度都进了这个带就算停 */
const EPS_DEG = 0.02;
const EPS_DEG_PER_S = 0.6;
/** 流光位置跟随指针的收敛系数（每帧向目标插值多少） */
const SHEEN_FOLLOW = 0.22;

export function initCardTilt(): () => void {
  if (typeof document === 'undefined') return () => {};

  let element: HTMLElement | null = null;
  let rect: DOMRect | null = null;
  let active = false;
  /** 目标角（度）与当前弹簧状态 */
  let targetX = 0;
  let targetY = 0;
  let sx: SpringState = { x: 0, v: 0 };
  let sy: SpringState = { x: 0, v: 0 };
  let mx = 0.5;
  let my = 0.5;
  let tmx = 0.5;
  let tmy = 0.5;
  let raf = 0;
  let lastTs = 0;

  const enabled = () => motionAllowed() && hasFinePointer();

  function measure() {
    rect = element ? element.getBoundingClientRect() : null;
  }

  /** 循环内部续帧：不动时钟（时钟只在从静止起步时重置一次，否则每帧 dt≈0 会把弹簧冻住） */
  function next() {
    raf = requestAnimationFrame(tick);
  }

  /** 从静止起步：重置时钟再进循环 */
  function startLoop() {
    if (raf) return;
    lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function reset() {
    // 立刻归零：不再往回弹（系统刚要求减少动态效果时，弹一下反而是错的）
    if (element) {
      element.removeAttribute('data-tilt-active');
      element.style.removeProperty('--tilt-x');
      element.style.removeProperty('--tilt-y');
      element.style.removeProperty('--mx');
      element.style.removeProperty('--my');
    }
    element = null;
    rect = null;
    active = false;
    targetX = 0;
    targetY = 0;
    sx = { x: 0, v: 0 };
    sy = { x: 0, v: 0 };
    mx = my = tmx = tmy = 0.5;
    stop();
  }

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(Math.max((now - lastTs) / 1000, 0), 1 / 30);
    lastTs = now;
    sx = springStep(sx, targetX, SPRING.settle, dt);
    sy = springStep(sy, targetY, SPRING.settle, dt);
    mx = lerp(mx, tmx, SHEEN_FOLLOW);
    my = lerp(my, tmy, SHEEN_FOLLOW);

    if (element) {
      element.style.setProperty('--tilt-x', `${sx.x.toFixed(3)}deg`);
      element.style.setProperty('--tilt-y', `${sy.x.toFixed(3)}deg`);
      element.style.setProperty('--mx', mx.toFixed(4));
      element.style.setProperty('--my', my.toFixed(4));
    }

    const settled =
      isResting(sx, targetX, EPS_DEG, EPS_DEG_PER_S) &&
      isResting(sy, targetY, EPS_DEG, EPS_DEG_PER_S);

    if (!active && settled) {
      // 回到静止：摘掉标记，让卡片回到「没有 transform」的原始状态
      element?.removeAttribute('data-tilt-active');
      stop();
      return;
    }
    next();
  }

  function deactivate() {
    active = false;
    targetX = 0;
    targetY = 0;
    if (element) startLoop();
  }

  function activate(next: HTMLElement) {
    element = next;
    measure();
    active = true;
    next.setAttribute('data-tilt-active', '');
    startLoop();
  }

  function onPointerMove(e: PointerEvent) {
    if (!enabled()) return;
    const next = (e.target as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
    if (!next) {
      if (element) deactivate();
      return;
    }
    if (next !== element) {
      activate(next);
    } else if (!rect) {
      measure();
    }
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const { rotateX, rotateY, mx: nx, my: ny } = tiltAngles(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
      MAX_TILT,
    );
    targetX = rotateX;
    targetY = rotateY;
    tmx = nx;
    tmy = ny;
    startLoop();
  }

  function onPointerOut(e: PointerEvent) {
    if (!element) return;
    const to = e.relatedTarget as Element | null;
    if (to && element.contains(to)) return;
    deactivate();
  }

  function onBlurOrScroll() {
    if (element) deactivate();
  }

  let unsubscribe: (() => void) | null = null;

  function sync() {
    if (!enabled()) reset();
  }

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerout', onPointerOut, { passive: true });
  window.addEventListener('blur', onBlurOrScroll);
  window.addEventListener('scroll', onBlurOrScroll, { passive: true, capture: true });
  window.addEventListener('resize', onBlurOrScroll, { passive: true });
  unsubscribe = subscribeMotionAllowed(sync);
  if (!enabled()) reset();

  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerout', onPointerOut);
    window.removeEventListener('blur', onBlurOrScroll);
    window.removeEventListener('scroll', onBlurOrScroll, true);
    window.removeEventListener('resize', onBlurOrScroll);
    unsubscribe?.();
    reset();
  };
}
