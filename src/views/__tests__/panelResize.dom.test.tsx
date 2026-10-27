/**
 * @vitest-environment jsdom
 *
 * 视频浮窗的自定义缩放。面板右下角固定，所以拖左上角向外才符合直觉：
 * 向左/上拖增加宽高，向右/下拖缩小；松手后保存，双击恢复自适应默认尺寸。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { usePanelResize } from '../usePanelDrag';

function Harness({ k = 'resize' }: { k?: string }) {
  const resize = usePanelResize(k, { minWidth: 360, minHeight: 260 });
  return (
    <div data-testid="panel" data-panel-drag-root style={resize.style}>
      <button
        data-testid="handle"
        onPointerDown={resize.onHandlePointerDown}
        onKeyDown={resize.onHandleKeyDown}
        onDoubleClick={resize.reset}
      >
        缩放
      </button>
    </div>
  );
}

function withSize(el: HTMLElement, width: number, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 500, top: 200, width, height,
    right: 500 + width, bottom: 200 + height, x: 500, y: 200, toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('usePanelResize', () => {
  it('拖左上角向左上拉伸，并保存宽高', () => {
    const { getByTestId } = render(<Harness k="r1" />);
    const panel = getByTestId('panel');
    const handle = getByTestId('handle');
    withSize(panel, 600, 500);

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });

    expect(panel.style.width).toBe('700px');
    expect(panel.style.height).toBe('600px');
    fireEvent.pointerUp(window);
    expect(JSON.parse(localStorage.getItem('knowlattice-panel-size:r1') ?? '{}')).toEqual({ w: 700, h: 600 });
  });

  it('不会缩到最小尺寸以下', () => {
    const { getByTestId } = render(<Harness k="r2" />);
    const panel = getByTestId('panel');
    const handle = getByTestId('handle');
    withSize(panel, 600, 500);

    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 10000, clientY: 10000 });

    expect(panel.style.width).toBe('360px');
    expect(panel.style.height).toBe('260px');
    fireEvent.pointerUp(window);
  });

  it('双击缩放抓手恢复默认自适应尺寸', () => {
    localStorage.setItem('knowlattice-panel-size:r3', JSON.stringify({ w: 700, h: 600 }));
    const { getByTestId } = render(<Harness k="r3" />);
    const panel = getByTestId('panel');
    expect(panel.style.width).toBe('700px');

    fireEvent.doubleClick(getByTestId('handle'));

    expect(panel.style.width).toBe('');
    expect(panel.style.height).toBe('');
    expect(localStorage.getItem('knowlattice-panel-size:r3')).toBeNull();
  });
});
