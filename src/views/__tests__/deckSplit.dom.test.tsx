// @vitest-environment jsdom
/**
 * 工作区三列宽度的 DOM 验收（useDeckSplit）。
 *
 * 为什么需要它：抓手只在 >1040px 的宽屏出现（窄屏目录是浮层），而预览面板往往没那么宽，
 * 所以像素级验证经常做不了。这里把「拖一次改多少、有没有落盘、键盘能不能调、复位清不清」
 * 固定下来，宽屏下的实际观感再靠肉眼确认一次。
 *
 * 注：jsdom 没有布局，getBoundingClientRect 全 0，所以基准取自 hook 里的兜底常量
 * （目录 248 / 关联 236），断言按这个基准算。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDeckSplit } from '../useDeckSplit';

const KEY = 'knowlattice.deck.split';

function Harness() {
  const deck = useDeckSplit();
  return (
    <div className="deck" style={deck.style}>
      <button
        type="button"
        aria-label="拖目录"
        onPointerDown={deck.onTreeDown}
        onKeyDown={deck.onKeyDown('tree')}
        onDoubleClick={deck.reset}
      />
      <div className="c-tree" style={{ width: 248 }} />
      <div className="c-edit" />
      <button
        type="button"
        aria-label="拖关联"
        onPointerDown={deck.onInspDown}
        onKeyDown={deck.onKeyDown('insp')}
        onDoubleClick={deck.reset}
      />
      <div className="c-insp" style={{ width: 236 }} />
    </div>
  );
}

const deck = () => screen.getByLabelText('拖目录').closest<HTMLElement>('.deck')!;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { treeW: number | null; inspW: number | null } | null;

describe('useDeckSplit · 工作区三列宽度', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); });

  it('拖目录抓手：向右拖变宽，松手后落盘', () => {
    render(<Harness />);
    const handle = screen.getByLabelText('拖目录');
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 400, pointerId: 5 });
    fireEvent.pointerMove(handle, { clientX: 360, clientY: 400, pointerId: 5 });
    // 拖动中先改 CSS 变量，松手前不写盘
    expect(deck().style.getPropertyValue('--tree-w')).toBe('308px');
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerUp(handle, { clientX: 360, clientY: 400, pointerId: 5 });
    expect(stored()?.treeW).toBe(308);
  });

  it('拖关联抓手：向左拖变宽（方向与目录相反）', () => {
    render(<Harness />);
    const handle = screen.getByLabelText('拖关联');
    fireEvent.pointerDown(handle, { button: 0, clientX: 900, clientY: 400, pointerId: 6 });
    fireEvent.pointerMove(handle, { clientX: 840, clientY: 400, pointerId: 6 });
    fireEvent.pointerUp(handle, { clientX: 840, clientY: 400, pointerId: 6 });
    expect(stored()?.inspW).toBe(296); // 236 + 60
    expect(deck().style.getPropertyValue('--insp-w')).toBe('296px');
  });

  it('键盘方向键微调 16px，并立即落盘', () => {
    render(<Harness />);
    const handle = screen.getByLabelText('拖目录');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(stored()?.treeW).toBe(264); // 248 + 16
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(stored()?.treeW).toBe(248);
  });

  it('拖到极限会被夹住（不小于 180，不大于 760 或视口的 55%）', () => {
    render(<Harness />);
    const handle = screen.getByLabelText('拖目录');
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 400, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: -9999, clientY: 400, pointerId: 7 });
    fireEvent.pointerUp(handle, { clientX: -9999, clientY: 400, pointerId: 7 });
    expect(stored()?.treeW).toBe(180);

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 400, pointerId: 8 });
    fireEvent.pointerMove(handle, { clientX: 99999, clientY: 400, pointerId: 8 });
    fireEvent.pointerUp(handle, { clientX: 99999, clientY: 400, pointerId: 8 });
    expect(stored()?.treeW).toBe(Math.min(760, Math.round(window.innerWidth * 0.55)));
  });

  it('双击复位：清掉两列宽度与记录', () => {
    render(<Harness />);
    const handle = screen.getByLabelText('拖目录');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(stored()?.treeW).toBe(264);
    fireEvent.doubleClick(handle);
    expect(deck().style.getPropertyValue('--tree-w')).toBe('');
    expect(stored()).toEqual({ treeW: null, inspW: null });
  });
});
