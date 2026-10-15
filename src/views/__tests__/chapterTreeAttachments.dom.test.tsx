// @vitest-environment jsdom
/**
 * 目录树 ⋯ 菜单的「清理未引用的附件」（用户选的方案 c：只列清单 + 确认后删，不改删笔记的语义）。
 *
 * 守三件事：
 *   ① 两个回调**都传了**才出现（不传就当作没这个功能，旧调用方与旧测试不受影响）；
 *   ② 顺序必须是「先算清单 → 用户确认 → 才真删」：确认之前 `onRemoveAttachments` 一次都不能被调——
 *      未引用判定再保守，也挡不住「列完就地删」这种写法把还被人用的图带走；
 *   ③ 清单只显示前 8 个，但**删的是全部**（显示截断不能变成动作截断），没孤儿时不弹确认框。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChapterTree from '../ChapterTree';
import type { TreeNode } from '../../core/vault';

// jsdom 没有 ResizeObserver：树靠它更新视口高度
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const PATH = '01-生理/肺牵张反射.md';
const tree: TreeNode[] = [{ name: '肺牵张反射.md', path: PATH, type: 'file' }];
const ITEM = '清理未引用的附件…';

/** 等确认框/异步回调跑完（Promise.then 在微任务里，toast 之后立刻断言会读到旧内容） */
const flush = () => new Promise((r) => setTimeout(r, 0));
const overlay = () => document.querySelector('.mv-confirm-overlay');
const toastText = () => document.querySelector('.mv-toast-host')?.textContent ?? '';

afterEach(() => {
  cleanup();
  document.querySelectorAll('.mv-confirm-overlay').forEach((n) => n.remove());
  // toast 宿主是模块级单例：只能清空内容，不能删节点（否则后续 toast 挂到脱离文档的节点上）
  document.querySelector('.mv-toast-host')?.replaceChildren();
});

function setup(
  orphans: string[] | null,
  fail: string[] = [],
  /** 需要控制「扫描还没返回」的时序时，用这个替掉默认实现（连点测试要用） */
  findOverride?: () => Promise<{ orphans: string[]; referenced: number; total: number }>,
) {
  const onFindOrphanAttachments = findOverride ?? (orphans
    ? vi.fn(async () => ({ orphans, referenced: 1, total: orphans.length + 1 }))
    : undefined);
  const onRemoveAttachments = orphans
    ? vi.fn(async (paths: string[]) => ({ removed: paths.length - fail.length, failed: fail }))
    : undefined;
  render(
    <ChapterTree
      tree={tree}
      currentPath={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onExport={vi.fn(async () => {})}
      onExportFolder={vi.fn(async () => 0)}
      onImport={vi.fn(async () => ({ ok: 0, failed: 0 }))}
      onImportMd={vi.fn(async () => ({ ok: 0, failed: 0 }))}
      onRemove={vi.fn()}
      onFindOrphanAttachments={onFindOrphanAttachments}
      onRemoveAttachments={onRemoveAttachments}
    />,
  );
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  return { onFindOrphanAttachments, onRemoveAttachments, openMenu };
}

describe('目录树 · 清理未引用的附件', () => {
  it('没传回调时不出现这个菜单项（旧调用方不受影响）', () => {
    const { openMenu } = setup(null);
    openMenu();
    expect(screen.queryByText(ITEM)).toBeNull();
    expect(screen.queryByText('批量删除')).toBeTruthy(); // 菜单本身照常
  });

  it('没有孤儿：不弹确认框，直接说清「全部有笔记在用」，也不删任何东西', async () => {
    const { onRemoveAttachments, openMenu } = setup([]);
    openMenu();
    fireEvent.click(screen.getByText(ITEM));
    await flush();

    expect(overlay()).toBeNull();
    expect(onRemoveAttachments).not.toHaveBeenCalled();
    await waitFor(() => expect(toastText()).toContain('没有未被引用的附件'));
    expect(toastText()).toContain('全部有笔记在用');
  });

  it('有孤儿：先出确认框（列出文件名），点取消则一个都不删', async () => {
    const { onRemoveAttachments, openMenu } = setup(['_attachments/没人要.png']);
    openMenu();
    fireEvent.click(screen.getByText(ITEM));
    await waitFor(() => expect(overlay()).toBeTruthy());

    const detail = document.querySelector('.mv-confirm-detail')!.textContent ?? '';
    expect(detail).toContain('没人要.png');
    expect(detail).toContain('仍被笔记引用');
    expect(onRemoveAttachments).not.toHaveBeenCalled(); // 关键：确认前不许删

    fireEvent.click(document.querySelector('.mv-confirm-cancel') as HTMLElement);
    await flush();
    expect(onRemoveAttachments).not.toHaveBeenCalled();
  });

  it('确认后删的是**全部**孤儿（清单只显示前 8 个，动作不能跟着截断），并报出结果', async () => {
    const orphans = Array.from({ length: 10 }, (_, i) => `_attachments/图${i}.png`);
    const { onRemoveAttachments, openMenu } = setup(orphans);
    openMenu();
    fireEvent.click(screen.getByText(ITEM));
    await waitFor(() => expect(overlay()).toBeTruthy());

    // 确认框里只列前 8 个 + 一句「还有 2 个」
    const detail = document.querySelector('.mv-confirm-detail')!.textContent ?? '';
    expect(detail).toContain('图0.png');
    expect(detail).toContain('图7.png');
    expect(detail).not.toContain('图8.png');
    expect(detail).toContain('还有 2 个');

    fireEvent.click(document.querySelector('.mv-confirm-ok') as HTMLElement);
    await waitFor(() => expect(onRemoveAttachments).toHaveBeenCalledTimes(1));
    // 传下去的是完整清单（10 个），不是显示出来的 8 个；这行同时把上面的可空收窄掉
    if (!onRemoveAttachments) throw new Error('这条用例必须传 onRemoveAttachments');
    expect(onRemoveAttachments.mock.calls[0][0]).toEqual(orphans);
    await waitFor(() => expect(toastText()).toContain('已删除 10 个未被引用的附件'));
  });

  it('删除有失败项时如实报出（不能让用户以为全删干净了）', async () => {
    const { openMenu } = setup(['_attachments/a.png', '_attachments/b.png'], ['_attachments/b.png']);
    openMenu();
    fireEvent.click(screen.getByText(ITEM));
    await waitFor(() => expect(overlay()).toBeTruthy());
    fireEvent.click(document.querySelector('.mv-confirm-ok') as HTMLElement);
    await waitFor(() => expect(toastText()).toContain('1 个删除失败'));
    expect(toastText()).toContain('已删除 1 个附件');
  });

  it('扫描还没返回时再点一次不会叠出第二个确认框（闸门挡住重复入口）', async () => {
    // 扫描要读全部笔记 + 题库 + 模板，几百毫秒起步。菜单在第一次点击后会收起，但用户完全可以
    // 再打开菜单点一次——没有闸门时就会叠出两个确认框，而它们删的是同一批文件。
    let release: (v: { orphans: string[]; referenced: number; total: number }) => void = () => {};
    const find = vi.fn(() => new Promise<{ orphans: string[]; referenced: number; total: number }>((r) => { release = r; }));
    const { openMenu } = setup([], [], find);

    openMenu();
    fireEvent.click(screen.getByText(ITEM));
    openMenu(); // 第一次还没返回，用户又打开了菜单
    await waitFor(() => expect(screen.getByText('清理中…')).toBeTruthy());
    fireEvent.click(screen.getByText('清理中…'));
    expect(find).toHaveBeenCalledTimes(1); // 第二次点击没有真的再跑一遍

    // 放行：只弹出**一个**确认框
    release({ orphans: ['_attachments/没人要.png'], referenced: 0, total: 1 });
    await waitFor(() => expect(document.querySelectorAll('.mv-confirm-overlay').length).toBe(1));
  });
});
