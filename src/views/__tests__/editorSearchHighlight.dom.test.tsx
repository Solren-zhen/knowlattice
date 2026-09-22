// @vitest-environment jsdom
/**
 * 「打开笔记后跳转 + 高亮命中」的 DOM 验收。
 *
 * 这是「一键搜索内容高亮」的后半截：光在结果列表里标黄只解决一半问题，
 * 点开之后还得把人带到命中处、并在正文里把**全部**命中标出来。
 *
 * 实测出来的机制（容易搞错，所以在这里写死）：
 *   · 可见高亮来自 highlightSelectionMatches —— 它以**当前选区**为查询。
 *     findNext 选中第一处后，其余同款命中被标成 .cm-selectionMatch；
 *     被选中的那一处由选区图层渲染，不在 .cm-selectionMatch 里。
 *   · 所以「命中 N 处」应看到 N-1 个 .cm-selectionMatch。若一次都没跳成
 *     （选区为空且不在词上），则一个都没有 —— 0 与 N-1 正好区分成功/失败。
 *   · .cm-searchMatch 在 @codemirror/search 里没有任何装饰使用它，别拿它断言。
 *
 * 另守 nonce 契约：effect 若依赖 value，用户每敲一个字都会被拽回第一处命中。
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import Editor from '../Editor';

// jsdom 没实现 scrollIntoView（CodeMirror 把选区滚进视口时会调）
Element.prototype.scrollIntoView = () => {};
// jsdom 也没实现 Range.getClientRects：CodeMirror 在编辑器获得焦点后会测字符宽度，
// 走到 measureTextSize → clientRectsFor → getClientRects，缺失时会在 rAF 里抛未捕获异常
// （测试仍通过，但 vitest 会因 unhandled error 判整个文件失败）。
// 返回空列表即可：CM 见 rects.length != 1 就直接放弃测量，正是我们要的。
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const DOC = [
  '# 氧解离曲线',
  '',
  '氧解离曲线右移表示血红蛋白对氧的亲和力降低，有利于放氧。',
  '',
  '再提一次：氧解离曲线是生理学高频考点。',
].join('\n');
/** 正文里一共 3 处「氧解离曲线」（含标题行） */
const TOTAL = 3;

async function setup(highlight: { query: string; nonce: number } | null) {
  const { container, rerender } = render(
    <Editor value={DOC} onChange={vi.fn()} highlight={highlight} />
  );
  await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), { timeout: 8000 });
  return { container, rerender };
}

/** 被标成命中的片段文本（不含被选区选中的那一处） */
const matches = (container: HTMLElement) =>
  [...container.querySelectorAll('.cm-selectionMatch')].map((n) => n.textContent ?? '');

/** 哪几行上出现了命中高亮（1 起）。用它区分「选中点在哪」—— */
/** 重跳会把选中点往前推，被选中的那一行就不再出现在这个列表里。 */
const hitLines = (container: HTMLElement): number[] =>
  [...container.querySelectorAll('.cm-line')]
    .map((n, i) => (n.querySelector('.cm-selectionMatch') ? i + 1 : 0))
    .filter((n) => n > 0);

describe('Editor 搜索命中跳转与高亮', () => {
  it('带命中词打开：跳到第一处，其余命中全部标出来', async () => {
    const { container } = await setup({ query: '氧解离曲线', nonce: 1 });

    await waitFor(() => {
      const m = matches(container);
      // 3 处命中 → 选中 1 处 + 高亮 2 处。若是 0，说明根本没跳成
      expect(m).toHaveLength(TOTAL - 1);
      expect(m.every((t) => t === '氧解离曲线')).toBe(true);
    });
    cleanup();
  }, 20000);

  it('不带命中词切到另一篇：不留下上一篇的搜索高亮', async () => {
    const { container, rerender } = await setup({ query: '氧解离曲线', nonce: 1 });
    await waitFor(() => expect(matches(container)).toHaveLength(TOTAL - 1));

    rerender(<Editor value={'# 心力衰竭\n\n心排血量下降，出现肺淤血。'} onChange={vi.fn()} highlight={null} />);
    await waitFor(() =>
      expect(container.querySelector('.cm-content')?.textContent).toContain('心力衰竭')
    );
    expect(matches(container).filter((t) => t === '氧解离曲线')).toEqual([]);
    cleanup();
  }, 20000);

  it('nonce 不变就不重跳；nonce 递增才重新定位', async () => {
    const { container, rerender } = await setup({ query: '氧解离曲线', nonce: 1 });
    // 选中第 1 行的命中 → 高亮落在第 3、5 行
    await waitFor(() => expect(hitLines(container)).toEqual([3, 5]));

    // ① 只改内容、nonce 不变 → effect 不重跑。
    //    CM 会把这次「整篇替换」规约成末尾插入（共同前缀被消掉），选区留在原处，
    //    所以选中点仍是第 1 行、高亮仍在 3/5 行。
    //    若 effect 重跑了，findNext 会从当前选区往后找，选中点滑到第 3 行 → 变成 [1, 5]。
    const edited = `${DOC}\n\n新加的一行。`;
    rerender(<Editor value={edited} onChange={vi.fn()} highlight={{ query: '氧解离曲线', nonce: 1 }} />);
    await waitFor(() =>
      expect(container.querySelector('.cm-content')?.textContent).toContain('新加的一行')
    );
    expect(hitLines(container)).toEqual([3, 5]);

    // ② 用户又搜了一次（nonce 递增）→ 真的重新定位，选中点前进到第 3 行
    rerender(<Editor value={edited} onChange={vi.fn()} highlight={{ query: '氧解离曲线', nonce: 2 }} />);
    await waitFor(() => expect(hitLines(container)).toEqual([1, 5]));
    cleanup();
  }, 20000);
});
