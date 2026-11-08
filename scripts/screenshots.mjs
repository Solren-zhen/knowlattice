/**
 * 界面截图：给重构留痕用。
 *
 * 重构动的是内部结构（遮罩层、面板开关、持久化），**界面应当零变化**——
 * 所以这组图的作用是「视觉回归的证据」：改完之后逐屏看一眼，与改之前一致。
 *
 * 用法：先起 dev server（`npx vite --port 5175`），再
 *   node scripts/screenshots.mjs [输出目录]
 * 默认输出到 `docs/refactor-YYYY-MM-DD/`。
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5175';
const OUT = process.argv[2] ?? `docs/refactor-${new Date().toISOString().slice(0, 10)}`;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2, // 2x：嵌进文档里文字不糊
});

const shot = async (name) => {
  await page.waitForTimeout(600); // 等淡入动画落定，否则截到半透明中间态
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ✓ ${name}.png`);
};

/**
 * 用命令面板打开一个功能。
 * 注意：命令面板里**没有**「设置」这一条（PALETTE_COMMANDS 不含 settings），
 * 所以设置走导轨；其余命令用这里。
 */
const openVia = async (command) => {
  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder(/输入命令/).fill(command);
  await page.keyboard.press('Enter');
  await expectOverlay(command);
};

/** 导轨：桌面展开态直接可见，收起态先点母主题 */
const openRail = async (group, entry) => {
  const button = page.getByRole('button', { name: entry, exact: true });
  if (!(await button.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: group, exact: true }).click();
  }
  await button.click();
  await expectOverlay(entry);
};

/**
 * 截图前先确认真有面板打开，避免「截到上一屏」这种静默失败。
 * 必须**轮询**：题库、学习报告这些是懒加载 chunk，回车之后还要下载+挂载。
 */
const expectOverlay = async (name, timeout = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const layers = await page.evaluate(() => {
      const sel = '.panel-backdrop, .panel--full, .notice-overlay, .pathway-builder-overlay, .qs-modal';
      const all = Array.from(document.querySelectorAll(sel)).filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      return all.filter((el) => !el.parentElement?.closest(sel)).length;
    });
    if (layers >= 1) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`${name}：面板 ${timeout}ms 内没打开，截图会截到上一屏`);
};

const closeAll = async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};

console.log(`输出目录：${OUT}`);
await page.goto(BASE);
await page.waitForTimeout(1500);

// 1. 首页（空库）：导航轨 + 快捷操作 + 最近使用
await shot('01-home');

// 2. 新建一篇笔记，进三栏编辑态（目录 | 编辑器 | 关联）
await page.getByRole('region', { name: '快捷操作' }).getByRole('button', { name: '新建笔记' }).click();
await page.getByPlaceholder(/笔记标题/).fill('重构留痕·示例笔记');
await page.getByRole('button', { name: '创建', exact: true }).click();
const editor = page.locator('.cm-content');
await editor.click();
await page.keyboard.type('# 重构留痕\n\n这篇笔记用来截三栏布局：左侧目录、中间编辑、右侧关联。\n\n- 遮罩层统一走 PanelOverlay\n- 面板开关收进 usePanelState\n');
await page.waitForTimeout(2000); // 等自动保存落盘
await shot('02-editor-three-columns');

// 3. 快速搜索（Ctrl+K）：层级最高的浮层（z-index 100）
await page.keyboard.press('Control+k');
await shot('03-overlay-search');
await closeAll();

// 4. 设置面板：DialogSurface + PanelOverlay 的组合形态
await openRail('系统', '设置');
await shot('04-overlay-settings');
await closeAll();

// 5. 医学速查：panel-backdrop > panel--full 的嵌套形态（e2e 里最容易数错层的那种）
await openVia('医学速查');
await shot('05-overlay-medref-nested');
await closeAll();

// 6. 题库练习：面板内还有一层自己的列表/题目区
await openVia('题库练习');
await shot('06-overlay-quiz');
await closeAll();

// 7. 学习报告（Dashboard）：色调不同的遮罩（mistake-overlay）
await openVia('学习报告');
await shot('07-overlay-dashboard');
await closeAll();

console.log('完成。');
await browser.close();
