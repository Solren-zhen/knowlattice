/**
 * 主题：json 浅色（蓝白）/ 深色（Claude Code 暖灰）+ 持久记忆。
 * 通过 <html data-theme="light|dark"> 切换，CSS 变量据此生效，不覆盖原主题。
 */

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('knowlattice-theme', t);
}

export function initTheme() {
  const saved = localStorage.getItem('knowlattice-theme');
  applyTheme(saved === 'dark' ? 'dark' : 'light');
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
  localStorage.setItem('knowlattice-font', f);
}

export function initFont() {
  const saved = localStorage.getItem('knowlattice-font');
  applyFont(saved === 'serif' || saved === 'mono' ? saved : 'system');
}
