// @vitest-environment jsdom
/**
 * 右侧预览的图片渲染回归。
 * 编辑器实时预览里 `![[图.png]]` 一直是真图片，但右侧预览把它当普通双链渲染成
 * 一条带感叹号的链接（`!` + 链接），两边看到的东西对不上；尺寸 `|300` 更是直接丢掉。
 * 这里钉住：图 → 真 <img>、尺寸 → width/height、缺图 → 明说「图片未导入」、非图片嵌入仍走双链。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import Preview from '../Preview';

afterEach(() => cleanup());

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** 渲染并等到 markdown 异步渲染完成（markdown-it 是懒加载的） */
async function renderPreview(content: string, files: Record<string, string> = {}) {
  const { container } = render(<Preview content={content} readFile={(p) => files[p]} />);
  await waitFor(
    () => expect(container.querySelector('.markdown-body')?.innerHTML ?? '').not.toBe(''),
    { timeout: 5000 }
  );
  return container;
}

describe('预览里的图片', () => {
  it('![[图.png]] 渲染成真图片（而不是带感叹号的双链）', async () => {
    const container = await renderPreview('![[图.png]]', { '图.png': DATA_URL });
    const img = container.querySelector('.markdown-body img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe(DATA_URL);
    expect(container.querySelector('.wikilink')).toBeNull();
  });

  it('![[图.png|300]] 按 Obsidian 的写法把宽度钉到 300', async () => {
    const container = await renderPreview('![[图.png|300]]', { '图.png': DATA_URL });
    const img = container.querySelector('.markdown-body img')!;
    expect(img.getAttribute('width')).toBe('300');
    expect(img.getAttribute('height')).toBeNull();
  });

  it('![[图.png|640x480]] 宽高都生效', async () => {
    const container = await renderPreview('![[图.png|640x480]]', { '图.png': DATA_URL });
    const img = container.querySelector('.markdown-body img')!;
    expect(img.getAttribute('width')).toBe('640');
    expect(img.getAttribute('height')).toBe('480');
  });

  it('管道内容不是数字时当说明文字，不影响尺寸', async () => {
    const container = await renderPreview('![[图.png|肺牵张反射示意]]', { '图.png': DATA_URL });
    const img = container.querySelector('.markdown-body img')!;
    expect(img.getAttribute('alt')).toBe('肺牵张反射示意');
    expect(img.getAttribute('width')).toBeNull();
  });

  it('附件不在库里时明说「图片未导入」，不留破图', async () => {
    const container = await renderPreview('![[缺图.png]]');
    expect(container.querySelector('.markdown-body img')).toBeNull();
    expect(container.querySelector('.mv-img-missing')?.textContent).toContain('图片未导入');
  });

  it('非图片嵌入 ![[笔记]] 仍然走双链，不会被当成图片', async () => {
    const container = await renderPreview('![[某篇笔记]]');
    expect(container.querySelector('.markdown-body img')).toBeNull();
    expect(container.querySelector('.wikilink')?.getAttribute('data-mv-target')).toBe('某篇笔记');
  });

  it('标准 Markdown 图片 ![](路径) 照旧按库内路径渲染', async () => {
    const container = await renderPreview('![](fig/a.png)', { 'fig/a.png': DATA_URL });
    expect(container.querySelector('.markdown-body img')!.getAttribute('src')).toBe(DATA_URL);
  });

  /**
   * 文件名带空格：Obsidian 粘贴截图默认名就是 `Screenshot 2026-10-17 at 10.30.11.png`。
   * 占位协议曾经把原始路径直接塞进 markdown 的链接目标，空格把目标截断，
   * 整行退化成字面文本 `![a b.png](mv-image://300x/a b.png)`，图完全不显示。
   */
  it('文件名带空格时仍然渲染成真图片（占位路径整体转义）', async () => {
    const name = 'Screenshot 2026-10-17 at 10.30.11.png';
    const container = await renderPreview(`![[${name}|300]]`, { [name]: DATA_URL });
    const img = container.querySelector('.markdown-body img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe(DATA_URL);
    expect(img!.getAttribute('width')).toBe('300');
  });

  it('文件名带空格 + 子目录也照常解析', async () => {
    const name = 'fig/我的 图 1.png';
    const container = await renderPreview(`![[${name}]]`, { [name]: DATA_URL });
    expect(container.querySelector('.markdown-body img')!.getAttribute('src')).toBe(DATA_URL);
  });

  it('尺寸超上限时按上限算（笔误不撑破布局）', async () => {
    const container = await renderPreview('![[图.png|99999]]', { '图.png': DATA_URL });
    expect(container.querySelector('.markdown-body img')!.getAttribute('width')).toBe('4000');
  });

  it('|0 当作没写尺寸，不会把图设成 width=0 藏起来', async () => {
    const container = await renderPreview('![[图.png|0]]', { '图.png': DATA_URL });
    const img = container.querySelector('.markdown-body img')!;
    expect(img.getAttribute('width')).toBeNull();
  });

  it('标准 Markdown 图片找不到时明说缺图，不留破图', async () => {
    const container = await renderPreview('![](缺图.png)');
    expect(container.querySelector('.markdown-body img')).toBeNull();
    expect(container.querySelector('.mv-img-missing')?.textContent).toContain('图片未导入');
  });

  it('外部图片地址原样放过，不当作库内附件去找', async () => {
    const container = await renderPreview('![](https://example.com/a.png)');
    const img = container.querySelector('.markdown-body img');
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
  });
});

describe('标准 Markdown 图片的可选标题', () => {
  it('![](a.png "标题") 里的引号段不算路径', async () => {
    const container = await renderPreview('![](fig/a.png "示意图")', { 'fig/a.png': DATA_URL });
    expect(container.querySelector('.markdown-body img')!.getAttribute('src')).toBe(DATA_URL);
  });
});
