// @vitest-environment jsdom
/**
 * 右侧预览 / 复习卡里的 Callout 与 Obsidian 注释。
 * 现状（改之前）：`> [!warning] 网络问题` 渲染成一条普通引用，类型与标题全丢；
 * `%%私密备注%%` 会被我们内部的属性键占位符（同样是 %%…%%）吃掉，渲染成加粗。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import Preview from '../Preview';

afterEach(() => cleanup());

async function renderPreview(content: string) {
  const { container } = render(<Preview content={content} />);
  await waitFor(
    () => expect(container.querySelector('.markdown-body')?.innerHTML ?? '').not.toBe(''),
    { timeout: 5000 }
  );
  return container;
}

describe('Callout', () => {
  it('> [!warning] 标题 → 带类型与标题的提示块，正文仍在块里', async () => {
    const c = await renderPreview('> [!warning] 网络问题\n> 断开代理再试一次。\n');
    const box = c.querySelector('.markdown-body .mv-callout')!;
    expect(box.className).toContain('mv-callout-warning');
    expect(box.querySelector('.mv-callout-title')?.textContent).toBe('注意：网络问题');
    expect(box.querySelector('.mv-callout-body')?.textContent).toContain('断开代理再试一次。');
  });

  it('没有自定义标题时用类型的默认名', async () => {
    const c = await renderPreview('> [!question]- 为什么图像用 512 维？\n');
    const title = c.querySelector('.mv-callout-title')!;
    expect(c.querySelector('.mv-callout')?.className).toContain('mv-callout-question');
    // 标题文字来自 `[!question]- 为什么…`；`-` 是折叠标记，会被吃掉并换成箭头图标，
    // 所以这里比对 textContent 时要容得下箭头（见下面「折叠提示块」一组的断言）。
    expect(title.textContent).toContain('问题：为什么图像用 512 维？');
  });

  it('没收录的类型不编造名字，走默认配色', async () => {
    const c = await renderPreview('> [!bug-report] 顺手上报\n> 复现步骤见下。\n');
    expect(c.querySelector('.mv-callout')?.className).toContain('mv-callout-default');
    expect(c.querySelector('.mv-callout-title')?.textContent).toBe('bug-report：顺手上报');
  });

  it('普通引用不受影响（不套 callout 样式）', async () => {
    const c = await renderPreview('> 这是一句普通引用\n');
    expect(c.querySelector('.mv-callout')).toBeNull();
    expect(c.querySelector('blockquote')?.textContent).toContain('普通引用');
  });
});

describe('Obsidian 注释 %%…%%', () => {
  it('注释不出现在正文里（与 Obsidian 的 reading 视图一致）', async () => {
    const c = await renderPreview('# 标题\n\n%%这段是给自己看的私密备注%%\n\n正文。\n');
    const body = c.querySelector('.markdown-body')!.textContent ?? '';
    expect(body).toContain('正文。');
    expect(body).not.toContain('私密备注');
  });

  it('属性键的加粗仍然生效（内部占位符已换成私有区字符，不再和 %% 打架）', async () => {
    const c = await renderPreview('- 定义: 肺扩张引起吸气抑制的负反馈。\n');
    expect(c.querySelector('.prop-key')?.textContent).toBe('定义');
  });
});

describe('折叠提示块 `-` / `+`', () => {
  it('`-` 默认收起，`+` 默认展开，都带可点的标题与箭头', async () => {
    const closed = await renderPreview('> [!question]- 答案\n> 应该是 A\n');
    const box = closed.querySelector('.mv-callout')!;
    expect(box.className).toContain('mv-callout--fold');
    expect(box.className).toContain('mv-callout--collapsed');
    expect(box.querySelector('.mv-callout-chevron')).toBeTruthy();

    const open = await renderPreview('> [!question]+ 答案\n> 应该是 A\n');
    const box2 = open.querySelector('.mv-callout')!;
    expect(box2.className).toContain('mv-callout--fold');
    expect(box2.className).not.toContain('mv-callout--collapsed');
  });

  it('没有折叠标记的块不带折叠类，标题也不可点', async () => {
    const c = await renderPreview('> [!note] 普通\n> 正文\n');
    const box = c.querySelector('.mv-callout')!;
    expect(box.className).not.toContain('mv-callout--fold');
    expect(box.querySelector('.mv-callout-chevron')).toBeNull();
  });

  it('点标题切换开合；点正文不会误收', async () => {
    const c = await renderPreview('> [!question]- 答案\n> 正文在块里\n');
    const box = c.querySelector('.mv-callout') as HTMLElement;
    const title = box.querySelector('.mv-callout-title') as HTMLElement;
    const body = box.querySelector('.mv-callout-body') as HTMLElement;
    expect(box.className).toContain('mv-callout--collapsed');
    title.click();
    expect(box.className).not.toContain('mv-callout--collapsed');
    title.click();
    expect(box.className).toContain('mv-callout--collapsed');
    body.click();
    expect(box.className).toContain('mv-callout--collapsed');
  });
});

describe('Obsidian 多行注释 %%…%%', () => {
  it('跨行的整段注释也隐藏（`%%` 不跟着漏出来）', async () => {
    const c = await renderPreview('甲\n\n%%\n隐藏一\n隐藏二\n%%\n\n乙\n');
    const body = c.querySelector('.markdown-body')!.textContent ?? '';
    expect(body).toContain('甲');
    expect(body).toContain('乙');
    expect(body).not.toContain('隐藏一');
    expect(body).not.toContain('%%');
  });

  it('未闭合的 %% 不吞掉后面的正文', async () => {
    const c = await renderPreview('甲 %% 未闭合 乙\n');
    expect(c.querySelector('.markdown-body')!.textContent).toContain('乙');
  });
});

describe('Callout 结构细节', () => {
  it('正文首行不多一个空行（breaks:true 产生的 <br> 已被标题吃掉）', async () => {
    const c = await renderPreview('> [!warning] 断网\n> 第一行\n> 第二行\n');
    const body = c.querySelector('.mv-callout-body')!;
    // 直接以第一行文字开头，而不是以 <br> 开头
    expect(body.innerHTML.startsWith('第一行')).toBe(true);
    expect(body.textContent).toBe('第一行第二行');
  });

  it('标题里的行内格式（加粗 / 双链）留在标题里，不漏进正文', async () => {
    const c = await renderPreview('> [!tip] **重要**：见 [[心脏]]\n> 正文\n');
    const title = c.querySelector('.mv-callout-title')!;
    expect(title.querySelector('strong')?.textContent).toBe('重要');
    expect(title.querySelector('.wikilink')?.getAttribute('data-mv-target')).toBe('心脏');
    expect(title.textContent).toContain('提示：重要：见 心脏');
    expect(c.querySelector('.mv-callout-body')?.textContent).toBe('正文');
  });

  it('空行分隔的正文：第二段仍在提示块内（折叠时由 CSS 一并收起）', async () => {
    const c = await renderPreview('> [!note]- 标题\n> 甲\n>\n> 乙\n');
    const box = c.querySelector('.mv-callout')!;
    expect(box.querySelector('.mv-callout-body')?.textContent).toBe('甲');
    const siblings = [...box.children].map((el) => el.textContent);
    expect(siblings).toEqual(['笔记：标题▾', '甲', '乙']);
  });
});

describe('折叠提示块的无障碍', () => {
  it('可折叠标题是 role=button，aria-expanded 与开合状态一致', async () => {
    const closed = await renderPreview('> [!question]- 答案\n> 应该是 A\n');
    const t1 = closed.querySelector('.mv-callout-title')!;
    expect(t1.getAttribute('role')).toBe('button');
    expect(t1.getAttribute('tabindex')).toBe('0');
    expect(t1.getAttribute('aria-expanded')).toBe('false');

    const open = await renderPreview('> [!question]+ 答案\n> 应该是 A\n');
    expect(open.querySelector('.mv-callout-title')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('不可折叠的标题不冒充按钮', async () => {
    const c = await renderPreview('> [!note] 普通\n> 正文\n');
    const t = c.querySelector('.mv-callout-title')!;
    expect(t.getAttribute('role')).toBeNull();
    expect(t.getAttribute('tabindex')).toBeNull();
    expect(t.getAttribute('aria-expanded')).toBeNull();
  });

  it('键盘 Enter / 空格都能开合，并同步 aria-expanded', async () => {
    const c = await renderPreview('> [!question]- 答案\n> 应该是 A\n');
    const box = c.querySelector('.mv-callout') as HTMLElement;
    const title = box.querySelector('.mv-callout-title') as HTMLElement;

    expect(box.className).toContain('mv-callout--collapsed');
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(box.className).not.toContain('mv-callout--collapsed');
    expect(title.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(title, { key: ' ' });
    expect(box.className).toContain('mv-callout--collapsed');
    expect(title.getAttribute('aria-expanded')).toBe('false');
  });

  it('焦点在正文链接上时空格不被折叠抢走', async () => {
    const c = await renderPreview('> [!question]- 答案\n> 见 [[心脏]]\n');
    const box = c.querySelector('.mv-callout') as HTMLElement;
    const link = box.querySelector('.mv-callout-body .wikilink') as HTMLElement;
    fireEvent.keyDown(link, { key: ' ' });
    expect(box.className).toContain('mv-callout--collapsed'); // 仍保持收起
  });
});
