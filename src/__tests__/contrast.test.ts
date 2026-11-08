/**
 * 对比度断言：把 `00-foundation.css` 注释里那些手算的比值变成每次跑测试都复核的门禁。
 *
 * 为什么不靠人眼：令牌是级联的（00 浅色 → 07 深色覆写），改一次底色或 tint，
 * 注释不会跟着失效。这里的判据只有 WCAG 2.1 的两个数（4.5 / 3），
 * 例外必须显式登记并写明理由与当前实测值——例外表本身就是设计决策记录。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blendOver, contrastRatio, parseAlpha, parseColor, type RGB } from '../core/color';

const STYLES = fileURLToPath(new URL('../styles/', import.meta.url));

/** 从 CSS 文本里取某个选择器之后的第一对花括号内容（够用：令牌块里没有嵌套规则）。 */
function blockOf(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error('找不到选择器：' + selector);
  const open = css.indexOf('{', at);
  if (open < 0) throw new Error('选择器后面没有开括号：' + selector);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

/** 抽出 `--name: value;`；同名后者覆盖前者（块内兜底）。 */
function tokensOf(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of blockOf(css, selector).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const light = tokensOf(readFileSync(STYLES + '00-foundation.css', 'utf8'), ':root');
const dark = tokensOf(readFileSync(STYLES + '07-hero-theme.css', 'utf8'), "[data-theme='dark']");
const guofeng = tokensOf(readFileSync(STYLES + '23-guofeng-theme.css', 'utf8'), "[data-theme='guofeng']");

interface Pair {
  id: string;
  label: string;
  /** 令牌名，或 `--x on --y` 形式由调用方展开 */
  fg: string;
  bg: string;
  /** 大字（≥ 24px 常规 / ≥ 18.66px 粗体）才放宽到 3:1 */
  large?: boolean;
  /** 前景是带 alpha 的淡底时，按这个父色合成 */
  over?: string;
}

const PAIRS: Pair[] = [
  { id: 'text-on-bg', label: '正文 / 页面底', fg: '--text', bg: '--bg' },
  { id: 'text-on-raised', label: '正文 / 卡片', fg: '--text', bg: '--bg-raised' },
  { id: 'text-on-panel', label: '正文 / 面板', fg: '--text', bg: '--panel' },
  { id: 'text2-on-raised', label: '次级正文 / 卡片', fg: '--text-2', bg: '--bg-raised' },
  { id: 'muted-on-raised', label: '说明文字 / 卡片', fg: '--muted', bg: '--bg-raised' },
  { id: 'muted-on-panel', label: '说明文字 / 面板', fg: '--muted', bg: '--panel' },
  { id: 'accent-ink-on-accent', label: '主按钮文字 / 主色', fg: '--accent-ink', bg: '--accent' },
  { id: 'danger-text-on-bg', label: '危险文字 / 页面底', fg: '--danger-text', bg: '--bg' },
  { id: 'amber-text-on-bg', label: '警示文字 / 页面底', fg: '--amber-text', bg: '--bg' },
  { id: 'cyan-text-on-bg', label: '青色文字 / 页面底', fg: '--cyan-text', bg: '--bg' },
  { id: 'success-text-on-bg', label: '成功文字 / 页面底', fg: '--success-text', bg: '--bg' },
  { id: 'warn-text-on-warn-bg', label: '提示文字 / 提示底', fg: '--warn-text', bg: '--warn-bg' },
];

/**
 * 例外登记：`主题:pairId` → 理由 + 当前实测值。
 * 规则：**只能登记已知的装饰性微文案**，不能用来掩盖正文不可读。
 * 一旦实测值比记录值更低（继续变差），测试同样红——例外不等于豁免。
 */
const EXEMPTIONS: Record<string, { reason: string; ratio: number }> = {};

function resolve(tokens: Record<string, string>, name: string): { color: RGB; raw: string } {
  const raw = tokens[name.slice(2)];
  if (!raw) throw new Error('令牌未定义：' + name);
  const color = parseColor(raw);
  if (!color) throw new Error('令牌不是可解析的颜色：' + name + ' = ' + raw);
  return { color, raw };
}

/** 算一对令牌的对比度；半透明前景先合成到 `over`（默认页面底）上。 */
function ratioOf(tokens: Record<string, string>, pair: Pair): number {
  const fg = resolve(tokens, pair.fg);
  const bg = resolve(tokens, pair.bg);
  const bgColor = pair.over ? blendOver(bg.color, resolve(tokens, pair.over).color, parseAlpha(bg.raw)) : bg.color;
  const fgColor = parseAlpha(fg.raw) < 1
    ? blendOver(fg.color, pair.over ? resolve(tokens, pair.over).color : bgColor, parseAlpha(fg.raw))
    : fg.color;
  return contrastRatio(fgColor, bgColor);
}

describe.each([
  ['浅色主题', light],
  ['深色主题', dark],
  ['国风主题', guofeng],
])('对比度 · %s', (theme, tokens) => {
  it('令牌块能取到正文与底色（防止选择器改名后空跑）', () => {
    expect(tokens['text']).toBeTruthy();
    expect(tokens['bg']).toBeTruthy();
    expect(tokens['bg-raised']).toBeTruthy();
  });

  for (const pair of PAIRS) {
    const key = theme + ':' + pair.id;
    const required = pair.large ? 3 : 4.5;
    it(`${pair.label} ≥ ${required}:1`, () => {
      // 深色主题没覆写的令牌沿用浅色值，取并集才能算
      const merged = { ...light, ...tokens };
      const ratio = ratioOf(merged, pair);
      const exempt = EXEMPTIONS[key];
      if (exempt) {
        expect(ratio, `${pair.label}：${ratio}:1，例外记录 ${exempt.ratio}:1（${exempt.reason}）`)
          .toBeGreaterThanOrEqual(exempt.ratio);
        return;
      }
      expect(ratio, `${pair.label} 实测 ${ratio}:1`).toBeGreaterThanOrEqual(required);
    });
  }
});
