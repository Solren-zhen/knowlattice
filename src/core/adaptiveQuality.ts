/**
 * 交互期间的自适应渲染质量。
 *
 * 原做法是「一拖拽就把像素比降到 1」，在 Retina 屏上画面会明显发虚——即使机器完全跑得动。
 * 改为只在确实掉帧时才降：采样最近若干次「真实渲染帧」的间隔，用中位数判断（对偶发的
 * 长帧、GC 停顿不敏感），超过阈值才降分辨率，明显恢复流畅后再升回去（带滞回，避免抖动）。
 * 好机器上永远不会触发，所以不会出现发虚。
 */

/** 帧间隔中位数高于此值（毫秒）→ 降分辨率；约等于低于 38fps */
export const FRAME_MS_DEGRADE = 26;
/** 已降分辨率时，帧间隔中位数低于此值 → 恢复全分辨率；约等于高于 50fps */
export const FRAME_MS_RESTORE = 19;
/** 至少采集这么多帧才做判断，避免刚按下就误降 */
export const MIN_SAMPLES = 10;

/**
 * 根据最近的渲染帧间隔决定下一状态。
 * @param samples 最近的渲染帧间隔（毫秒）
 * @param degraded 当前是否已降分辨率
 */
export function nextDegraded(samples: readonly number[], degraded: boolean): boolean {
  if (samples.length < MIN_SAMPLES) return degraded;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (!degraded && median > FRAME_MS_DEGRADE) return true;
  if (degraded && median < FRAME_MS_RESTORE) return false;
  return degraded; // 处于滞回区间：保持现状
}
