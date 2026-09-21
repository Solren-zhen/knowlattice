// @vitest-environment jsdom
/**
 * 全局 Esc 栈单测：守住「一次 Esc 只关最上面那一层」。
 * 修复前的真实故障：「解剖图谱 + Ctrl+K 搜索」同时开着时，一次 Esc 会把搜索框和
 * 整个图谱一起关掉（搜索框的 React onKeyDown 处理完继续冒泡到 window 的各面板监听）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escDepth, pushEsc, resetEscStack } from '../escStack';

/** 在 window 上派发一次 keydown（各面板的监听都挂在 window） */
const press = (init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init }));

afterEach(() => resetEscStack());

describe('escStack', () => {
  it('只调用栈顶那一层：一次 Esc 不会连关两层', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    pushEsc(lower);
    pushEsc(upper);

    press();

    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it('顶层出栈后，下一次 Esc 才轮到下面那层', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    pushEsc(lower);
    const popUpper = pushEsc(upper);

    press();
    popUpper();
    press();

    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('非 Escape 键不触发', () => {
    const h = vi.fn();
    pushEsc(h);
    press({ key: 'Enter' });
    expect(h).not.toHaveBeenCalled();
  });

  it('已被 preventDefault 的 Escape 不再触发（确认框在捕获阶段先手）', () => {
    const h = vi.fn();
    pushEsc(h);
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(h).not.toHaveBeenCalled();
  });

  it('空栈时按 Esc 不报错', () => {
    expect(escDepth()).toBe(0);
    expect(() => press()).not.toThrow();
  });

  it('出栈函数可重复调用，且不会误删别人的层', () => {
    const a = vi.fn();
    const b = vi.fn();
    const popA = pushEsc(a);
    pushEsc(b);

    popA();
    popA(); // 再调一次不应影响 b

    press();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(escDepth()).toBe(1);
  });

  it('处理器收到原始事件：QuizView 靠 e.target 判断「批注输入框里的 Esc」', () => {
    const h = vi.fn();
    pushEsc(h);
    const input = document.createElement('textarea');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(h).toHaveBeenCalledTimes(1);
    expect((h.mock.calls[0][0] as KeyboardEvent).target).toBe(input);
    input.remove();
  });
});
