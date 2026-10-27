/**
 * @vitest-environment jsdom
 */
/**
 * DialogSurface 的自由拖动。
 *
 * 为什么单测这一个：拖动很容易把点击吃掉——按在按钮上开始拖动，按钮就永远点不动了。
 * 所以这里钉两条：按在空白处能拖；按在控件上不拖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import DialogSurface from '../DialogSurface';

function withRect(el: HTMLElement) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 300, top: 200, width: 400, height: 300,
    right: 700, bottom: 500, x: 300, y: 200, toJSON: () => ({}),
  } as DOMRect);
}

function setup() {
  const onHit = vi.fn();
  const view = render(
    <DialogSurface label="测试弹窗" className="panel" onClick={onHit}>
      <div data-testid="title">标题</div>
      <button type="button" onClick={onHit}>确定</button>
    </DialogSurface>,
  );
  const dialog = view.getByRole('dialog');
  withRect(dialog);
  return { ...view, dialog, onHit };
}

afterEach(cleanup);

describe('DialogSurface 拖动', () => {
  it('在空白处按下并移动，整个弹窗跟着位移', () => {
    const { dialog, getByTestId } = setup();
    fireEvent.pointerDown(getByTestId('title'), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
    fireEvent.pointerUp(window);
    expect(dialog.style.transform).toBe('translate(100px, 50px)');
  });

  it('按在按钮上不拖，点击照常触发', () => {
    const { dialog, getByText, onHit } = setup();
    const btn = getByText('确定');
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 });
    fireEvent.pointerUp(window);
    // 没被当成拖动：既没有位移，点击也没被吞
    expect(dialog.style.transform).toBe('');
    fireEvent.click(btn);
    expect(onHit).toHaveBeenCalled();
  });

  it('拖到屏幕外会被夹住，至少留 80×40 可见', () => {
    const { dialog, getByTestId } = setup();
    fireEvent.pointerDown(getByTestId('title'), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 99999, clientY: 99999 });
    fireEvent.pointerUp(window);
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(dialog.style.transform);
    expect(m).toBeTruthy();
    const x = Number(m?.[1]);
    const y = Number(m?.[2]);
    // rect.left 300 + x 不能超过 window.innerWidth - 80
    expect(300 + x).toBeLessThanOrEqual(window.innerWidth - 80);
    expect(200 + y).toBeLessThanOrEqual(window.innerHeight - 40);
  });
});
