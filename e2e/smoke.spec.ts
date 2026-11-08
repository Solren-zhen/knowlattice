/**
 * 冒烟测试：真实浏览器里的「写进去 → 刷新 → 还在」与整屏面板切换。
 *
 * 选择器只依赖用户可见的东西（按钮文字、aria-label、placeholder），
 * 不依赖内部类名——类名可以重构，用户能看到的路由不会。
 */
import { expect, test, type Page } from '@playwright/test';

const TITLE = `冒烟笔记-${Date.now().toString(36)}`;
const BODY = 'E2E 冒烟正文：刷新后这一行必须还在。';

/** 打开导轨上的某个功能：只在「主导航」landmark 里找，避免命中首页同名链接。
 *  先看母主题的 aria-expanded：已经展开就直接点条目，不再点一下母主题把它收回去。 */
async function openRail(page: Page, group: string, entry: string) {
  const rail = page.getByRole('navigation', { name: '主导航' });
  const groupButton = rail.getByRole('button', { name: group, exact: true });
  if ((await groupButton.getAttribute('aria-expanded')) !== 'true') {
    await groupButton.click();
  }
  await rail.getByRole('button', { name: entry, exact: true }).click();
}

test('新建笔记 → 输入 → 刷新后内容仍在 → 打开题库面板', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');

  // 首次打开是空库：首页的「快捷操作」卡片里有新建入口
  const newNote = page.getByRole('region', { name: '快捷操作' }).getByRole('button', { name: '新建笔记' });
  await expect(newNote).toBeVisible();
  await newNote.click();

  // 新建表单：标题 + 创建
  await page.getByPlaceholder(/笔记标题/).fill(TITLE);
  await page.getByRole('button', { name: '创建', exact: true }).click();

  // CodeMirror 的编辑区出现后输入正文
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(BODY);

  // 自动保存是 0.8s 防抖：等它落盘，再刷新
  await page.waitForTimeout(2000);
  await page.reload();

  // 刷新后：笔记还在树的可见范围里；标题能点开，正文能读回
  await expect(page.locator('.cm-content')).toHaveCount(0);
  const row = page.getByRole('button', { name: `打开笔记：${TITLE}` });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.cm-content')).toContainText('刷新后这一行必须还在');

  // 整屏面板：题库打开后遮罩存在，按 Esc 能关掉（层级/开关语义一起验）
  await openRail(page, '学习', '题库练习');
  await expect(page.locator('.quiz-overlay')).toBeVisible();
  await page.locator('.quiz-overlay').press('Escape');
  await expect(page.locator('.quiz-overlay')).toHaveCount(0);

  expect(errors, `页面运行期报错：\n${errors.join('\n')}`).toEqual([]);
});

test('首页 → 命令面板能打开功能（快捷键路径与导轨同源）', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '回到主界面' }).click();
  await page.keyboard.press('Control+Shift+P');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await page.getByPlaceholder(/输入命令/).fill('待办');
  await page.keyboard.press('Enter');
  // 待办工作台是全屏面板：出现即说明「先关别的面板再开」这条路由生效
  await expect(page.getByRole('dialog', { name: '工作台' })).toBeVisible();
});

test('AI 笔记栏的下方抓手也能拖动整栏（双击复位）', async ({ page }) => {
  await page.goto('/');
  // 等 React 挂上全局快捷键再按：刚落地就按会落在监听器注册之前（与下面懒加载用例同一条等待）
  await expect(page.locator('[aria-label="主导航"]')).toBeVisible();
  // 点一次首页按钮：确认 React 事件已经接上，再走全局快捷键。
  // 只等导航栏出现时，负责注册 Ctrl+Shift+P 的 effect 可能还没跑完。
  await page.getByRole('button', { name: '回到主界面' }).click();
  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder(/输入命令/).fill('AI 笔记');
  await page.keyboard.press('Enter');

  const col = page.locator('.dock-col');
  await expect(col).toBeVisible();
  // AI 笔记是懒加载块：等它挂载并撑开整栏，否则拖动会与「面板变高」抢同一帧
  await expect(col.locator('> .agent-panel')).toBeVisible();
  const handle = col.locator('.dock-col__drag--bottom');
  await expect(handle).toBeVisible();
  // 懒加载内容 / 入口动画还会继续改整栏高度：等连续两次量到的尺寸一致再拖，
  // 否则 pointerdown 与「面板变高」抢同一帧，拖动偶发不生效（复跑时好时坏）
  await expect.poll(async () => {
    const a = await col.boundingBox();
    await page.waitForTimeout(60);
    const b = await col.boundingBox();
    return Boolean(a && b && Math.abs(a.height - b.height) < 1 && Math.abs(a.y - b.y) < 1);
  }, { timeout: 5_000 }).toBe(true);

  const before = await col.evaluate((el) => getComputedStyle(el).transform);
  await handle.hover();
  const box = (await handle.boundingBox())!;
  await page.mouse.down();
  // 从底边往上拖：整栏跟着上移（这是「下方也能拖动窗口」的可观察结果）
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 10 });
  await page.mouse.up();

  const after = await col.evaluate((el) => getComputedStyle(el).transform);
  expect(after).not.toBe(before);
  const ty = Number(/matrix\(1, 0, 0, 1, [-\d.]+, ([-\d.]+)\)/.exec(after)?.[1] ?? '0');
  // AI 笔记撑到上限时整栏几乎满高，上移量被「顶边不许离开视口」的规则夹住，只要求真动了
  expect(ty).toBeLessThan(0);
  expect(await col.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);

  // 双击复位回默认位置
  // 抓手刚被拖走时，「在同一屏幕坐标再双击」会被 pointer capture / 命中区变化干扰；
  // 这里要验的是复位处理器，直接派发 dblclick 更稳定
  await handle.dispatchEvent('dblclick');
  await expect.poll(() => col.evaluate((el) => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
});

test('视频笔记同样能从下方的抓手拖动整栏', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[aria-label="主导航"]')).toBeVisible();
  // 点一次首页按钮：确认 React 事件已经接上，再走全局快捷键。
  // 只等导航栏出现时，负责注册 Ctrl+Shift+P 的 effect 可能还没跑完。
  await page.getByRole('button', { name: '回到主界面' }).click();
  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder(/输入命令/).fill('视频笔记');
  await page.keyboard.press('Enter');

  const col = page.locator('.dock-col');
  const video = col.locator('> .video-note-wrap');
  await expect(video).toBeVisible();
  const handle = col.locator('.dock-col__drag--bottom');
  await expect(handle).toBeVisible();

  await handle.hover();
  const box = (await handle.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 10 });
  await page.mouse.up();

  const after = await col.evaluate((el) => getComputedStyle(el).transform);
  const ty = Number(/matrix\(1, 0, 0, 1, [-\d.]+, ([-\d.]+)\)/.exec(after)?.[1] ?? '0');
  // 只有视频时整栏没那么高，上移 120 应基本足额生效（夹边只允许少量误差）
  expect(ty).toBeLessThan(-60);

  // 抓手刚被拖走时，「在同一屏幕坐标再双击」会被 pointer capture / 命中区变化干扰；
  // 这里要验的是复位处理器，直接派发 dblclick 更稳定
  await handle.dispatchEvent('dblclick');
  await expect.poll(() => col.evaluate((el) => getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
});

test('懒加载面板能真正下载并挂载（AI 笔记 / 智能草稿）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('[aria-label="主导航"]')).toBeVisible();

  // 两个面板都从首屏包里拆了出去（pi-agent-core / pdfjs），走一次真实下载
  for (const [command, root] of [['AI 笔记', '.agent-panel'], ['智能草稿', '.draft-panel']] as const) {
    await page.keyboard.press('Control+Shift+P');
    await page.getByPlaceholder(/输入命令/).fill(command);
    await page.keyboard.press('Enter');
    await expect(page.locator(root)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(root)).toHaveCount(0);
  }

  expect(errors, `懒加载分块失败：\n${errors.join('\n')}`).toEqual([]);
});

/**
 * 导轨上的每个整屏入口：点开只有一层遮罩，Esc 能关掉。
 *
 * 这条守的是「面板注册表」重构：入口只要有一个没被登记成模态，
 * 就会出现两层遮罩叠着（表现为「点了新功能没反应」或「关掉上层冒出下层」）。
 * 能与内容共存的三个入口（目录侧栏 / AI 浮层 / 视频小窗）不在本用例范围内。
 */
const MODAL_ENTRIES: ReadonlyArray<readonly [group: string, entry: string]> = [
  ['工作区', '搜索'],
  ['学习', '题库练习'],
  ['学习', '间隔复习'],
  ['学习', '错题本'],
  ['学习', '学习报告'],
  ['学习', '待办'],
  ['资料', '知识图谱'],
  ['资料', '3D 解剖'],
  ['资料', '脑图谱'],
  ['资料', '标签'],
  ['资料', '医学速查'],
  ['工具', '导入'],
  ['工具', '格式转换'],
  ['工具', '历史版本'],
  ['系统', '设置'],
  ['系统', '安全与隐私'],
];

/** 全屏面板的三种容器写法：普通遮罩 / 整屏面板 / 通路构建器 */
// notice-overlay 是最后一块自己拼的遮罩（SafetyNotice）：它只有「关于与许可」一处，
// 样式也与 panel-backdrop 不同，暂未并入 PanelOverlay，先在这里认领。
const OVERLAY_SEL = '.panel-backdrop, .panel--full, .notice-overlay';
/** 给 Playwright locator 用（`:visible` 是它的扩展伪类，原生 querySelectorAll 不认） */
const OVERLAY =
  '.panel-backdrop:visible, .panel--full:visible, .notice-overlay:visible';

/**
 * 只数**最外层**的容器。
 * 有的面板是 `panel-backdrop > panel--full` 的嵌套结构（医学速查 / 图片库），
 * 直接数元素会把一个面板算成两层。
 */
function overlayLayers(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const all = Array.from(document.querySelectorAll(sel)).filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return all.filter((el) => !el.parentElement?.closest(sel)).length;
  }, OVERLAY_SEL);
}

test('导轨每个整屏入口：同时只有一层遮罩，Esc 能关掉', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  for (const [group, entry] of MODAL_ENTRIES) {
    await openRail(page, group, entry);
    const overlays = page.locator(OVERLAY);
    await expect(overlays.first(), `${entry} 没打开`).toBeVisible({ timeout: 20_000 });
    // 互斥的唯一可观测结果：第二个面板打开时，第一个必须已经关掉（含退出动画结束）
    await expect.poll(() => overlayLayers(page), { message: `${entry} 打开后遮罩叠了`, timeout: 8_000 }).toBe(1);

    await page.keyboard.press('Escape');
    // 带输入框的面板第一次 Esc 只退出输入（escThenClose），再按一次才关
    await page.keyboard.press('Escape');
    await expect(overlays, `${entry} 按 Esc 关不掉`).toHaveCount(0);
  }

  expect(errors, `页面运行期报错：\n${errors.join('\n')}`).toEqual([]);
});
