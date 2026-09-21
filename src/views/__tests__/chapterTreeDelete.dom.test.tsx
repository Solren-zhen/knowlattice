// @vitest-environment jsdom
/**
 * 目录树的「独立删除入口」DOM 测试（2026-09-20 补）。
 *
 * 背景（用户反馈）：目录里只能找到「批量删除」——要删单独一篇，得先开批量模式勾选，
 * 或者先打开这篇笔记再从编辑器头部的垃圾桶删。现在每行笔记右侧常驻一个低对比垃圾桶，
 * 点了弹确认框，确认后只删这一篇。
 *
 * 重点守两件事：①点垃圾桶**不会顺手打开笔记**（删除键是行的兄弟节点，不是子节点）；
 * ②批量模式下不显示它，免得和勾选框混淆。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChapterTree from '../ChapterTree';
import type { TreeNode } from '../../core/vault';

// jsdom 没有 ResizeObserver：树靠它更新视口高度（不 stub 就用默认的 600px 视口）
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const PATH = '01-生理/肺牵张反射.md';
const tree: TreeNode[] = [{ name: '肺牵张反射.md', path: PATH, type: 'file' }];

/** 等确认框的 Promise.then 跑完（resolve 后的回调在微任务里） */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cleanup();
  document.querySelectorAll('.mv-confirm-overlay').forEach((n) => n.remove());
});

function setup() {
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  render(
    <ChapterTree
      tree={tree}
      currentPath={null}
      onOpen={onOpen}
      onCreate={vi.fn()}
      onExport={vi.fn(async () => {})}
      onExportFolder={vi.fn(async () => 0)}
      onImport={vi.fn(async () => ({ ok: 0, failed: 0 }))}
      onImportMd={vi.fn(async () => ({ ok: 0, failed: 0 }))}
      onRemove={onRemove}
    />,
  );
  return { onOpen, onRemove };
}

const trash = () => screen.getByRole('button', { name: '删除笔记：肺牵张反射' });

describe('目录树 · 单篇删除入口', () => {
  it('每篇笔记都有独立删除入口', () => {
    setup();
    expect(trash()).toBeTruthy();
  });

  it('点垃圾桶 → 弹确认框 → 确认后只删这一篇，且不会顺手打开笔记', async () => {
    const { onOpen, onRemove } = setup();

    fireEvent.click(trash());
    const ok = document.querySelector('.mv-confirm-ok') as HTMLElement | null;
    expect(ok).toBeTruthy();
    expect(document.querySelector('.mv-confirm-title')?.textContent).toContain('肺牵张反射');

    fireEvent.click(ok!);
    await flush();

    expect(onRemove).toHaveBeenCalledWith([PATH]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('取消则什么都不删', async () => {
    const { onRemove } = setup();

    fireEvent.click(trash());
    fireEvent.click(document.querySelector('.mv-confirm-cancel') as HTMLElement);
    await flush();

    expect(onRemove).not.toHaveBeenCalled();
  });

  it('批量模式下不显示行内垃圾桶', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('批量删除'));

    expect(screen.queryByRole('button', { name: '删除笔记：肺牵张反射' })).toBeNull();
    expect(screen.getByText('删除')).toBeTruthy(); // 批量操作条上的删除按钮
  });
});

describe('目录树 · 右键整篇笔记', () => {
  it('右键一行弹出菜单，菜单里有「删除整篇笔记」', () => {
    setup();

    fireEvent.contextMenu(screen.getByRole('button', { name: '打开笔记：肺牵张反射' }), { clientX: 120, clientY: 200 });

    expect(screen.getByRole('menu', { name: '笔记操作：肺牵张反射' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除整篇笔记' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '打开笔记' })).toBeTruthy();
  });

  it('菜单里确认删除 → 删掉整篇，且不会顺手打开笔记', async () => {
    const { onOpen, onRemove } = setup();

    fireEvent.contextMenu(screen.getByRole('button', { name: '打开笔记：肺牵张反射' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除整篇笔记' }));
    fireEvent.click(document.querySelector('.mv-confirm-ok') as HTMLElement);
    await flush();

    expect(onRemove).toHaveBeenCalledWith([PATH]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('菜单里选「打开笔记」则只打开、不删', () => {
    const { onOpen, onRemove } = setup();

    fireEvent.contextMenu(screen.getByRole('button', { name: '打开笔记：肺牵张反射' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '打开笔记' }));

    expect(onOpen).toHaveBeenCalledWith(PATH);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('Esc 关掉菜单（走全局 Esc 栈，一次只退一层）', () => {
    setup();

    fireEvent.contextMenu(screen.getByRole('button', { name: '打开笔记：肺牵张反射' }));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('批量模式下右键不出菜单（那时右键不该抢勾选）', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('批量删除'));
    fireEvent.contextMenu(screen.getByRole('button', { name: '选择：肺牵张反射' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
