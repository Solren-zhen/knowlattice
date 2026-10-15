// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { initCardTilt } from '../cardTilt';
import { initPressFeedback } from '../pressFeedback';

/**
 * 这两个模块是「委托 + 开关」式的副作用模块，测的是 DOM 可观测的契约：
 * 什么时候挂上标记、什么时候摘掉、什么时候根本不该动。
 * 具体数值（角度、弹簧峰值）在 motion.test.ts 里作为纯函数测。
 */

let reduced = false;
let finePointer = true;

function stubMedia() {
  vi.stubGlobal(
    'matchMedia',
    ((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : finePointer,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia,
  );
}

/** jsdom 里所有元素的 rect 都是 0，倾斜计算会直接跳过，所以给卡片一个真实尺寸 */
function giveRect(el: HTMLElement, width = 200, height = 100) {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  reduced = false;
  finePointer = true;
  stubMedia();
  document.body.innerHTML = '';
  document.documentElement.classList.remove('no-motion');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('按压反馈（第 8 项）', () => {
  it('按下再松开 → 挂上回弹动画类，animationend 之后摘掉', () => {
    document.body.innerHTML = '<button class="btn-primary">确定</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(btn, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);

    fireEvent.pointerUp(btn, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(true);

    fireEvent.animationEnd(btn);
    expect(btn.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('拖动超过阈值不算按压（列表里拖一下松手不该弹）', () => {
    document.body.innerHTML = '<button class="btn-small">删</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(btn, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { pointerId: 2, clientX: 60, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('pointercancel 之后不弹（手势被系统打断）', () => {
    document.body.innerHTML = '<button class="rail-btn">搜索</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(btn, { pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(btn, { pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { pointerId: 3, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('disabled 按钮不参与', () => {
    document.body.innerHTML = '<button class="btn" disabled>提交</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(btn, { pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { pointerId: 4, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('行元素（.tree-row）不在按压名单里', () => {
    document.body.innerHTML = '<div class="tree-row"><span>笔记</span></div>';
    const row = document.querySelector('.tree-row')!;
    const span = document.querySelector('span')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(span, { pointerId: 5, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(span, { pointerId: 5, clientX: 10, clientY: 10 });
    expect(row.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('系统要求减少动态效果时不动（按下态仍由 CSS :active 负责）', () => {
    reduced = true;
    document.body.innerHTML = '<button class="btn-primary">确定</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();

    fireEvent.pointerDown(btn, { pointerId: 6, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { pointerId: 6, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);
    stop();
  });

  it('卸载后不再挂类（不留常驻监听）', () => {
    document.body.innerHTML = '<button class="btn">确定</button>';
    const btn = document.querySelector('button')!;
    const stop = initPressFeedback();
    stop();

    fireEvent.pointerDown(btn, { pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { pointerId: 7, clientX: 10, clientY: 10 });
    expect(btn.classList.contains('press-released')).toBe(false);
  });
});

describe('卡片倾斜（第 1 项）', () => {
  it('指针进入卡片挂上 data-tilt-active，离开后回到未激活（静止画面还原）', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-tilt class="dash-card">数据</div>';
    const card = document.querySelector('[data-tilt]') as HTMLElement;
    giveRect(card);
    const stop = initCardTilt();

    fireEvent.pointerMove(card, { pointerId: 1, clientX: 20, clientY: 10 });
    expect(card.hasAttribute('data-tilt-active')).toBe(true);

    // 指针移到卡片外的元素上
    document.body.innerHTML += '<div id="outside">外面</div>';
    const outside = document.getElementById('outside')!;
    fireEvent.pointerMove(outside, { pointerId: 1, clientX: 400, clientY: 400 });
    vi.advanceTimersByTime(1000);
    expect(card.hasAttribute('data-tilt-active')).toBe(false);
    stop();
  });

  it('没有 data-tilt 的元素不受影响', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="wb-card" id="plain">统计</div>';
    const plain = document.getElementById('plain')!;
    giveRect(plain);
    const stop = initCardTilt();

    fireEvent.pointerMove(plain, { pointerId: 1, clientX: 20, clientY: 10 });
    vi.advanceTimersByTime(100);
    expect(plain.hasAttribute('data-tilt-active')).toBe(false);
    stop();
  });

  it('纯触摸设备不启用（避免抢走滚动）', () => {
    vi.useFakeTimers();
    finePointer = false;
    stubMedia();
    document.body.innerHTML = '<div data-tilt class="dash-card">数据</div>';
    const card = document.querySelector('[data-tilt]') as HTMLElement;
    giveRect(card);
    const stop = initCardTilt();

    fireEvent.pointerMove(card, { pointerId: 1, clientX: 20, clientY: 10 });
    vi.advanceTimersByTime(100);
    expect(card.hasAttribute('data-tilt-active')).toBe(false);
    stop();
  });

  it('系统要求减少动态效果时不启用', () => {
    vi.useFakeTimers();
    reduced = true;
    stubMedia();
    document.body.innerHTML = '<div data-tilt class="dash-card">数据</div>';
    const card = document.querySelector('[data-tilt]') as HTMLElement;
    giveRect(card);
    const stop = initCardTilt();

    fireEvent.pointerMove(card, { pointerId: 1, clientX: 20, clientY: 10 });
    vi.advanceTimersByTime(100);
    expect(card.hasAttribute('data-tilt-active')).toBe(false);
    stop();
  });

  it('急停开关 no-motion 生效，且清理时把标记与内联变量都还原', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-tilt class="dash-card">数据</div>';
    const card = document.querySelector('[data-tilt]') as HTMLElement;
    giveRect(card);
    const stop = initCardTilt();

    fireEvent.pointerMove(card, { pointerId: 1, clientX: 20, clientY: 10 });
    expect(card.hasAttribute('data-tilt-active')).toBe(true);

    document.documentElement.classList.add('no-motion');
    await vi.advanceTimersByTimeAsync(50);
    expect(card.hasAttribute('data-tilt-active')).toBe(false);

    stop();
    document.documentElement.classList.remove('no-motion');
  });
});
