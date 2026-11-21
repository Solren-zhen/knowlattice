/**
 * @vitest-environment jsdom
 *
 * 全屏面板的焦点收口：打开时焦点搬进来、Tab 在面板内循环、关闭时还回去。
 * Esc 一律不在这里处理（那是 core/escStack 的 useEsc 的活，同一次 Esc 只能关一层）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import PanelOverlay from '../PanelOverlay';

afterEach(cleanup);

function Panel() {
  return (
    <PanelOverlay label="测试面板">
      <div className="panel">
        <button>第一个</button>
        <button>最后一个</button>
      </div>
    </PanelOverlay>
  );
}

describe('PanelOverlay 焦点', () => {
  it('挂载时把焦点搬到面板里的第一个可聚焦元素', () => {
    const { getByText } = render(<Panel />);
    expect(document.activeElement).toBe(getByText('第一个'));
  });

  it('不抢子组件已经 autoFocus 的焦点', () => {
    const { getByTestId } = render(
      <PanelOverlay label="带输入框">
        <button>前一个</button>
        <input data-testid="name" autoFocus />
      </PanelOverlay>,
    );
    expect(document.activeElement).toBe(getByTestId('name'));
  });

  it('最后一个再按 Tab 回到第一个；第一个 Shift+Tab 回到最后一个', () => {
    const { getByText } = render(<Panel />);
    const first = getByText('第一个');
    const last = getByText('最后一个');
    (last as HTMLElement).focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    (first as HTMLElement).focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('中间位置按 Tab 不拦截（浏览器自己往下走）', () => {
    const { getByText } = render(
      <PanelOverlay label="三按钮">
        <button>一</button>
        <button>二</button>
        <button>三</button>
      </PanelOverlay>,
    );
    const one = getByText('一');
    (one as HTMLElement).focus();
    fireEvent.keyDown(one, { key: 'Tab' });
    // 没有被 preventDefault（jsdom 不会自己移动焦点，所以仍留在原处）
    expect(document.activeElement).toBe(one);
  });

  it('卸载后焦点还回原处', () => {
    const { getByText } = render(<button>外面</button>);
    const outside = getByText('外面');
    (outside as HTMLElement).focus();
    const overlay = render(<Panel />);
    expect(document.activeElement).not.toBe(outside);
    overlay.unmount();
    expect(document.activeElement).toBe(outside);
  });

  it('语义与 ARIA：dialog + aria-modal + label', () => {
    const { container } = render(<Panel />);
    const el = container.querySelector('[data-overlay="plain"]') as HTMLElement;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('测试面板');
  });

  it('Esc 不在这里处理：遮罩上没有 onKeyDown 关面板的行为', () => {
    let closed = false;
    render(
      <PanelOverlay label="可关闭" onClose={() => { closed = true; }}>
        <button>点我</button>
      </PanelOverlay>,
    );
    const el = document.querySelector('[data-overlay="plain"]') as HTMLElement;
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(closed).toBe(false);
  });
});
