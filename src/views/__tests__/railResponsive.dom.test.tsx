// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Rail from '../Rail';

let narrowViewport = true;

function railProps(): ComponentProps<typeof Rail> {
  return {
    activeItem: null,
    treeOpen: false,
    onToggleTree: vi.fn(),
    onHome: vi.fn(),
    onSearch: vi.fn(),
    onHistory: vi.fn(),
    onAnatomy: vi.fn(),
    onBrain: vi.fn(),
    onGraph: vi.fn(),
    onReview: vi.fn(),
    onMistake: vi.fn(),
    onQuiz: vi.fn(),
    onTodo: vi.fn(),
    onTag: vi.fn(),
    onDash: vi.fn(),
    onAi: vi.fn(),
    onDraft: vi.fn(),
    onPdf: vi.fn(),
    onConvert: vi.fn(),
    onNotice: vi.fn(),
  };
}

describe('响应式导航抽屉', () => {
  beforeEach(() => {
    narrowViewport = true;
    localStorage.clear();
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: query === '(max-width: 1040px)' ? narrowViewport : !narrowViewport,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('窄屏忽略桌面展开偏好；菜单钮可打开，点遮罩关闭且不改偏好', () => {
    localStorage.setItem('knowlattice-rail-expanded', 'true');
    const { container } = render(<Rail {...railProps()} />);
    const rail = container.querySelector('.rail')!;

    expect(rail.classList.contains('rail--expanded')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    expect(rail.classList.contains('rail--expanded')).toBe(true);
    expect(screen.getByRole('button', { name: '关闭导航' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(rail);
    expect(rail.classList.contains('rail--expanded')).toBe(false);
    expect(localStorage.getItem('knowlattice-rail-expanded')).toBe('true');
  });

  it('窄屏选择入口会收起抽屉，Escape 会关闭并把焦点还给菜单钮', () => {
    const props = railProps();
    const { container } = render(<Rail {...props} />);
    const rail = container.querySelector('.rail')!;

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }));
    expect(props.onAi).toHaveBeenCalledOnce();
    expect(rail.classList.contains('rail--expanded')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(rail.classList.contains('rail--expanded')).toBe(false);
    expect(screen.getByRole('button', { name: '打开导航' })).toBe(document.activeElement);
  });

  it('桌面继续使用并更新持久化的展开偏好', () => {
    narrowViewport = false;
    localStorage.setItem('knowlattice-rail-expanded', 'true');
    const { container } = render(<Rail {...railProps()} />);
    const rail = container.querySelector('.rail')!;

    expect(rail.classList.contains('rail--expanded')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '收起导航标签' }));
    expect(rail.classList.contains('rail--expanded')).toBe(false);
    expect(localStorage.getItem('knowlattice-rail-expanded')).toBe('false');
  });
});
