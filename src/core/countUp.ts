/**
 * 数字滚动（count-up）：统计数字从 0 滚到目标值的动效。
 *
 * 只改 textContent，不改样式；`.dash-value` 已经是 tabular-nums（等宽数字），
 * 所以滚动过程中位宽稳定、不会有抖动。目标值与模板都来自 data 属性：
 *   data-count-to="1,13"  data-count-tpl="{0}/{1}"
 * 一串里的多个数字用同一进度 t 一起插值，像「1/13」这样的比值也能同步滚。
 *
 * 触发用 IntersectionObserver（不用 scroll 监听），每个元素只滚一次；
 * 系统要求减少动态效果时直接落到终值。
 */

import { motionAllowed, subscribeMotionAllowed } from './motionPrefs';

const DURATION = 720;
/** 误差带内即视为完成，避免最后一帧反复 setTextContent */
const FINISH = 0.999;

/** easeOutCubic：起步快、收尾稳，数字停下来的那一下更「实」 */
export function countEase(p: number): number {
  const t = Math.min(Math.max(p, 0), 1);
  return 1 - Math.pow(1 - t, 3);
}

/**
 * 按进度 p∈[0,1] 生成文案：values[i] 从 0 线性滚到自身，tpl 里的 {i} 被替换。
 * 纯函数——同样的输入永远同样的输出，可直接单测。
 */
export function interpolateCount(
  values: readonly number[],
  tpl: string,
  p: number,
): string {
  const t = countEase(p);
  return tpl.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const v = values[Number(index)] ?? 0;
    return String(Math.round(v * t));
  });
}

function readSpec(el: HTMLElement): { values: number[]; tpl: string } | null {
  const raw = el.dataset.countTo;
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return { values, tpl: el.dataset.countTpl || '{0}' };
}

export function initCountUp(): () => void {
  if (typeof document === 'undefined') return () => {};

  const done = new WeakSet<Element>();
  const running = new Set<number>();
  let io: IntersectionObserver | null = null;

  function flash(el: HTMLElement, spec: { values: number[]; tpl: string }) {
    if (done.has(el)) return;
    done.add(el);
    if (!motionAllowed()) {
      el.textContent = interpolateCount(spec.values, spec.tpl, 1);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - start) / DURATION, 1);
      el.textContent = interpolateCount(spec.values, spec.tpl, p);
      if (p < FINISH) {
        const id = requestAnimationFrame(step);
        running.add(id);
      } else {
        el.textContent = interpolateCount(spec.values, spec.tpl, 1);
      }
    };
    running.add(requestAnimationFrame(step));
  }

  function start(el: HTMLElement) {
    const spec = readSpec(el);
    if (spec) flash(el, spec);
  }

  function register(root: ParentNode) {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-count-to]'))) {
      if (done.has(node)) continue;
      if (!io) {
        start(node);
        continue;
      }
      io.observe(node);
    }
  }

  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          io?.unobserve(el);
          start(el);
        }
      },
      { threshold: 0.3 },
    );
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

  const unsubscribe = subscribeMotionAllowed((allowed) => {
    // 切换到「减少动态效果」时，把还在滚的数字一次性结清
    if (!allowed) {
      for (const id of running) cancelAnimationFrame(id);
      running.clear();
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-count-to]'))) {
        const spec = readSpec(node);
        if (spec) node.textContent = interpolateCount(spec.values, spec.tpl, 1);
        done.add(node);
      }
    }
  });

  return () => {
    for (const id of running) cancelAnimationFrame(id);
    running.clear();
    io?.disconnect();
    mo?.disconnect();
    unsubscribe();
  };
}
