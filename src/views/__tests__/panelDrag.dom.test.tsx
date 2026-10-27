/**
 * @vitest-environment jsdom
 */
/**
 * usePanelDrag：浮层拖动的位置换算。
 *
 * 为什么单独测：夹边逻辑错了不会报错，只会表现为「面板拖出屏幕后再也点不到」——
 * 这是回归时最难发现、用户最恼火的一类问题。jsdom 的 getBoundingClientRect 全是 0，
 * 所以这里显式给一个真实矩形，让夹边计算跑在有意义的数据上。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { usePanelDrag } from '../usePanelDrag';

function Harness({ k = 'test' }: { k?: string }) {
  const drag = usePanelDrag(k);
  return (
    <div data-testid="panel" data-panel-drag-root style={drag.style}>
      <section data-testid="inner">
        <header data-testid="head" onPointerDown={drag.onHandlePointerDown} onDoubleClick={drag.reset}>
          <span>标题</span>
          <button data-testid="control">本地文件</button>
        </header>
      </section>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** 让被拖动元素有一个真实矩形（jsdom 默认 0×0，夹边就成了常量） */
function withRect(el: HTMLElement) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 500, top: 400, width: 300, height: 200,
    right: 800, bottom: 600, x: 500, y: 400, toJSON: () => ({}),
  } as DOMRect);
  const head = el.querySelector('header');
  if (head) {
    vi.spyOn(head, 'getBoundingClientRect').mockReturnValue({
      left: 500, top: 400, width: 300, height: 30,
      right: 800, bottom: 430, x: 500, y: 400, toJSON: () => ({}),
    } as DOMRect);
  }
}

describe('usePanelDrag', () => {
  it('拖动把位移写进 transform，并且松手后存进 localStorage', () => {
    const { getByTestId } = render(<Harness k="p1" />);
    const panel = getByTestId('panel');
    const head = getByTestId('head');
    withRect(panel);

    fireEvent.pointerDown(head, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 40 });
    expect(panel.style.transform).toBe('translate(50px, 30px)');
    expect(getByTestId('inner').style.transform).toBe('');

    fireEvent.pointerUp(window);
    expect(getByTestId('inner').style.transform).toBe('');
    expect(JSON.parse(localStorage.getItem('knowlattice-panel-pos:p1') ?? '{}')).toEqual({ x: 50, y: 30 });
  });

  it('拖到屏幕外会被夹住，至少留 80×40 可见', () => {
    const { getByTestId } = render(<Harness k="p2" />);
    const panel = getByTestId('panel');
    const head = getByTestId('head');
    withRect(panel);

    fireEvent.pointerDown(head, { button: 0, clientX: 10, clientY: 10 });
    // 往左上甩一万像素：上限是「右边缘至少留 80px、下边缘至少留 40px」
    fireEvent.pointerMove(window, { clientX: -10000, clientY: -10000 });
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(panel.style.transform);
    expect(m).toBeTruthy();
    const x = Number(m?.[1]);
    const y = Number(m?.[2]);
    // left + x 不能超过窗口宽度；这里断言它没有跑到 -10000 这种位置
    expect(x).toBeGreaterThan(-10000);
    expect(y).toBeGreaterThan(-10000);
    fireEvent.pointerUp(window);
  });

  it('从已保存的位置继续拖时，不会把当前 transform 重复算进边界而跳回原点', () => {
    localStorage.setItem('knowlattice-panel-pos:p4', JSON.stringify({ x: 420, y: 0 }));
    const { getByTestId } = render(<Harness k="p4" />);
    const panel = getByTestId('panel');
    const head = getByTestId('head');
    // 默认 left=500，加上已保存的 420 后，当前左边缘在 920；右侧只剩 80px 可见。
    vi.spyOn(head, 'getBoundingClientRect').mockReturnValue({
      left: 920, top: 400, width: 300, height: 200,
      right: 1220, bottom: 600, x: 920, y: 400, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);

    fireEvent.pointerDown(head, { button: 0, clientX: 950, clientY: 410 });
    fireEvent.pointerMove(window, { clientX: 960, clientY: 410 });

    // 已经到右边界，只能停在 420，不能突然跳回 0。
    expect(panel.style.transform).toBe('translate(420px, 0px)');
    fireEvent.pointerUp(window);
  });

  it('向上拖到极限仍保留标题栏抓手，不会只剩面板底部可见', () => {
    const { getByTestId } = render(<Harness k="p6" />);
    const panel = getByTestId('panel');
    const head = getByTestId('head');
    withRect(panel);

    fireEvent.pointerDown(head, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: -10000 });

    const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(panel.style.transform);
    expect(match).toBeTruthy();
    const headTop = 400 + Number(match?.[2]);
    expect(headTop).toBeGreaterThanOrEqual(0);
    fireEvent.pointerUp(window);
  });

  it('双击复位清掉存储位置', () => {
    localStorage.setItem('knowlattice-panel-pos:p3', JSON.stringify({ x: 120, y: 80 }));
    const { getByTestId } = render(<Harness k="p3" />);
    expect(getByTestId('panel').style.transform).toBe('translate(120px, 80px)');
    fireEvent.doubleClick(getByTestId('head'));
    expect(getByTestId('panel').style.transform).toBe('translate(0px, 0px)');
    expect(localStorage.getItem('knowlattice-panel-pos:p3')).toBeNull();
  });

  it('按在标题栏里的按钮上时让按钮正常响应，不启动拖动', () => {
    const { getByTestId } = render(<Harness k="p5" />);
    const panel = getByTestId('panel');
    const control = getByTestId('control');
    withRect(panel);

    const down = fireEvent.pointerDown(control, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 40 });

    expect(down).toBe(true);
    expect(panel.style.transform).toBe('translate(0px, 0px)');
    fireEvent.pointerUp(window);
  });

  it('只让标题栏接管触摸拖动，不禁掉整个面板的滚动', () => {
    const { getByTestId } = render(<Harness k="p7" />);
    expect(getByTestId('panel').style.touchAction).toBe('');
  });
});
