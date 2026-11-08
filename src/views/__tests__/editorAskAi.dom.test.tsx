// @vitest-environment jsdom
/**
 * 「编辑器选中 → 右键 → 问 AI」这条链路的 DOM 验收。
 *
 * 为什么单独立一个文件：AiAgentPanel 的测试是**直接传 quote prop** 的，
 * 只证明了「面板拿到 quote 会显示并附进上下文」。而用户实际点的是编辑器右键菜单，
 * 中间还隔着 Editor 的 selText 同步 + Workspace 的桥接。这两段此前没有任何覆盖。
 *
 * 判据（缺一不可）：
 *   1. 没有选区时右键不该弹菜单（交回系统菜单）；
 *   2. 有选区时菜单里能点到「问 AI」，且回调收到的**正是选中的那段文字**；
 *   3. 选区换成另一段后，回调要跟着换 —— 这一条专门守 selText 陈旧值。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import Editor from '../Editor';

// jsdom 缺的几样：CodeMirror 会调，缺了会在 rAF 里抛未捕获异常（判整个文件失败）
Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const DOC = ['# 心肌', '', '心肌收缩泵血，舒张充盈。', '', '心率加快时舒张期缩短。'].join('\n');

/** 渲染 Editor 并取出 CodeMirror 视图（测试里要靠它造真实选区） */
async function setup(onAskAi: (text: string) => void) {
  const { container } = render(<Editor value={DOC} onChange={vi.fn()} onAskAi={onAskAi} />);
  await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), { timeout: 8000 });
  const content = container.querySelector<HTMLElement>('.cm-content')!;
  const view = EditorView.findFromDOM(content);
  expect(view).toBeTruthy();
  return { container, content, view: view! };
}

/** 在正文里按子串定位并造一个真实选区 */
function select(view: EditorView, needle: string) {
  const doc = view.state.doc.toString();
  const from = doc.indexOf(needle);
  expect(from).toBeGreaterThanOrEqual(0);
  view.dispatch({ selection: { anchor: from, head: from + needle.length } });
}

/** 右键点开菜单（CM 的事件处理器挂在 content 上） */
function openMenu(content: HTMLElement) {
  fireEvent.contextMenu(content, { clientX: 40, clientY: 60, button: 2 });
}

describe('编辑器「问 AI」：选中文字必须原样带到面板', () => {
  it('没有选区时右键不弹菜单', async () => {
    const { container, content, view } = await setup(vi.fn());
    view.dispatch({ selection: { anchor: 0 } });
    openMenu(content);
    // 给 React 一拍时间；菜单不该出现
    await new Promise((r) => setTimeout(r, 60));
    expect(container.querySelector('.cm-ctx-menu')).toBeNull();
  }, 20000);

  it('选中文字 → 右键 → 问 AI：回调收到的正是那段文字', async () => {
    const onAskAi = vi.fn();
    const { container, content, view } = await setup(onAskAi);
    select(view, '心肌收缩泵血');
    openMenu(content);

    await waitFor(() => expect(container.querySelector('.cm-ctx-menu')).toBeTruthy(), { timeout: 8000 });
    const item = screen.getByText(/问 AI/).closest('button')!;
    fireEvent.click(item);

    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(onAskAi.mock.calls[0][0]).toBe('心肌收缩泵血');
  }, 20000);

  it('换一段选区再问：不能把上一次的文字再交一遍（selText 陈旧值）', async () => {
    const onAskAi = vi.fn();
    const { container, content, view } = await setup(onAskAi);

    select(view, '心肌收缩泵血');
    openMenu(content);
    await waitFor(() => expect(container.querySelector('.cm-ctx-menu')).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByText(/问 AI/).closest('button')!);

    select(view, '舒张充盈');
    openMenu(content);
    await waitFor(() => expect(container.querySelector('.cm-ctx-menu')).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByText(/问 AI/).closest('button')!);

    expect(onAskAi).toHaveBeenCalledTimes(2);
    expect(onAskAi.mock.calls[0][0]).toBe('心肌收缩泵血');
    expect(onAskAi.mock.calls[1][0]).toBe('舒张充盈');
  }, 20000);
});
