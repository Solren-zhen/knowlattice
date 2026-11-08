/**
 * 液态玻璃折射（可自动 / 强制开 / 强制关）
 *
 * 做法：在 `backdrop-filter` 里引用 index.html 中的 SVG 滤镜 #lg-refract
 * （feTurbulence → feDisplacementMap），让玻璃背后的画面被低频起伏推开几像素。
 * 这是「半透明卡片」与「玻璃」之间最难替代的一层，纯渐变做不出来。
 *
 * 三种模式（设置 → 外观 → 液态玻璃）：
 * - `auto`（默认）：先做支持性检测，再跑 2s 帧率哨兵；低于 45fps 自动摘掉，
 *   并写 sessionStorage，本次会话不再尝试；
 * - `on`：强制启用，跳过哨兵（桌面上想一直看折射时用）；
 * - `off`：完全关闭，回到普通模糊玻璃。
 *
 * 为什么不能写死在 CSS：
 * 1. 这是逐像素滤镜，背景本身还在动（环境光场 90s 漂移 + 星图），
 *    Chromium 要在玻璃区域重采样，低端机 / 老 WebView2 会掉帧；
 * 2. backdrop-filter 接受 url() 是较新的能力，旧内核会整条声明失效、连模糊一起丢。
 *
 * 系统「减少动态效果」下一律不启用：折射会持续重采样静止画面，对这类用户是噪音。
 */

import { hasFinePointer, prefersReducedMotion } from './motionPrefs';
import { defineRawStore } from '../storage/kv';

/** 挂在 <html> 上的开关类，CSS 侧据此启用折射 */
export const REFRACT_CLASS = 'lg-refract';
/** 用户偏好：自动 / 强制开 / 强制关 */
export type RefractMode = 'auto' | 'on' | 'off';

const MODE_KEY = 'knowlattice-liquid-glass';
/** 帧率哨兵：低于这个值就认为这台机器撑不住 */
const MIN_FPS = 45;
/** 采样窗口（毫秒） */
const PROBE_MS = 2000;
/** 本次会话已判定撑不住时写入的标记 */
const SKIP_KEY = 'knowlattice-lg-refract-skip';

const modeStore = defineRawStore(MODE_KEY);

/** 认不出的值一律当 auto（手改 localStorage / 旧版本残留都不会让玻璃消失） */
export function normalizeRefractMode(raw: string | null | undefined): RefractMode {
  return raw === 'on' || raw === 'off' ? raw : 'auto';
}

export function currentRefractMode(): RefractMode {
  return normalizeRefractMode(modeStore.read());
}

let mode: RefractMode = 'auto';
/** auto 模式下已被哨兵判定为「撑不住」 */
let degraded = false;
let probing = false;
let raf = 0;
let frames = 0;
let startedAt = 0;

function supportsRefract(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  try {
    return CSS.supports('backdrop-filter', 'url(#lg-refract)');
  } catch {
    return false;
  }
}

function skipThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberSkip(): void {
  try {
    window.sessionStorage.setItem(SKIP_KEY, '1');
  } catch {
    /* 隐私模式禁用存储：忽略即可，下次刷新会重新评估 */
  }
}

function setClass(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(REFRACT_CLASS, on);
}

function shouldEnable(): boolean {
  if (mode === 'off') return false;
  if (!supportsRefract() || prefersReducedMotion()) return false;
  // 触屏/窄屏本来就走降级模糊（16-liquid-glass.css 的移动端覆盖），
  // 折射会盖掉那套降级，等于在手机上硬开最贵的效果
  if (!hasFinePointer()) return false;
  if (mode === 'on') return true;
  return !degraded && !skipThisSession();
}

function stopProbe(): void {
  probing = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  frames = 0;
  startedAt = 0;
}

function tick(now: number): void {
  if (typeof document === 'undefined') return;
  if (document.hidden) {
    // 后台标签页的 rAF 会被节流到 1–2fps，直接重新计时，避免误判
    startedAt = now;
    frames = 0;
    raf = requestAnimationFrame(tick);
    return;
  }
  if (!startedAt) startedAt = now;
  frames++;
  const elapsed = now - startedAt;
  if (elapsed < PROBE_MS) {
    raf = requestAnimationFrame(tick);
    return;
  }
  raf = 0;
  probing = false;
  const fps = (frames * 1000) / elapsed;
  if (fps < MIN_FPS) {
    degraded = true;
    setClass(false);
    rememberSkip();
  }
}

function startProbe(): void {
  if (probing) return;
  probing = true;
  frames = 0;
  startedAt = 0;
  // 推迟两帧：把首屏渲染那一帧排除在采样之外
  raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(tick);
  });
}

function sync(): void {
  const on = shouldEnable();
  setClass(on);
  // 只有 auto 模式才需要哨兵；强制开表示用户已知情并接受
  if (on && mode === 'auto') startProbe();
  else stopProbe();
}

/** 设置页调用：写入偏好并立即生效；返回归一化后的值 */
export function applyRefractMode(next: RefractMode): RefractMode {
  mode = normalizeRefractMode(next);
  modeStore.write(mode);
  sync();
  return mode;
}

export function initLiquidGlass(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  mode = currentRefractMode();
  sync();
  return () => {
    stopProbe();
    setClass(false);
  };
}
