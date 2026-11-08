/**
 * 主题：浅色（蓝白）/ 深色（暖灰）/ 国风（宣纸 · 墨 · 花青）+ 持久记忆。
 * 通过 <html data-theme="light|dark|guofeng"> 切换，CSS 变量据此生效，不覆盖原主题。
 * guofeng 是独立的纸墨主题（见 23-guofeng-theme.css），不改变浅色 / 深色的任何令牌。
 */

import { motionAllowed } from './motionPrefs';
import { defineRawStore } from '../storage/kv';

export type Theme = 'light' | 'dark' | 'guofeng';

/** 主题 / 字体都是裸字符串（不是 JSON），走 defineRawStore 见 storage/kv */
const THEME_STORE = defineRawStore('knowlattice-theme');
const FONT_STORE = defineRawStore('knowlattice-font');

export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || t === 'guofeng' ? t : 'light';
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> } | undefined;
};

/**
 * 切换主题。传入 origin（点击坐标）且环境允许时，用 View Transitions 做一次
 * 从点击点扩散的圆形揭示：把「整屏换色」变成「光从按钮处铺开」。
 * 不支持 / 减少动态效果 / html.no-morph 时退回直接切换，行为不变。
 */
export function applyTheme(t: Theme, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  const commit = () => {
    root.setAttribute('data-theme', t);
    THEME_STORE.write(t);
  };
  const doc = document as ViewTransitionDocument;
  const canReveal =
    !!origin &&
    motionAllowed() &&
    typeof doc.startViewTransition === 'function' &&
    !root.classList.contains('no-morph');

  if (!canReveal || !origin) {
    commit();
    return;
  }

  root.style.setProperty('--theme-x', `${origin.x}px`);
  root.style.setProperty('--theme-y', `${origin.y}px`);
  root.classList.add('theme-switching');
  const cleanup = () => root.classList.remove('theme-switching');
  let transition: { finished: Promise<void> } | undefined;
  try {
    transition = doc.startViewTransition?.(commit);
  } catch {
    commit();
    cleanup();
    return;
  }
  if (transition?.finished) void transition.finished.finally(cleanup);
  else cleanup();
  // 兜底：转场不被触发时 finished 可能不 resolve
  window.setTimeout(cleanup, 900);
}

export function initTheme() {
  const saved = THEME_STORE.read();
  applyTheme(saved === 'dark' || saved === 'guofeng' ? saved : 'light');
}

// ---------- 字体（与主题并列，存 localStorage） ----------

export type Font = 'system' | 'serif' | 'mono';
export const FONT_LABELS: Record<Font, string> = { system: '系统', serif: '衬线', mono: '等宽' };

export function currentFont(): Font {
  const f = document.documentElement.getAttribute('data-font');
  return f === 'serif' || f === 'mono' ? f : 'system';
}

export function applyFont(f: Font) {
  document.documentElement.setAttribute('data-font', f);
  FONT_STORE.write(f);
}

export function initFont() {
  const saved = FONT_STORE.read();
  applyFont(saved === 'serif' || saved === 'mono' ? saved : 'system');
}
