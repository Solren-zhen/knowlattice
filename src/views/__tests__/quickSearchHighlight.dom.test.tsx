// @vitest-environment jsdom
/**
 * 「一键搜索内容高亮」的 DOM 验收。
 *
 * 背景：搜索面板此前**没有任何高亮**，而且片段定位是错的——旧 snippet() 用
 * `body.indexOf(q[0])` 只拿查询的第一个字符去找。搜「氧解离曲线」时，
 * 正文里第一个「氧」出现在开头，片段就永远截在开头那段无关内容上。
 *
 * 这个文件守三件事：
 *  ① 结果列表里命中词真的渲染成 <mark>；
 *  ② 片段定位到**完整命中**，不是首字符；
 *  ③ 点开笔记时把命中词传给上层（编辑器据此跳转 + 高亮全部命中）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickSearch from '../QuickSearch';

// jsdom 没实现 scrollIntoView：结果列表在选中项变化时会调它把高亮条滚进视口
Element.prototype.scrollIntoView = () => {};

const DOCS = new Map<string, string>([
  ['生理/氧解离曲线.md', `---
aliases: [氧离曲线]
tags: [生理]
---
氧气在血液里靠血红蛋白运输，这一段和查询无关。
真正要讲的是氧解离曲线的右移，以及它的临床意义。`],
  ['内科/心肌梗死.md', `---
aliases: [心梗]
---
急性心肌梗死的典型表现是持续性胸痛。`],
  ['其他/无关笔记.md', '这篇笔记讲的是别的内容。'],
]);

afterEach(cleanup);

function setup() {
  const onOpenPath = vi.fn();
  const onClose = vi.fn();
  render(
    <QuickSearch open docs={DOCS} recents={[]} onClose={onClose} onOpenPath={onOpenPath} />
  );
  return { onOpenPath, onClose };
}

const type = (text: string) =>
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });

const items = () => [...document.querySelectorAll('.qs-item')] as HTMLElement[];

describe('QuickSearch 内容高亮', () => {
  it('命中词渲染成 <mark>，且片段定位到完整命中而非首字符', async () => {
    setup();
    type('氧解离曲线');

    // 标题与片段各有一处命中，所以是 findAll（这本身就是「多处都高亮」的证据）
    const marks = await screen.findAllByText('氧解离曲线', { selector: 'mark' });
    expect(marks.length).toBeGreaterThanOrEqual(2);

    // 片段里必须出现完整命中，并且带着后面的上下文——旧实现会截在开头那段
    const snip = document.querySelector('.qs-snippet')!;
    expect(snip.textContent).toContain('氧解离曲线');
    expect(snip.textContent).toContain('右移');
    expect(snip.querySelector('mark')?.textContent).toBe('氧解离曲线');
  });

  it('语义近似：搜「心梗」也能高亮出「心肌梗死」', async () => {
    setup();
    type('心梗');

    await waitFor(() => {
      const titles = items().map((n) => n.querySelector('.qs-title')?.textContent ?? '');
      expect(titles.some((t) => t.includes('心肌梗死'))).toBe(true);
    });
    const marked = [...document.querySelectorAll('.qs-mark')].map((n) => n.textContent ?? '');
    expect(marked.some((m) => m.includes('心肌梗死') || m.includes('心梗'))).toBe(true);
  });

  it('frontmatter 不进片段（别把 aliases 那一坨显示给用户）', async () => {
    setup();
    type('氧解离曲线');
    await screen.findAllByText('氧解离曲线', { selector: 'mark' });
    expect(document.querySelector('.qs-snippet')!.textContent).not.toContain('aliases');
  });

  it('无关查询不渲染结果', async () => {
    setup();
    type('量子色动力学');
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(document.querySelector('.qs-empty')).toBeTruthy();
  });
});

describe('QuickSearch 打开笔记时带上命中词', () => {
  it('点结果 → onOpenPath(路径, 命中词)，并关闭面板', async () => {
    const { onOpenPath, onClose } = setup();
    type('氧解离曲线');

    await waitFor(() => {
      const first = items()[0];
      expect(first?.querySelector('.qs-title')?.textContent).toContain('氧解离曲线');
    });
    fireEvent.click(items()[0]);

    expect(onOpenPath).toHaveBeenCalledWith('生理/氧解离曲线.md', '氧解离曲线');
    expect(onClose).toHaveBeenCalled();
  });

  it('空查询（最近打开）打开笔记时不带命中词', async () => {
    const { onOpenPath } = setup();
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    fireEvent.click(items()[0]);
    expect(onOpenPath).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
