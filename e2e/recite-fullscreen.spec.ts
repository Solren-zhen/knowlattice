/**
 * 全屏背诵：空格逐条揭、R 全部盖回、结束时留痕。
 *
 * 为什么必须真浏览器：进度与留痕都建立在「DOM 上真的挂没挂 data-revealed」，
 * jsdom 里点一下也能改属性，但键盘事件要经过真实焦点链才证明可用。
 */
import { expect, test, type Page } from '@playwright/test';

const TITLE = `全屏背诵-${Date.now().toString(36)}`;
const BODY = '左心室{{收缩}}时，二尖瓣{{关闭}}，主动脉瓣{{开放}}。';

async function openSplit(page: Page) {
  await page.keyboard.press('Control+Shift+P');
  const input = page.getByPlaceholder(/输入命令/);
  await expect(input).toBeVisible();
  await input.fill('分屏');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '分屏预览' })).toBeVisible();
}

const revealedCount = (page: Page) =>
  page.locator('.recite-panel .cloze-blank[data-revealed]').count();

test('全屏背诵：空格揭一条 → R 盖回 → 结束写入留痕', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByRole('region', { name: '快捷操作' }).getByRole('button', { name: '新建笔记' }).click();
  await page.getByPlaceholder(/笔记标题/).fill(TITLE);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(BODY);
  await page.waitForTimeout(1200); // 自动保存防抖

  await openSplit(page);
  await page.getByRole('button', { name: '全屏背诵', exact: true }).click();

  const panel = page.getByRole('dialog', { name: '全屏背诵' });
  await expect(panel).toBeVisible();
  const blanks = panel.locator('.cloze-blank');
  await expect(blanks).toHaveCount(3);
  await expect(panel.locator('.recite-meta')).toContainText('0 / 3');
  expect(await revealedCount(page)).toBe(0);

  // 空格：揭下一条
  await page.keyboard.press('Space');
  await expect(panel.locator('.recite-meta')).toContainText('1 / 3');
  expect(await revealedCount(page)).toBe(1);

  // R：全部盖回
  await page.keyboard.press('r');
  await expect(panel.locator('.recite-meta')).toContainText('0 / 3');
  expect(await revealedCount(page)).toBe(0);

  // 再揭一条后结束，确认留痕写入 localStorage
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: '结束本轮' }).click();
  await expect(panel).toHaveCount(0);

  const log = await page.evaluate(() => {
    const raw = localStorage.getItem('knowlattice-recite-log');
    return raw ? (JSON.parse(raw) as { path: string; total: number; revealed: number; ms: number }[]) : [];
  });
  expect(log.length).toBeGreaterThan(0);
  expect(log[0].total).toBe(3);
  expect(log[0].revealed).toBe(1);
  expect(log[0].path).toContain('全屏背诵');

  expect(errors, `页面运行期报错：\n${errors.join('\n')}`).toEqual([]);
});
