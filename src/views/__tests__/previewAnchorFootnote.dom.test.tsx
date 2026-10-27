// @vitest-environment jsdom
/**
 * 块锚点与脚注在预览里的呈现。
 *
 * 三条都是「看不见就等于不存在」的行为：
 * 行尾 `^id` 若照原样渲染，读者会以为笔记里写脏了；脚注引用若显示成 `[^1]` 原文，
 * 作者就没有理由用它；锚点点进去若没有可定位的元素，`[[笔记#^id]]` 就成了死链。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import Preview from '../Preview';

afterEach(() => cleanup());

async function renderPreview(content: string) {
  const { container } = render(<Preview content={content} />);
  await waitFor(
    () => expect(container.querySelector('.markdown-body')?.innerHTML ?? '').not.toBe(''),
    { timeout: 5000 },
  );
  return container;
}

describe('块锚点', () => {
  it('行尾 ^id 不再显示成正文，而是留一个可定位的锚点', async () => {
    const c = await renderPreview('静息电位由钾外流决定。 ^abc123\n');
    const html = c.querySelector('.markdown-body')!.innerHTML;
    expect(html).toContain('id="blk-abc123"');
    expect(html).not.toContain('^abc123');
  });

  it('代码块里的 ^id 保持原样（它是内容，不是标记）', async () => {
    const c = await renderPreview('```\necho ^abc123\n```\n');
    expect(c.querySelector('.markdown-body')!.innerHTML).toContain('^abc123');
  });
});

describe('脚注', () => {
  it('正文引用变上标，定义统一挪到文末「注释」里', async () => {
    const c = await renderPreview('静息电位靠钾外流。[^1]\n\n[^1]: 生理学第 2 章\n');
    const body = c.querySelector('.markdown-body')!;
    expect(body.querySelector('.fn-ref')?.textContent).toBe('1');
    // 定义行不该留在正文中间
    expect(body.innerHTML).not.toContain('[^1]: 生理学第 2 章');
    expect(body.textContent).toContain('注释');
    expect(body.textContent).toContain('生理学第 2 章');
  });

  it('没有脚注的笔记不留一条多余的分隔线', async () => {
    const c = await renderPreview('只有正文，没有脚注。\n');
    expect(c.querySelector('.markdown-body')!.textContent).not.toContain('注释');
  });
});
