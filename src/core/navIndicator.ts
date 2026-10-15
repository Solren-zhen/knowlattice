/**
 * 导航轨「墨迹」指示器：一枚共享元素在 .rail-scroll 内跟随当前激活按钮滑动。
 *
 * 为什么值得单独做：左侧竖条原本是**每个按钮各画一条**（.rail-btn.on::before），
 * 切换时是「旧的消失、新的出现」；改成共享元素后，切换变成「同一条滑过去」——
 * 这正是高级控件里最容易被感知的细节（magic ink）。挂上 html.nav-ink 后隐藏
 * 各按钮自己的竖条，避免两条同时出现。
 *
 * 与 core/cardTilt.ts 同构：同一时刻只有一个元素、rAF 随动随停、静止时不写内联值。
 * 位置用 offsetTop/offsetLeft（相对 .rail-scroll，样式里已给它 position:relative），
 * 因此容器滚动、窗口缩放都不需要额外换算——指示器是滚动内容的一部分，跟着滚。
 *
 * 角标（居中的图标/展开态的行）位置会因 .rail--expanded 与文字标签而变，
 * 所以对 .rail 与 .rail-scroll 的 class 变化都做重测。
 */

import { SPRING, isResting, springStep, type SpringState } from './motion';
import { motionAllowed, subscribeMotionAllowed } from './motionPrefs';

const CONTAINER = '.rail-scroll';
/**
 * 用 aria-current="page" 而不是 .on 定位激活项：目录按钮用 .on 表示「章节树展开」，
 * 与「当前页面」是两回事，同一个 .on 会同时出现在两个按钮上——按 .on 取会绑错。
 * 优先取页面项；页面项不存在（欢迎页）时退回 .on 的目录按钮，免得那条竖条彻底消失。
 */
const ACTIVE_PAGE = '.rail-btn[aria-current="page"]';
const ACTIVE_FALLBACK = '.rail-btn.on';

export function initNavIndicator(): () => void {
  if (typeof document === 'undefined') return () => {};

  let container: HTMLElement | null = null;
  let indicator: HTMLElement | null = null;
  let activeEl: HTMLElement | null = null;
  let targetY = 0;
  let state: SpringState = { x: 0, v: 0 };
  let raf = 0;
  let lastTs = 0;
  let mo: MutationObserver | null = null;
  let ro: ResizeObserver | null = null;
  let waitMo: MutationObserver | null = null;
  let unsubscribe: (() => void) | null = null;

  function apply(y: number) {
    if (indicator) indicator.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
  }

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(Math.max((now - lastTs) / 1000, 0), 1 / 30);
    lastTs = now;
    state = springStep(state, targetY, SPRING.settle, dt);
    apply(state.x);
    if (isResting(state, targetY, 0.1, 1)) {
      apply(targetY);
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!motionAllowed()) {
      // 减少动态效果：直接落位，不做滑动
      state = { x: targetY, v: 0 };
      apply(targetY);
      return;
    }
    if (raf) return;
    lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  /**
   * 重测位置。关键约束：class 只在「激活项换了」时才写。
   * 指示器就在被观察的 subtree 里，若每次 measure 都写一次 class，会被自己的
   * MutationObserver 再次触发 —— 变成 measure ↔ observer 的死循环（实测直接 OOM）。
   */
  function measure() {
    if (!container || !indicator) return;
    const active =
      container.querySelector<HTMLElement>(ACTIVE_PAGE) ??
      container.querySelector<HTMLElement>(ACTIVE_FALLBACK);
    if (active !== activeEl) {
      activeEl = active;
      indicator.classList.toggle('on', !!active);
    }
    if (!active) return;
    const h = indicator.offsetHeight || 20;
    targetY = active.offsetTop + (active.offsetHeight - h) / 2;
    start();
  }

  /** 合并触发的重测（class 可能在一次批处理里改多处） */
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      measure();
    });
  }

  function attach(railScroll: HTMLElement) {
    container = railScroll;
    indicator?.remove();
    activeEl = null;
    indicator = document.createElement('span');
    indicator.className = 'rail-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    // prepend：留在滚动内容里，随 .rail-scroll 一起滚
    railScroll.prepend(indicator);
    document.documentElement.classList.add('nav-ink');

    mo?.disconnect();
    mo = new MutationObserver((records) => {
      // 忽略指示器自身的 class 变化，只对别处的 class 变化重测
      for (const record of records) {
        if (record.target !== indicator) {
          schedule();
          break;
        }
      }
    });
    mo.observe(railScroll, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const rail = railScroll.closest('.rail');
    if (rail) mo.observe(rail, { attributes: true, attributeFilter: ['class'] });

    if (typeof ResizeObserver === 'function') {
      ro?.disconnect();
      ro = new ResizeObserver(() => schedule());
      ro.observe(railScroll);
    }

    measure();
    // 首帧字形/图标加载会改变行高，落定后再测一次
    requestAnimationFrame(() => measure());
  }

  function find(): boolean {
    const railScroll = document.querySelector<HTMLElement>(CONTAINER);
    if (railScroll && railScroll.querySelector('.rail-btn')) {
      attach(railScroll);
      return true;
    }
    return false;
  }

  if (!find()) {
    // 首屏 React 还没渲染：等导条出现再挂，挂上即断开等待观察者
    waitMo = new MutationObserver(() => {
      if (find()) {
        waitMo?.disconnect();
        waitMo = null;
      }
    });
    waitMo.observe(document.body, { childList: true, subtree: true });
  }

  unsubscribe = subscribeMotionAllowed((allowed) => {
    if (!allowed) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      state = { x: targetY, v: 0 };
      apply(targetY);
    } else {
      start();
    }
  });

  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    mo?.disconnect();
    ro?.disconnect();
    waitMo?.disconnect();
    unsubscribe?.();
    indicator?.remove();
    indicator = null;
    container = null;
    document.documentElement.classList.remove('nav-ink');
  };
}
