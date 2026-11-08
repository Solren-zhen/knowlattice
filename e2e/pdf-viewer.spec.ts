import { expect, test } from '@playwright/test';

test('PDF 查看器：示例可渲染、可翻页、可搜索', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  // 等 React 挂上全局快捷键再按，避免落在监听器注册之前
  await expect(page.locator('[aria-label="主导航"]')).toBeVisible();

  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder(/输入命令/).fill('PDF 拆分');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '载入示例' }).first().click();

  await expect(page.getByRole('button', { name: '下一页' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('spinbutton', { name: '页码' })).toBeVisible();
  await expect(page.locator('.pdfjs-native-viewer canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pdfjs-native-viewer .textLayer span').first()).toBeVisible({ timeout: 30_000 });

  // 回归：PDF 只能走几何选区。原生选区在绝对定位的文字层上会按 DOM 顺序
  // 把整篇文字一起框进来（实测拖 200px 能选中 801 字），这里用真实鼠标拖一次。
  const firstSpan = page.locator('.pdfjs-native-viewer .textLayer span').first();
  const spanBox = await firstSpan.boundingBox();
  if (!spanBox) throw new Error('PDF 文字层没有可测坐标');
  await page.mouse.move(spanBox.x + 4, spanBox.y + spanBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(spanBox.x + 200, spanBox.y + spanBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.pdf-geo-hl').first()).toBeVisible();
  const dragResult = await page.evaluate(() => ({
    native: window.getSelection()?.toString() ?? '',
    geoCount: document.querySelectorAll('.pdf-geo-hl').length,
    geoLen: Array.from(document.querySelectorAll('.pdf-geo-hl'))
      .map((el) => el.textContent ?? '').join('').length,
  }));
  expect(dragResult.native).toBe('');
  expect(dragResult.geoCount).toBeGreaterThan(0);
  expect(dragResult.geoLen).toBeLessThan(120);

  // 再拖一次跨行：从标题拖到小标题，应只保留标题所在段落，
  // 不能把小标题和正文一起带进来（用户截图里的“整段/多段被选中”）。
  const headingSpan = page.locator('.pdfjs-native-viewer .textLayer span').nth(2);
  const headingBox = await headingSpan.boundingBox();
  if (!headingBox) throw new Error('PDF 小标题没有可测坐标');
  await page.mouse.move(spanBox.x + 4, spanBox.y + spanBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(headingBox.x + 60, headingBox.y + headingBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const crossLine = await page.evaluate(() => ({
    text: Array.from(document.querySelectorAll('.pdf-geo-hl'))
      .map((el) => el.textContent ?? '').join(''),
    native: window.getSelection()?.toString() ?? '',
  }));
  expect(crossLine.text.length).toBeGreaterThan(0);
  expect(crossLine.text.length).toBeLessThan(80);
  expect(crossLine.text).not.toContain('肺通气');
  expect(crossLine.native).toBe('');
  await page.keyboard.press('Escape');

  await expect(page.getByRole('spinbutton', { name: '页码' })).toHaveValue('1');
  await page.getByRole('button', { name: '放大' }).click();
  await expect.poll(() => page.locator('.pdfjs-scale').textContent()).not.toBe('92%');

  await page.getByRole('searchbox', { name: '在 PDF 中搜索' }).fill('肺');
  await expect(page.locator('.pdfjs-find-count')).toContainText(/\d+\s*\/\s*\d+/, { timeout: 15_000 });

  await page.getByRole('button', { name: '← 退出对照' }).click();
  await expect(page.locator('.pdfjs-native-viewer')).toHaveCount(0);

  expect(errors, `PDF 查看器页面报错：\n${errors.join('\n')}`).toEqual([]);
});
