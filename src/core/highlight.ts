/**
 * 文本高亮色（`==文字==`）：默认醒目红，可在导航轨「高亮色」里换预设或自定义。
 *
 * 为什么要有这一层：高亮是「一个选择、两处渲染」——编辑器里的 .lp-highlight 与
 * 渲染后的 <mark> 必须同色，否则同一段文字在两侧看起来像两个功能。两处都读
 * --hl-bg / --hl-ink（见 index.css），这里只负责把用户选的颜色写到根元素上并持久化。
 *
 * 字色不跟着用户走：浅底（如柠檬黄）配白字只有 1.2:1，糊成一片。反白还是反黑
 * 由底色亮度算出来（pickInk），用户只管选底色，对比度这一层不交给运气。
 */

export interface HighlightPreset {
  /** 面板里显示的名字，同时用于无障碍标签 */
  name: string;
  /** 高亮底色，6 位十六进制 */
  bg: string;
}

/** 预设：红为默认（醒目，压在浅色纸面上对比强烈），其余用于区分不同语义的标记 */
export const HIGHLIGHT_PRESETS: readonly HighlightPreset[] = [
  { name: '红', bg: '#dc2626' },
  { name: '橙', bg: '#ea580c' },
  { name: '黄', bg: '#facc15' },
  { name: '绿', bg: '#16a34a' },
  { name: '蓝', bg: '#2563eb' },
  { name: '紫', bg: '#7c3aed' },
];

export const DEFAULT_HIGHLIGHT = HIGHLIGHT_PRESETS[0].bg;

const STORAGE_KEY = 'knowlattice-highlight';

/** 深墨字：不用纯黑（纯黑在高亮块上显得脏），够对比即可 */
const DARK_INK = '#141414';
const LIGHT_INK = '#ffffff';

/** '#rgb' / '#rrggbb'（# 可省）→ [r, g, b]；非法输入返回 null */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** sRGB 相对亮度（WCAG 2.x 定义） */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 在给定底色上选对比更高的一侧字色。
 *  白字压 #dc2626 = 4.83:1（达 AA）；压在 #facc15 上只有 1.53:1，必须换深墨字（12:1）。 */
export function pickInk(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return LIGHT_INK;
  const l = luminance(rgb);
  const contrastWithWhite = 1.05 / (l + 0.05);
  const contrastWithDark = (l + 0.05) / 0.05;
  return contrastWithDark >= contrastWithWhite ? DARK_INK : LIGHT_INK;
}

/** 归一化成 '#rrggbb'；非法值退回默认红，调用方不必自己兜 */
export function normalizeHighlight(color: string | null | undefined): string {
  const rgb = parseHex(color ?? '');
  if (!rgb) return DEFAULT_HIGHLIGHT;
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function currentHighlight(): string {
  try {
    return normalizeHighlight(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_HIGHLIGHT;
  }
}

/** 写根元素变量 + 持久化。写不进 localStorage（隐私模式）时本次会话照样生效。 */
export function applyHighlight(color: string) {
  const bg = normalizeHighlight(color);
  const root = document.documentElement;
  root.style.setProperty('--hl-bg', bg);
  root.style.setProperty('--hl-ink', pickInk(bg));
  try {
    localStorage.setItem(STORAGE_KEY, bg);
  } catch {
    /* ignore */
  }
}

/** 没存过就不写：让 index.css 里的默认红生效，而不是把默认值再抄一份到内联样式 */
export function initHighlight() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (saved) applyHighlight(saved);
}
