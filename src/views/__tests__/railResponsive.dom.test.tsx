// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Rail from '../Rail';
import type { RailKey } from '../railCatalog';

let narrowViewport = true;

function railProps(): ComponentProps<typeof Rail> {
  const actions = {
    tree: vi.fn(), search: vi.fn(), quiz: vi.fn(), review: vi.fn(), mistakes: vi.fn(),
    report: vi.fn(), todos: vi.fn(), graph: vi.fn(), anatomy: vi.fn(), brain: vi.fn(),
    mind: vi.fn(), pathway: vi.fn(), tags: vi.fn(), medref: vi.fn(), import: vi.fn(),
    pdf: vi.fn(), convert: vi.fn(), history: vi.fn(), notice: vi.fn(), ai: vi.fn(),
    video: vi.fn(), settings: vi.fn(),
  } satisfies Record<RailKey, () => void>;
  return { activeItem: null, treeOpen: false, onHome: vi.fn(), actions };
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
    // 窄屏没有悬停：点母主题在该组下方原地展开，再点条目
    fireEvent.click(screen.getByRole('button', { name: '学习' }));
    expect(screen.getByRole('button', { name: '学习' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '题库练习' }));
    expect(props.actions.quiz).toHaveBeenCalledOnce();
    expect(rail.classList.contains('rail--expanded')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(rail.classList.contains('rail--expanded')).toBe(false);
    expect(screen.getByRole('button', { name: '打开导航' })).toBe(document.activeElement);
  });

  it('两态都是同样五个母主题，展开态点母主题在轨上摊开该组（手风琴），再点收起', () => {
    narrowViewport = false;
    localStorage.setItem('knowlattice-rail-expanded', 'false');
    const props = railProps();
    const { container } = render(<Rail {...props} />);
    const titles = ['工作区', '学习', '资料', '工具', '系统'];

    // 收起态：五个母主题，条目一个都不在轨上
    expect(container.querySelectorAll('.rail-group-btn')).toHaveLength(5);
    expect(container.querySelectorAll('.rail-branch-item')).toHaveLength(0);
    for (const title of titles) expect(screen.getByRole('button', { name: title })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '展开导航标签' }));
    // 展开态：还是这五个（数量不变才是「两态一致」），只是带上了文字标签；
    // 另外把「当前所在的那一组」摊在轨上（这里没有当前项，所以摊的是工作区）
    expect(container.querySelectorAll('.rail-group-btn')).toHaveLength(5);
    expect(Array.from(container.querySelectorAll('.rail-inline .rail-btn')).map((el) => el.textContent))
      .toEqual(['目录', '搜索']);
    for (const title of titles) expect(screen.getByRole('button', { name: title })).toBeTruthy();

    // 点母主题在轨上摊开该组（手风琴），不浮层；可以同时摊开多组
    fireEvent.click(screen.getByRole('button', { name: '学习' }));
    expect(container.querySelector('.rail-branch')).toBeNull();
    const inlineLabels = () => Array.from(container.querySelectorAll('.rail-inline .rail-btn')).map((el) => el.getAttribute('aria-label'));
    expect(inlineLabels()).toEqual(['目录', '搜索', '题库练习', '间隔复习', 'AI 助手', '视频笔记', '错题本', '学习报告', '待办']);
    expect(props.actions.todos).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '待办' }));
    expect(props.actions.todos).toHaveBeenCalledOnce();
    // 选完条目组不自动收——手风琴的开合是用户自己的选择
    expect(inlineLabels()).toContain('待办');

    // 再点一次母主题是开关：开→关
    fireEvent.click(screen.getByRole('button', { name: '系统' }));
    expect(inlineLabels()).toContain('设置');
    fireEvent.click(screen.getByRole('button', { name: '系统' }));
    expect(inlineLabels()).not.toContain('设置');
    expect(inlineLabels()).toContain('目录');

    // 已下架的两项不再占轨道（仍能用命令面板/笔记工具条打开）
    expect(container.textContent).not.toContain('思维导图');
    expect(container.textContent).not.toContain('PDF 拆分');
  });

  it('母主题自带状态：收起态报组内位置，展开态摊开当前组，键盘能走进去', async () => {
    narrowViewport = false;
    localStorage.setItem('knowlattice-rail-expanded', 'false');
    const props = { ...railProps(), activeItem: 'quiz' as RailKey };
    const { container } = render(<Rail {...props} />);

    // 收起态：学习组的 7 个条目压成 7 个点，当前那一项是一小段横线
    const learn = screen.getByRole('button', { name: '学习' });
    expect(learn.querySelectorAll('.rail-group-dots i')).toHaveLength(7);
    expect(learn.querySelector('.rail-group-dots i.on')).toBeTruthy();
    // 没在当前组的母主题也报得出条目数（只是没有实心点）
    const system = screen.getByRole('button', { name: '系统' });
    expect(system.querySelectorAll('.rail-group-dots i')).toHaveLength(2);
    expect(system.querySelector('.rail-group-dots i.on')).toBeNull();

    // 展开态：当前所在的「学习」组直接把 6 个条目摊在轨上——要用的东西不用先悬停才出现
    fireEvent.click(screen.getByRole('button', { name: '展开导航标签' }));
    const inline = container.querySelector('.rail-inline')!;
    expect(Array.from(inline.querySelectorAll('.rail-btn')).map((el) => el.textContent))
      .toEqual(['题库练习', '间隔复习', 'AI 助手', '视频笔记', '错题本', '学习报告', '待办']);
    expect(inline.querySelector('.rail-btn.on')?.textContent).toBe('题库练习');

    // 再点母主题是收起这一组（不再有「已经在眼前就不浮层」的特例，开合完全由用户决定）
    fireEvent.click(screen.getByRole('button', { name: '学习' }));
    expect(container.querySelector('.rail-branch')).toBeNull();
    expect(container.querySelector('.rail-inline')).toBeNull();

    // 键盘 ↓ 摊开该组并把焦点送到第一条（系统组没有当前项，落「设置」）
    fireEvent.keyDown(screen.getByRole('button', { name: '系统' }), { key: 'ArrowDown' });
    const systemBox = await waitFor(() => {
      const box = container.querySelector('.rail-inline');
      expect(box?.getAttribute('aria-label')).toBe('系统');
      return box as HTMLElement;
    });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('设置'));

    // 组内 ↑↓ / Home / End 走，↑ 到顶退回母按钮，Esc 收起
    fireEvent.keyDown(systemBox, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('安全与隐私');
    fireEvent.keyDown(systemBox, { key: 'Home' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('设置');
    fireEvent.keyDown(systemBox, { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('安全与隐私');
    fireEvent.keyDown(systemBox, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('设置');
    fireEvent.keyDown(systemBox, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('系统');
    fireEvent.keyDown(systemBox, { key: 'Escape' });
    expect(container.querySelector('.rail-inline')).toBeNull();
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
