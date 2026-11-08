/**
 * Liquid Glass 材质契约（静态解析，不启浏览器）。
 *
 * 这些是「材质」本身的可执行约束，不是渲染结果：
 *   - 玻璃最多两层模糊（本体 + 边缘环），模糊半径有上限；
 *   - 降级必须成套（不支持 / 降低透明度 / 高对比度 / 打印 / 触屏）；
 *   - 薄霜合成底对正文仍要达到 AAA（7:1），不能为了「更透」把可读性卖掉；
 *   - 本文件零 !important —— 有它在，降级块会被后面的域内规则随手压掉。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blendOver, contrastRatio, parseAlpha, parseColor, type RGB } from '../core/color';

const CSS = readFileSync(fileURLToPath(new URL('../styles/16-liquid-glass.css', import.meta.url)), 'utf8');
const GUOFENG_CSS = readFileSync(fileURLToPath(new URL('../styles/23-guofeng-theme.css', import.meta.url)), 'utf8');

function blockOf(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error('找不到选择器：' + selector);
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

function tokensOf(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of blockOf(css, selector).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokensOf(CSS, ':root');
const dark = tokensOf(CSS, "[data-theme='dark']");
const guofeng = tokensOf(GUOFENG_CSS, "[data-theme='guofeng']");

/** 半透明玻璃压在背景色上的合成色 */
function compose(glass: string, backdrop: string): RGB {
  const fg = parseColor(glass);
  const bg = parseColor(backdrop);
  if (!fg || !bg) throw new Error('颜色解析失败：' + glass + ' / ' + backdrop);
  return blendOver(fg, bg, parseAlpha(glass));
}

describe('Liquid Glass · 材质契约', () => {
  it('本文件零 !important', () => {
    expect(CSS).not.toMatch(/!important/);
  });

  it('玻璃本体 + 边缘环最多两层模糊，且单条规则不超过两个 backdrop-filter 声明', () => {
    // 按「选择器 { 规则体 }」粗切，统计每个块里的 backdrop-filter 条数
    const blocks = CSS.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    for (const block of blocks) {
      const count = (block.match(/backdrop-filter\s*:/g) ?? []).length;
      expect(count, block.slice(0, 80)).toBeLessThanOrEqual(2);
    }
  });

  it('模糊半径有上限：桌面 ≤26px，窄屏/触屏 ≤14px', () => {
    const desktop = [...CSS.matchAll(/blur\((\d+)px\)/g)].map((m) => Number(m[1]));
    expect(Math.max(...desktop)).toBeLessThanOrEqual(26);
    const coarse = CSS.slice(CSS.indexOf('@media (max-width: 900px), (pointer: coarse)'));
    const mobile = [...coarse.matchAll(/blur\((\d+)px\)/g)].map((m) => Number(m[1]));
    for (const n of mobile) expect(n).toBeLessThanOrEqual(14);
  });

  it('五种降级环境都存在，且都撤掉模糊', () => {
    expect(CSS).toContain('@supports not');
    expect(CSS).toContain('prefers-reduced-transparency: reduce');
    expect(CSS).toContain('prefers-contrast: more');
    expect(CSS).toContain('@media print');
    expect(CSS).toContain('(pointer: coarse)');
    const repro = (start: string) => CSS.slice(CSS.indexOf(start));
    expect(repro('@supports not')).toMatch(/backdrop-filter:\s*none/);
    expect(repro('@media print')).toMatch(/backdrop-filter:\s*none/);
    expect(repro('prefers-reduced-transparency: reduce')).toMatch(/backdrop-filter:\s*none/);
    expect(repro('prefers-contrast: more')).toMatch(/backdrop-filter:\s*none/);
  });

  it('深色主题有独立的一套材质令牌', () => {
    for (const key of ['lg-tint', 'lg-tint-strong', 'lg-frost', 'lg-edge', 'lg-blur', 'lg-sheen', 'lg-shadow']) {
      expect(light[key], 'light --' + key).toBeTruthy();
      expect(dark[key], 'dark --' + key).toBeTruthy();
    }
  });

  it('国风主题覆写了同一套材质令牌（漏写会静默回落到浅色玻璃）', () => {
    for (const key of ['lg-tint', 'lg-tint-strong', 'lg-frost', 'lg-edge', 'lg-blur', 'lg-sheen', 'lg-shadow', 'lg-inset-highlight']) {
      expect(guofeng[key], 'guofeng --' + key).toBeTruthy();
    }
    // 纸墨主题的三条硬特征：不模糊、无镜面渐变、顶边无白色高光
    expect(guofeng['lg-blur']).toBe('none');
    expect(guofeng['lg-sheen']).toBe('none');
    expect(guofeng['lg-inset-highlight']).toBe('none');
  });

  it('薄霜合成底对正文仍达 AAA（7:1），亮暗两套都算一遍', () => {
    // 亮色：薄霜压在强调色（最坏情况：中深底）与深色底上
    const lightOnAccent = compose(light['lg-frost'], '#4f46e5');
    const lightOnInk = compose(light['lg-frost'], '#0f172a');
    expect(contrastRatio('#0f172a', lightOnAccent)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio('#0f172a', lightOnInk)).toBeGreaterThanOrEqual(7);
    // 深色：深玻璃压在深色纸面上（深色主题的 --bg / --panel），不是压在浅底上
    const darkOnBg = compose(dark['lg-frost'], '#08090d');
    const darkOnPanel = compose(dark['lg-frost'], '#131722');
    expect(contrastRatio('#f8fafc', darkOnBg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio('#f8fafc', darkOnPanel)).toBeGreaterThanOrEqual(7);
  });

  it('卡片用玻璃，导航轨按设计用实底（两者不是同一层材质）', () => {
    expect(blockOf(CSS, '.lg-surface,')).toMatch(/backdrop-filter:\s*var\(--lg-blur\)/);
    expect(blockOf(CSS, '.lg-frost,')).toMatch(/backdrop-filter:\s*var\(--lg-blur\)/);
    // 默认浅色仍是玻璃：导航轨与卡片同材质，靠 tint 深度与投影区分。
    const rail = blockOf(CSS, '.rail {');
    expect(rail).toMatch(/background-color:\s*var\(--lg-tint\)/);
    expect(rail).not.toMatch(/background-image:\s*none/);
  });

  it('减少动效时停掉漂移与扫光', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/body::after/);
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
