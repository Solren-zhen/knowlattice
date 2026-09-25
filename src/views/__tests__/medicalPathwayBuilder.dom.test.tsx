// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MedicalPathwayBuilder from '../MedicalPathwayBuilder';

afterEach(cleanup);

const openAdvanced = () => fireEvent.click(screen.getByText('编辑节点、关系和历史'));
const openMarkdown = () => fireEvent.click(screen.getByText('查看生成的 Markdown'));

describe('医学通路工作区', () => {
  it('重命名节点时同步更新相关关系', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    openAdvanced();
    fireEvent.change(screen.getByRole('textbox', { name: '节点 1' }), { target: { value: '葡萄糖-1' } });
    openMarkdown();

    const markdown = container.querySelector('.pathway-builder-preview pre')?.textContent ?? '';
    expect(markdown).toContain('葡萄糖-1 -> 6-磷酸葡萄糖 : 己糖激酶');
    expect(markdown).not.toContain('葡萄糖 -> 6-磷酸葡萄糖');
  });

  it('删除泳道时保留并迁移其中的关系', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    openAdvanced();
    fireEvent.click(screen.getByText('+ 添加分组'));
    fireEvent.change(screen.getByRole('combobox', { name: '关系 1 分组' }), { target: { value: '分组 2' } });
    fireEvent.click(screen.getByRole('button', { name: '删除分组 2' }));
    openMarkdown();

    const markdown = container.querySelector('.pathway-builder-preview pre')?.textContent ?? '';
    expect(markdown.match(/葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶/g)).toHaveLength(1);
  });

  it('Escape 关闭工作区，并把 Tab 焦点限制在对话框内', () => {
    const onClose = vi.fn();
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={onClose} />);
    const closeButton = container.querySelector('header.pathway-builder-head .btn-icon');
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存并插入' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ---------- 画布节点定位（拖拽落点 / 方向键微调 / 清除定位） ----------
  // pointer 事件直接派发在节点元素上：事件冒泡到画布，e.target 才是 .pw-node
  //（fireEvent 的 target 初始化属性不会写进 PointerEvent，只用于表单取值）

  const canvasOf = (container: HTMLElement) => container.querySelector<HTMLDivElement>('.pathway-preview-canvas')!;
  const markdownOf = (container: HTMLElement) =>
    container.querySelector('.pathway-builder-preview pre')?.textContent ?? '';

  it('点选节点后方向键微调：坐标写回 markdown（@ 节点 | x | y）', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const canvas = canvasOf(container);
    const node = container.querySelector<SVGGElement>('.pw-node[data-pw-key="葡萄糖"]')!;
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    openMarkdown();
    expect(markdownOf(container)).toMatch(/@ 葡萄糖 \| \d+ \| \d+/);
  });

  it('方向键连续微调合并为一条撤销记录', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const canvas = canvasOf(container);
    const node = container.querySelector<SVGGElement>('.pw-node[data-pw-key="葡萄糖"]')!;
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    openMarkdown();
    expect(markdownOf(container)).toMatch(/@ 葡萄糖 \| \d+ \| \d+/);

    fireEvent.click(screen.getByRole('button', { name: '↶ 撤销' }));
    openMarkdown();
    // 整段位移一次撤销：回到未定位状态
    expect(markdownOf(container)).not.toMatch(/@ 葡萄糖 \|/);
  });

  it('Enter 清除选中节点的定位，回到自动分层', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const canvas = canvasOf(container);
    const node = container.querySelector<SVGGElement>('.pw-node[data-pw-key="葡萄糖"]')!;
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    openMarkdown();
    expect(markdownOf(container)).toMatch(/@ 葡萄糖 \| \d+ \| \d+/);

    fireEvent.keyDown(canvas, { key: 'Enter' });
    openMarkdown();
    expect(markdownOf(container)).not.toMatch(/@ 葡萄糖 \|/);
  });

  it('「回到自动布局」清掉全部手动坐标', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const canvas = canvasOf(container);
    for (const key of ['葡萄糖', '丙酮酸']) {
      const node = container.querySelector<SVGGElement>(`.pw-node[data-pw-key="${key}"]`)!;
      fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    }
    openMarkdown();
    expect((markdownOf(container).match(/@ \S+ \| \d+ \| \d+/g) ?? []).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole('button', { name: /回到自动布局/ }));
    openMarkdown();
    expect(markdownOf(container)).not.toMatch(/@ \S+ \| \d+ \| \d+/);
  });

  it('双击节点展开高级面板并聚焦该节点的名称输入框', () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const node = container.querySelector<SVGGElement>('.pw-node[data-pw-key="丙酮酸"]')!;
    fireEvent.doubleClick(node);
    return vi.waitFor(() => {
      expect(container.querySelector('details.pathway-advanced')?.hasAttribute('open')).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '节点 3' }));
    });
  });

  it('拖拽节点：移动中直改 DOM，松手写回坐标并支持一次撤销', async () => {
    const { container } = render(<MedicalPathwayBuilder onInsert={() => true} onClose={() => {}} />);
    const pick = () => container.querySelector<SVGGElement>('.pw-node[data-pw-key="葡萄糖"]')!;
    const node = pick();
    const x0 = Number(node.getAttribute('data-pw-x'));
    const y0 = Number(node.getAttribute('data-pw-y'));

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    // pointerdown 的 setSelectedNode 触发重渲会重建预览 DOM：后续事件派发到
    // 「当前文档里的」节点上，冒泡才能到画布上的拖拽监听器
    const live = pick();
    // jsdom 里 svg.getBoundingClientRect() 宽为 0 → scale 回退 1：位移即坐标差
    fireEvent.pointerMove(live, { pointerId: 1, clientX: 140, clientY: 130 });
    expect(live.getAttribute('transform')).toBe(`translate(${x0 + 40} ${y0 + 30})`);
    expect(live.getAttribute('data-pw-x')).toBe(String(x0 + 40));

    fireEvent.pointerUp(live, { pointerId: 1, clientX: 140, clientY: 130 });
    await vi.waitFor(() => {
      openMarkdown();
      expect(markdownOf(container)).toContain(`@ 葡萄糖 | ${x0 + 40} | ${y0 + 30}`);
    });
    fireEvent.click(screen.getByRole('button', { name: '↶ 撤销' }));
    openMarkdown();
    expect(markdownOf(container)).not.toMatch(/@ 葡萄糖 \|/);
  });

});
