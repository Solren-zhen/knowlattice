#!/usr/bin/env node
/**
 * 动效静态审计：不启动浏览器，直接对 src/index.css 做五条硬检查。
 * 用途：改完动效令牌/曲线后，先跑这个再进浏览器看效果 —— 把「动画静默失效」
 * 这一类只在运行时才看得出来的问题提前到构建前。
 *
 *   1. 每个 `animation: <name>` 引用的 @keyframes 都已定义
 *      （防「引用了从未定义的动画」：元素直接出现，没有入场，肉眼很难归因）
 *   2. 每个 animation / transition 声明里用到的 var(--x) 都已在文件内定义
 *      （防令牌改名只改一半）
 *   3. 挂在 infinite 上的动画不得使用单向强缓出曲线
 *      （循环需要对称曲线，单向强缓出会「一闪一爬」，读作卡顿）
 *   4. 全局 prefers-reduced-motion 兜底守卫仍然存在
 *   5. 打印缓动分层使用统计（--ease / --ease-out / --ease-in / --ease-in-out / --ease-back）
 *
 * 用法：node scripts/audit-motion.mjs [css 路径]
 * 退出码：0 = 通过，1 = 有问题（可直接挂进 CI）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(process.argv[2] ?? resolve(here, '..', 'src', 'index.css'));
const css = readFileSync(cssPath, 'utf8');

const problems = [];

// --- 1. animation 引用的 keyframes 必须已定义 ---
const defined = new Set([...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
const KEYWORD = new Set(['infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'both', 'forwards',
  'backwards', 'alternate', 'alternate-reverse', 'reverse', 'normal', 'none', 'running', 'paused', 'jump-start', 'jump-end']);
const usedNames = new Set();
for (const m of css.matchAll(/animation\s*:\s*([^;{}]+);/g)) {
  const decl = m[1].trim();
  if (!decl || decl === 'none') continue;
  for (const part of decl.split(',')) {
    const name = part.trim().split(/\s+/).find((t) =>
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(t) && !KEYWORD.has(t) && !t.startsWith('steps'));
    if (name) usedNames.add(name);
  }
}
for (const name of usedNames) {
  if (!defined.has(name)) problems.push(`[1] animation 引用了未定义的 @keyframes: ${name}`);
}

// --- 2. 动效声明里的 var(--x) 必须已定义 ---
const definedVars = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
for (const m of css.matchAll(/[^;{}\n]*\b(?:animation|transition)\s*:[^;}]*/g)) {
  for (const v of m[0].matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!definedVars.has(v[1])) problems.push(`[2] 未定义令牌 ${v[1]}（出现在：${m[0].trim().slice(0, 70)}）`);
  }
}

// --- 3. infinite 动画不得用单向强缓出曲线 ---
const loopRe = /animation\s*:\s*([^;{}]*infinite[^;{}]*);/g;
const loops = [...css.matchAll(loopRe)];
for (const m of loops) {
  const decl = m[1].trim();
  const name = decl.split(/\s+/)[0];
  if (/ease-in-out|linear|steps\(/.test(decl)) continue;
  if (/var\(--ease\)|var\(--ease-out\)|cubic-bezier\(\s*0\.16\s*,\s*1\s*,\s*0\.3\s*,\s*1\s*\)/.test(decl)) {
    problems.push(`[3] infinite 动画 ${name} 用了单向强缓出（应换 --ease-in-out 或 linear）：${decl}`);
  }
}

// --- 4. prefers-reduced-motion 全局兜底 ---
if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)) {
  problems.push('[4] 缺少 @media (prefers-reduced-motion: reduce) 兜底');
} else if (!/animation-duration:\s*0\.01ms\s*!important/.test(css) || !/transition-duration:\s*0\.01ms\s*!important/.test(css)) {
  problems.push('[4] prefers-reduced-motion 里缺少 `* { animation-duration / transition-duration: 0.01ms !important }` 全局兜底');
}

// --- 5. 按钮按下缩放必须来自 --press-scale* 令牌 ---
// 同一句「按下去」在 8 类按钮上各写一个魔法数字，改一个漏一个：.btn-primary:active
// 就曾被后写的 scale(0.985) 整条盖掉（改前一条完全没效果，肉眼看不出来）。
const PRESS_RULE = /^\.(?:btn|btn-small|btn-icon|btn-primary|rate|opt|rail-btn|toolbar-search)[^{]*:active[^{]*\{([^}]*)\}/gm;
for (const m of css.matchAll(PRESS_RULE)) {
  const hard = m[1].match(/scale\(\s*[0-9.]+/);
  if (hard) {
    problems.push(`[5] 按下缩放写死成 ${hard[0]}…，应改用 var(--press-scale*)：${m[0].trim().slice(0, 70)}`);
  }
}

// --- 6. 报告：动画里动了非合成属性（不是错误，但每帧要重排/重绘，值得知道）---
const spendy = [];
for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
  // 用花括号配对切出整块：单行写法（@keyframes pulse { 50% { … } }）与多行写法都要对，
  // 按行找闭合会在单行写法上一直吞到后面某条规则的 `}`，报出不属于这个动画的属性。
  let depth = 0;
  let end = m.index + m[0].length - 1;
  for (let k = end; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') {
      depth--;
      if (depth === 0) { end = k; break; }
    }
  }
  const text = css.slice(m.index, end + 1);
  for (const prop of ['background-position', 'width', 'height', 'top', 'left', 'filter', 'box-shadow', 'margin', 'font-size']) {
    if (new RegExp(`[;{\\s]${prop}\\s*:`).test(text)) spendy.push(`${m[1]}/${prop}`);
  }
}

// --- 7. 缓动分层使用统计 ---
const counts = {};
for (const m of css.matchAll(/var\((--ease(?:-out|-in|-in-out|-back)?)\)/g)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;

console.log(`审计文件: ${cssPath}`);
console.log(`@keyframes 定义 ${defined.size} 个 · animation 引用 ${usedNames.size} 个 · CSS 令牌 ${definedVars.size} 个 · infinite 动画 ${loops.length} 处`);
console.log('缓动分层:', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 个问题:`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(
  spendy.length
    ? `非合成属性动画 ${spendy.length} 处（每帧重排/重绘，已知且可接受）: ${spendy.join(', ')}`
    : '非合成属性动画: 无',
);
console.log('\n✓ 六项检查全部通过');
