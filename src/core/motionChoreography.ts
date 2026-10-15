/**
 * 动效编排（纯函数 + DOM 单例）：视口错峰显现 + 主按钮磁吸。
 *
 * 与 core/motion.ts 的分工：那边是「怎么动」（弹簧、吸附、倾斜的纯数学），
 * 这里是「什么时候动、动哪个元素」——把编排策略收口成两个可断言的小模块。
 *
 * 为什么不用 scroll 监听：scroll 每帧触发、强制读布局，长列表会掉帧；
 * IntersectionObserver 由浏览器在合成线程算，只在真进入视口时回调一次。
 * 为什么不引动画库：仓库既有约定是「纯函数 + 单测」，参数可断言、回归一条命令，
 * 见 motion.ts 开头。这里沿用同一形态。
 *
 * 两条硬约束（与 viewMorph/motionPrefs 一致）：
 * - 只在允许动效时工作（系统「减少动态效果」、html.no-motion 直接让位）；
 * - 内容绝不被永久藏起来——JS 没跑、IO 不触发、观察漏网时都有安全网把内容显现。
 */

import { SPRING, isResting, springStep, clamp, type SpringState } from './motion';
import { hasFinePointer, motionAllowed, subscribeMotionAllowed } from './motionPrefs';

/** 错峰延迟封顶：第 12 项之后再等下去，用户已经读到内容了，延迟只会变成卡顿感 */
export const STAGGER_CAP = 12;

/** 显现序号：把 DOM 中的第 index 项夹到 [0, STAGGER_CAP]（纯函数，可单测） */
export function revealIndex(index: number, cap = STAGGER_CAP): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), Math.max(0, Math.floor(cap)));
}

/**
 * 磁吸位移：元素中心 (cx,cy)、指针 (px,py)，朝指针方向偏移 k 倍并夹到 ±max。
 * 纯函数——给同样的输入永远同样的输出，回归可断言。
 */
export function magnetOffset(
  cx: number,
  cy: number,
  px: number,
  py: number,
  max: number,
  strength = 0.12,
): { x: number; y: number } {
  return {
    x: clamp((px - cx) * strength, -max, max),
    y: clamp((py - cy) * strength, -max, max),
  };
}

/** 磁吸最大位移（px）：再大就不像「吸」而像「漂」 */
const MAGNET_MAX = 5;
/** 与 core/cardTilt.ts 同一套静止判定，避免两个单例手感不一致 */
const EPS_X = 0.05;
const EPS_V = 0.5;

/**
 * 视口显现：进入视口的 [data-reveal] 元素挂上 .is-revealed（由 CSS 完成过渡）。
 * 容器 [data-stagger] 的直接子元素按 DOM 顺序分配 --reveal-i，实现错峰。
 * 返回卸载函数。
 */
export function initReveal(): () => void {
  if (typeof document === 'undefined') return () => {};
  const supported = typeof IntersectionObserver === 'function';
  const observed = new WeakSet<Element>();
  let io: IntersectionObserver | null = null;

  if (supported) {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          if (target instanceof HTMLElement) target.classList.add('is-revealed');
          io?.unobserve(target);
        }
      },
      // 底部留 8% 余量：元素刚探进来一点就开始，而不是等完全进入才动
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
  }

  function revealAll(root: ParentNode) {
    for (const el of Array.from(root.querySelectorAll('[data-reveal]'))) {
      if (el instanceof HTMLElement) el.classList.add('is-revealed');
    }
    if (root instanceof HTMLElement && root.hasAttribute('data-reveal')) {
      root.classList.add('is-revealed');
    }
  }

  /** 给错峰容器里的显现项编序号（已有 --reveal-i 的不覆盖，避免重复扫描时跳变） */
  function indexGroups(root: ParentNode) {
    const groups = Array.from(root.querySelectorAll('[data-stagger]'));
    if (root instanceof Element && root.hasAttribute('data-stagger')) groups.push(root);
    for (const group of groups) {
      if (!(group instanceof HTMLElement)) continue;
      let i = 0;
      for (const child of Array.from(group.children)) {
        if (!(child instanceof HTMLElement) || !child.hasAttribute('data-reveal')) continue;
        if (!child.style.getPropertyValue('--reveal-i')) {
          child.style.setProperty('--reveal-i', String(revealIndex(i)));
        }
        i += 1;
      }
    }
  }

  function register(root: ParentNode) {
    if (!motionAllowed()) {
      revealAll(root);
      return;
    }
    indexGroups(root);
    // root 自身也可能就是显现项（MutationObserver 传进来的新增节点）：
    // querySelectorAll 不包含自身，这里补上，否则单个 [data-reveal] 节点会被漏掉。
    const list = Array.from(root.querySelectorAll('[data-reveal]'));
    if (root instanceof Element && root.hasAttribute('data-reveal')) list.push(root);
    for (const el of list) {
      if (!(el instanceof HTMLElement) || observed.has(el)) continue;
      observed.add(el);
      if (!supported || !io) el.classList.add('is-revealed');
      else io.observe(el);
    }
  }

  register(document);

  const mo =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver((records) => {
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (node instanceof HTMLElement) register(node);
            }
          }
        })
      : null;
  mo?.observe(document.body, { childList: true, subtree: true });

  // 安全网：允许动效却迟迟没触发（IO 被裁剪、屏障元素等）时，1.6s 后全部显现。
  const safety = window.setTimeout(() => revealAll(document), 1600);

  const unsubscribe = subscribeMotionAllowed((allowed) => {
    if (!allowed) revealAll(document);
    else register(document);
  });

  return () => {
    io?.disconnect();
    mo?.disconnect();
    window.clearTimeout(safety);
    unsubscribe();
  };
}

/**
 * 磁吸：指针靠近 [data-magnet] 元素时，元素朝指针方向轻轻偏移几像素，
 * 离开时用同一弹簧回正。与 core/cardTilt.ts 同构（同一时刻只有一个元素、rAF 随动随停、
 * 静止时不写任何内联变量），但只动 translate，不碰 3D。
 */
export function initMagnet(): () => void {
  if (typeof document === 'undefined') return () => {};

  let element: HTMLElement | null = null;
  let rect: DOMRect | null = null;
  let targetX = 0;
  let targetY = 0;
  let sx: SpringState = { x: 0, v: 0 };
  let sy: SpringState = { x: 0, v: 0 };
  let raf = 0;
  let lastTs = 0;

  const enabled = () => motionAllowed() && hasFinePointer();

  function measure() {
    rect = element ? element.getBoundingClientRect() : null;
  }

  function clearVars() {
    element?.style.removeProperty('--mag-x');
    element?.style.removeProperty('--mag-y');
  }

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(Math.max((now - lastTs) / 1000, 0), 1 / 30);
    lastTs = now;
    sx = springStep(sx, targetX, SPRING.settle, dt);
    sy = springStep(sy, targetY, SPRING.settle, dt);
    if (element) {
      element.style.setProperty('--mag-x', `${sx.x.toFixed(2)}px`);
      element.style.setProperty('--mag-y', `${sy.x.toFixed(2)}px`);
    }
    if (targetX === 0 && targetY === 0 && isResting(sx, 0, EPS_X, EPS_V) && isResting(sy, 0, EPS_X, EPS_V)) {
      clearVars();
      element = null;
      rect = null;
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf) return;
    lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function reset() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearVars();
    element = null;
    rect = null;
    targetX = 0;
    targetY = 0;
    sx = { x: 0, v: 0 };
    sy = { x: 0, v: 0 };
  }

  function onPointerMove(e: PointerEvent) {
    if (!enabled()) return;
    const next = (e.target as Element | null)?.closest?.('[data-magnet]') as HTMLElement | null;
    if (!next) {
      if (element) {
        targetX = 0;
        targetY = 0;
        start();
      }
      return;
    }
    if (next !== element) {
      element = next;
      measure();
      sx = { x: 0, v: 0 };
      sy = { x: 0, v: 0 };
    } else if (!rect) {
      measure();
    }
    if (!rect) return;
    const offset = magnetOffset(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      e.clientX,
      e.clientY,
      MAGNET_MAX,
    );
    targetX = offset.x;
    targetY = offset.y;
    start();
  }

  function onPointerOut(e: PointerEvent) {
    if (!element) return;
    const to = e.relatedTarget as Element | null;
    if (to && element.contains(to)) return;
    targetX = 0;
    targetY = 0;
    start();
  }

  function onInterrupt() {
    if (element) {
      targetX = 0;
      targetY = 0;
      start();
    }
  }

  let unsubscribe: (() => void) | null = null;

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerout', onPointerOut, { passive: true });
  window.addEventListener('blur', onInterrupt);
  window.addEventListener('scroll', onInterrupt, { passive: true, capture: true });
  unsubscribe = subscribeMotionAllowed((allowed) => {
    if (!allowed) reset();
  });
  if (!enabled()) reset();

  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerout', onPointerOut);
    window.removeEventListener('blur', onInterrupt);
    window.removeEventListener('scroll', onInterrupt, true);
    unsubscribe?.();
    reset();
  };
}

/**
 * 总入口：允许动效时挂上 html.motion-ready（CSS 据此进入隐藏初态），
 * 再装两个单例。返回一次性卸载。
 */
export function initMotionChoreography(): () => void {
  if (typeof document === 'undefined') return () => {};
  document.documentElement.classList.toggle('motion-ready', motionAllowed());
  const stopReveal = initReveal();
  const stopMagnet = initMagnet();
  return () => {
    stopReveal();
    stopMagnet();
  };
}
