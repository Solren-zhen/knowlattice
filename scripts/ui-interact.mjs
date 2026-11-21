#!/usr/bin/env node
/**
 * 交互回归探测器：把每个面板打开一次，点一遍可见按钮，只回答一个问题——
 * 「点了就崩 / 点了没反应」有没有出现。
 *
 * 用法：
 *   node scripts/ui-interact.mjs                     # 全部面板，每个最多 8 个按钮
 *   ONLY=settings,review node scripts/ui-interact.mjs
 *   MAXBTN=3 node scripts/ui-interact.mjs
 *   BASE_URL=http://localhost:5175 node scripts/ui-interact.mjs
 *
 * 安全边界：
 *   - 使用独立的临时浏览器 profile（每次新建），不碰用户正在用的 localStorage / IndexedDB；
 *   - 跳过删除/清空/重置/导入/导出/备份/打印/上传等破坏性或会弹系统选择的按钮；
 *   - 面板打不开就记 skip，不把「入口没找到」算成崩溃。
 *
 * 再看一眼布局：面板打开时顺手量一次横向溢出（整页能左右拖、面板根被内容顶宽），
 * 并给每个打开成功的面板存一张 ui-interact/<id>.png，出问题能直接看是哪一层。
 *
 * 产物：ui-interact/report.json + ui-interact/<id>.png；
 * 任何 error / exception / 空主区 / ErrorBoundary / 横向溢出都 exit 1。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:5175';
const OUT = 'ui-interact';
const MAXBTN = Number(process.env.MAXBTN ?? 8);
const WAIT = Number(process.env.WAIT_MS ?? 120);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
/** 重面板默认跳过：3D / 图谱 / PDF 在无头环境里会长时间占住主线程，交互回归先不碰。
 *  INCLUDE_HEAVY=1 时一并跑。 */
const HEAVY = new Set(['anatomy', 'brain', 'pdf', 'plot', 'course', 'mind', 'graph', 'video']);
const SKIP_PANELS = process.env.INCLUDE_HEAVY === '1' ? new Set() : HEAVY;

const SKIP_WORDS = [
  '删除', '清空', '重置', '覆盖', '卸载', '退出', '移除', '销毁', '恢复默认',
  '导入', '导出', '备份', '下载', '打印', '上传', '选择文件', '浏览文件',
  '关闭', '取消', '返回', '收起',
];

function panels() {
  const src = readFileSync('src/views/panelRegistry.ts', 'utf8');
  const rows = [];
  for (const line of src.split('\n')) {
    const m = /^\s*\{\s*id:\s*'([^']+)'(.*)$/.exec(line);
    if (!m) continue;
    const modal = /modal:\s*(true|false)/.exec(m[2]);
    if (!modal) continue;
    rows.push({ id: m[1], rail: /rail:\s*'([^']+)'/.exec(m[2])?.[1] ?? '', modal: modal[1] === 'true' });
  }
  return rows;
}

function railLabels() {
  const src = readFileSync('src/views/railCatalog.tsx', 'utf8');
  const out = new Map();
  for (const group of src.matchAll(/title:\s*'([^']+)'[\s\S]{0,2000}?entries:\s*\[([\s\S]*?)\n\s*\]/g)) {
    for (const entry of group[2].matchAll(/key:\s*'([^']+)'[\s\S]{0,80}?label:\s*'([^']+)'/g)) {
      out.set(entry[1], { label: entry[2], group: group[1] });
    }
  }
  return out;
}

const PANELS = panels().filter((p) => !SKIP_PANELS.has(p.id)).filter((p) => !ONLY || ONLY.has(p.id));
const LABELS = railLabels();

mkdirSync(OUT, { recursive: true });
const profile = join(tmpdir(), 'knowlattice-ui-interact-' + Date.now());
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(2500);
page.setDefaultNavigationTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

async function waitForSurface() {
  return page.locator('.panel-backdrop, .panel').first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
}

async function openPanel(panel) {
  // 有轨入口：点母主题展开 → 点条目。收起态会浮出分支；两种都试。
  const entry = panel.rail ? LABELS.get(panel.rail) : null;
  if (entry) {
    const inline = page.locator(`.rail-inline .rail-btn[aria-label="${entry.label}"]`).first();
    // 上一轮可能已经把这组摊开了：先看现成的，避免再点一次把它收起
    if (!(await inline.count())) {
      const group = page.locator(`.rail-group-btn[aria-label="${entry.group}"]`).first();
      if (await group.count()) {
        await group.click().catch(() => {});
        await page.waitForTimeout(220);
        if (!(await inline.count())) {
          // 收起态是「浮出分支」，展开态是「原地摊开」；再点一次覆盖两者
          await group.click().catch(() => {});
          await page.waitForTimeout(220);
        }
      }
    }
    if (await inline.count()) {
      await inline.click();
      return waitForSurface();
    }
    const branch = page.locator(`.rail-branch-item[aria-label="${entry.label}"]`).first();
    if (await branch.count()) {
      await branch.click();
      return waitForSurface();
    }
  }
  // 命令面板兜底：用 id 当搜索词，命中标题或别名即可
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(200);
  const input = page.locator('input[placeholder*="命令"], input[placeholder*="搜索"]').first();
  if (!(await input.count())) return false;
  await input.fill(panel.id);
  await page.waitForTimeout(240);
  await page.keyboard.press('Enter');
  return waitForSurface();
}

/**
 * 横向溢出：只查「整页」和「面板根」两层，不扫所有后代。
 * 后代里横向滚动是刻意设计（chips 行、宽表格、代码块），全量扫会把它们误报成溢出。
 */
async function overflowOf() {
  return page.evaluate(() => {
    const out = [];
    const pageOver = document.documentElement.scrollWidth - window.innerWidth;
    if (pageOver > 2) out.push({ el: 'html', delta: pageOver });
    const root = document.querySelector('.panel-backdrop') ?? document.querySelector('.panel');
    if (root) {
      const style = getComputedStyle(root);
      const own = root.scrollWidth - root.clientWidth;
      if (own > 2 && style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
        out.push({ el: '.' + String(root.className).split(' ').filter(Boolean).slice(0, 2).join('.'), delta: own });
      }
    }
    return out;
  });
}

async function clickButtons(panel) {
  const overlay = page.locator('.panel-backdrop').last();
  const scope = (await overlay.count()) ? overlay : page.locator('.panel').last();
  if (!(await scope.count())) return { opened: false, clicked: 0 };
  const before = errors.length;
  const buttons = scope.locator('button:visible:not([disabled])');
  const total = Math.min(await buttons.count(), MAXBTN);
  let clicked = 0;
  for (let i = 0; i < total; i += 1) {
    const button = buttons.nth(i);
    const text = ((await button.innerText().catch(() => '')) || '').trim();
    const aria = (await button.getAttribute('aria-label').catch(() => '')) || '';
    if (SKIP_WORDS.some((w) => text.includes(w) || aria.includes(w))) continue;
    await button.click({ timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    const current = page.locator('.panel-backdrop').last();
    const currentScope = (await current.count()) ? current : page.locator('.panel').last();
    if (!(await currentScope.count())) break;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!bodyText.trim()) { errors.push('empty-body after click: ' + panel.id + ' / ' + (text || aria)); break; }
    if (bodyText.includes('页面出错了') || bodyText.includes('组件渲染失败')) {
      errors.push('error-boundary after click: ' + panel.id + ' / ' + (text || aria));
      break;
    }
    clicked += 1;
  }
  return { opened: true, clicked, newErrors: errors.length - before };
}

const report = [];
for (const panel of PANELS) {
  errors.length = 0;
  const opened = await openPanel(panel).catch(() => false);
  if (!opened) {
    report.push({ id: panel.id, rail: panel.rail, opened: false, clicked: 0, errors: [] });
    await page.keyboard.press('Escape').catch(() => {});
    continue;
  }
  // 截图放在点按钮之前：这是面板的干净初始态，点完再截会混进弹层
  const shot = join(OUT, panel.id + '.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  const overflow = await overflowOf().catch(() => []);
  const result = await clickButtons(panel);
  report.push({
    id: panel.id, rail: panel.rail, ...result, overflow, shot, errors: [...errors],
  });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(120);
  // 有些面板会弹二次确认：再按一次 Escape
  if (await page.locator('.mv-confirm-overlay').count()) await page.keyboard.press('Escape').catch(() => {});
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), report }, null, 2), 'utf8');
await context.close();

const failed = report.filter((r) => r.opened && r.errors.length);
const spilled = report.filter((r) => r.opened && (r.overflow ?? []).length);
const skipped = report.filter((r) => !r.opened);
console.log(`ui-interact: ${report.length} 个面板，打开 ${report.length - skipped.length}，跳过 ${skipped.length}，有错误 ${failed.length}，横向溢出 ${spilled.length}`);
for (const r of failed) {
  console.log(`  ✗ ${r.id} (${r.clicked} clicks)`);
  for (const e of r.errors.slice(0, 4)) console.log('     · ' + e);
}
for (const r of spilled) {
  console.log(`  ⇥ ${r.id}（截图 ${r.shot}）`);
  for (const o of r.overflow) console.log(`     · ${o.el} 超出 ${o.delta}px`);
}
for (const r of skipped) console.log(`  - ${r.id}：入口未找到（跳过）`);
process.exit(failed.length || spilled.length ? 1 : 0);
