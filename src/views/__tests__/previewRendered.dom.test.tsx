// @vitest-environment jsdom
/**
 * Preview 的 onRendered 契约：正文（异步 markdown 渲染）完成后必须回调一次。
 * 结构笔记卡片靠它按真实高度重算落位——线上「长笔记卡片不显示内容」就出在这个信号缺失。
 * 同时守住：渲染失败也要回调（否则宿主永远停在骨架位置）+ 不抛未处理拒绝。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import Preview from '../Preview';

afterEach(() => cleanup());

describe('Preview onRendered', () => {
  it('正文渲染完成后回调一次，且回调时正文已就位', async () => {
    let htmlWhenCalled = '';
    const onRendered = vi.fn(() => {
      htmlWhenCalled = document.querySelector('.markdown-body')?.innerHTML ?? '';
    });
    render(<Preview content={'# 标题\n\n- 要点一\n- 要点二'} onRendered={onRendered} />);
    await waitFor(() => expect(onRendered).toHaveBeenCalled(), { timeout: 5000 });
    // 回调发生在 setHtml 之后（React 提交完成）→ 宿主读到的 offsetHeight 已是最终高度
    expect(htmlWhenCalled).toContain('标题');
  });

  it('长笔记也回调，且正文完整渲染', async () => {
    const long = ['# 长笔记', ...Array.from({ length: 100 }, (_, i) => `- 要点 ${i + 1}：一段较长的解剖学笔记内容。`)].join('\n');
    const onRendered = vi.fn();
    const { container } = render(<Preview content={long} onRendered={onRendered} />);
    await waitFor(() => expect(onRendered).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => {
      expect(container.querySelector('.markdown-body')?.textContent).toContain('要点 100');
    });
  });

  it('content 为 null（空态）时不消费 onRendered，也不崩', () => {
    const onRendered = vi.fn();
    const { container } = render(<Preview content={null} onRendered={onRendered} />);
    expect(container.querySelector('.placeholder')).toBeTruthy();
    expect(onRendered).not.toHaveBeenCalled();
  });
});
