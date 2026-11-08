/**
 * 笔记背诵模式：`{{挖空}}` 在分屏预览里能被盖住、点开、再盖回去。
 *
 * 为什么要在真浏览器里测：遮挡靠的是 CSS（`color: transparent` + 胶带底色），
 * jsdom 不计算样式——只断言类名会漏掉「类挂上了但根本没盖住」这种最真实的坏法。
 *
 * 注意：挖空带 `transition`，点击后颜色有一小段过渡，所以断言一律用 `expect.poll`
 * 等到稳定值；直接读会拿到过渡起点，看起来像"点了没反应"。
 */
import { expect, test, type Page, type Locator } from '@playwright/test';

const TITLE = `背诵笔记-${Date.now().toString(36)}`;
const BODY = '左心室{{收缩}}时，二尖瓣{{关闭}}，主动脉瓣开放。';

async function openSplitPreview(page: Page) {
  await page.keyboard.press('Control+Shift+P');
  const input = page.getByPlaceholder(/输入命令/);
  await expect(input).toBeVisible();
  await input.fill('分屏');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '分屏预览' })).toBeVisible();
}

/** 读某个挖空当前的计算样式里「文字是否真的看不见」 */
async function isCovered(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const color = getComputedStyle(el).color;
    return color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
  });
}

test('分屏预览：背诵盖住挖空 → 点开 → 全盖', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  // 建一篇带挖空的笔记
  await page.getByRole('region', { name: '快捷操作' }).getByRole('button', { name: '新建笔记' }).click();
  await page.getByPlaceholder(/笔记标题/).fill(TITLE);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(BODY);
  await page.waitForTimeout(1200); // 自动保存防抖

  // 阅读态：挖空可见（不是透明），也还不该有背诵类
  await openSplitPreview(page);
  const blanks = page.locator('.note-split__body .cloze-blank');
  await expect(blanks).toHaveCount(2);
  await expect(page.locator('.note-split__body .md-recite')).toHaveCount(0);
  expect(await isCovered(blanks.first())).toBe(false);

  // 开背诵：盖住
  await page.getByRole('button', { name: /进入背诵模式/ }).click();
  await expect(page.locator('.note-split__body .md-recite')).toHaveCount(1);
  await expect.poll(() => isCovered(blanks.first())).toBe(true);
  await expect.poll(() => isCovered(blanks.nth(1))).toBe(true);

  // 点第一个 → 只揭开这一条（第二条仍盖住）
  await blanks.first().click();
  await expect.poll(() => isCovered(blanks.first())).toBe(false);
  expect(await isCovered(blanks.nth(1))).toBe(true);

  // 全盖 → 又都盖住
  await page.getByRole('button', { name: '重新盖住全部已揭开的挖空' }).click();
  await expect.poll(() => isCovered(blanks.first())).toBe(true);

  expect(errors, `页面运行期报错：\n${errors.join('\n')}`).toEqual([]);
});
