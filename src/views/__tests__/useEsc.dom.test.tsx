// @vitest-environment jsdom
/**
 * useEsc / escThenClose 的 DOM 行为测试。
 * 重点是两条设计决定：①按**打开顺序**出栈（后挂载的在上），重渲染不能把某一层顶到栈顶；
 * ②「关闭会丢草稿」的面板里，焦点在输入框时 Esc 只退出输入框，再按一次才关。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEsc, escThenClose } from '../useEsc';
import { resetEscStack } from '../../core/escStack';

afterEach(() => {
  cleanup();
  resetEscStack();
});

function Plain({ onClose, enabled = true }: { onClose: () => void; enabled?: boolean }) {
  useEsc(onClose, enabled);
  return <div>plain</div>;
}

function Guarded({ onClose }: { onClose: () => void }) {
  useEsc(escThenClose(onClose));
  return <input aria-label="输入" />;
}

const esc = () => fireEvent.keyDown(window, { key: 'Escape' });

describe('useEsc', () => {
  it('Esc 触发回调', () => {
    const onClose = vi.fn();
    render(<Plain onClose={onClose} />);
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 时不占栈位（常挂面板用 open 控制）', () => {
    const onClose = vi.fn();
    render(<Plain onClose={onClose} enabled={false} />);
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('两个面板同时打开时只有后打开的那个响应', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(<Plain onClose={outer} />);
    render(<Plain onClose={inner} />);

    esc();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('重渲染不会把自己顶到栈顶（顺序由打开顺序决定）', () => {
    const outer = vi.fn();
    const first = render(<Plain onClose={outer} />);
    const inner = vi.fn();
    render(<Plain onClose={inner} />);

    // 外层带着**新的**回调重渲染：若每次渲染都重新入栈，它就会跑到栈顶
    first.rerender(<Plain onClose={() => outer()} />);

    esc();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('重渲染后调用的是最新回调（ref 转发）', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Plain onClose={first} />);
    view.rerender(<Plain onClose={second} />);

    esc();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('escThenClose', () => {
  it('事件来自输入框时：第一次只退出输入框，第二次才关面板', () => {
    const onClose = vi.fn();
    render(<Guarded onClose={onClose} />);
    const input = screen.getByLabelText('输入') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);

    esc(); // 焦点已不在输入框上，这一次才关
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('事件不来自输入框时直接关面板', () => {
    const onClose = vi.fn();
    render(<Guarded onClose={onClose} />);
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
