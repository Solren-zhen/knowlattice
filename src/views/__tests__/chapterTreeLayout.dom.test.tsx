// @vitest-environment jsdom
/**
 * 章节树的**行几何**回归测试（views/ChapterTree.tsx + index.css 的 .tree-* 规则）。
 *
 * 背景（用户反馈）：目录的展开箭头「位置错位、不显示」。根因是三个各自独立的小错：
 *   ① 目录行缩进是 `depth*14`（第 0 层左边距 0、箭头贴边），笔记行是 `depth*14 + 12`
 *      （为箭头预留的位置）→ 同一层级里目录名与笔记名的**列差 8px**；
 *   ② 箭头是「裸 svg + 文本节点」，没有自己的盒子——落点由文本节点怎么被合并/换行决定，不稳定；
 *   ③ 批量模式下笔记行不渲染箭头槽（原条件 `!batchMode`），目录行却渲染 → 又差 20px。
 * 现在两类行共用一套缩进（`rowIndent`）+ 同宽的箭头槽（.tree-caret：目录放箭头、笔记**无条件**留空槽）。
 *
 * jsdom 没有布局引擎，量不了像素，所以这里钉的是**结构与数值**：同一层级的 paddingLeft 必须相等、
 * 箭头槽两边都在、目录名包在 .tree-name 里。像素层面的最终确认留给真机。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChapterTree from '../ChapterTree';
import type { TreeNode } from '../../core/vault';

// jsdom 没有 ResizeObserver：树靠它更新视口高度
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

/** 三层结构：目录(0) → 目录(1) → 笔记(2)，以及同层的一条笔记(1) */
const tree: TreeNode[] = [
  {
    name: '01-生理',
    path: '01-生理',
    type: 'dir',
    children: [
      {
        name: '呼吸',
        path: '01-生理/呼吸',
        type: 'dir',
        children: [{ name: '波尔效应.md', path: '01-生理/呼吸/波尔效应.md', type: 'file' }],
      },
      { name: '氧解离曲线.md', path: '01-生理/氧解离曲线.md', type: 'file' },
    ],
  },
];

const renderTree = () => {
  const { container } = render(
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
    />,
  );
  return container;
};

/** 行 → 名字所在元素（目录与笔记都必须包在 .tree-name 里，长名字才能正确省略） */
const nameEl = (row: HTMLElement) => row.querySelector('.tree-name') as HTMLElement | null;
const caret = (row: HTMLElement) => row.querySelector('.tree-caret') as HTMLElement | null;

afterEach(() => cleanup());

describe('章节树 · 行几何（缩进与箭头槽）', () => {
  it('同一层级的目录行与笔记行缩进完全一致（不再差 8px）', () => {
    const container = renderTree();
    const rows = [...container.querySelectorAll<HTMLElement>('.tree-row')];
    const pad = (text: string) =>
      rows.find((r) => (r.textContent ?? '').includes(text))!.style.paddingLeft;

    // 默认展开前两层：目录 0/1 层展开，露出 2 层的笔记
    expect(pad('01-生理')).toBe('8px');   // depth 0
    expect(pad('呼吸')).toBe('22px');     // depth 1（与同层笔记同值）
    expect(pad('氧解离曲线')).toBe('22px'); // depth 1 笔记
    expect(pad('波尔效应')).toBe('36px');   // depth 2 笔记
  });

  it('箭头槽两边都在：目录行放箭头、笔记行留同样宽的空槽', () => {
    const container = renderTree();
    const rows = [...container.querySelectorAll<HTMLElement>('.tree-row')];

    const dirRow = rows.find((r) => r.classList.contains('dir'))!;
    const dirCaret = caret(dirRow)!;
    expect(dirCaret).toBeTruthy();
    expect(dirCaret.querySelector('svg')).toBeTruthy();       // 目录行：箭头在槽里
    expect(dirRow.querySelector('svg')?.parentElement).toBe(dirCaret); // 且就是这一槽

    const fileRow = rows.find((r) => r.classList.contains('file'))!;
    const fileCaret = caret(fileRow)!;
    expect(fileCaret).toBeTruthy();
    expect(fileCaret.querySelector('svg')).toBeNull();        // 笔记行：槽里是空的
  });

  it('目录名与笔记名都包在 .tree-name 里（长名字走省略号，而不是被剪掉、也不是压掉箭头）', () => {
    const container = renderTree();
    const rows = [...container.querySelectorAll<HTMLElement>('.tree-row')];
    for (const row of rows) expect(nameEl(row)).toBeTruthy();
    // 计数徽标仍在行尾（margin-left:auto），没被名字吞掉
    expect(rows.find((r) => r.classList.contains('dir'))!.querySelector('.dir-count')).toBeTruthy();
  });

  it('展开态落在箭头槽里的 svg 上：展开 rotate(90deg)、收起 none；折叠时子项从 DOM 里消失', () => {
    const container = renderTree();
    const row = (t: string) =>
      [...container.querySelectorAll<HTMLElement>('.tree-row')].find((r) => (r.textContent ?? '').includes(t));
    // 箭头必须**在这条行的箭头槽里**——不是游离在行外、也不是别的 svg
    const arrow = (t: string) => row(t)!.querySelector('.tree-caret svg') as SVGElement | null;

    // 默认展开前两层：箭头转 90° 且子项可见
    expect(arrow('01-生理')).toBeTruthy();
    expect(arrow('01-生理')!.style.transform).toContain('rotate(90deg)');
    expect(row('波尔效应')).toBeTruthy();

    fireEvent.click(row('01-生理')!); // 收起第 0 层
    expect(arrow('01-生理')!.style.transform).toBe('none');
    expect(row('呼吸')).toBeUndefined(); // 折叠 = 子项不渲染，而不是藏起来

    fireEvent.click(row('01-生理')!); // 再展开
    expect(arrow('01-生理')!.style.transform).toContain('rotate(90deg)');
    expect(row('呼吸')).toBeTruthy();
  });

  it('批量模式下两类行仍然对齐：勾选框 + 箭头槽都在（笔记行的槽是空的）', () => {
    const container = renderTree();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('批量删除'));

    const rows = [...container.querySelectorAll<HTMLElement>('.tree-row')];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.querySelector('.ck')).toBeTruthy();  // 勾选框 14px（flex-shrink:0）
      expect(caret(row)).toBeTruthy();                // 箭头槽：两边都在，差 20px 就是这么来的
      expect(nameEl(row)).toBeTruthy();
    }
    // 只有目录行的槽里是箭头；笔记行的槽留空但占位
    expect(caret(rows.find((r) => r.classList.contains('dir'))!)!.querySelector('svg')).toBeTruthy();
    expect(caret(rows.find((r) => r.classList.contains('file'))!)!.querySelector('svg')).toBeNull();
  });
});
