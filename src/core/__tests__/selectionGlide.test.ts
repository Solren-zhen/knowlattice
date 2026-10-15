// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLIDE_INK_CLASS, GLIDE_ROOT_CLASS, inkBox, initSelectionGlide } from '../selectionGlide';

/**
 * 选择滑动：纯函数 inkBox 直接断言；DOM 部分断言「容器里出现墨迹、落在活动项上、
 * 活动项移动后跟着重测、卸载后清干净」。jsdom 里几何量全是 0，
 * 所以显式给容器与行写 getBoundingClientRect。重测合并到下一帧 rAF，用 setTimeout 让出。
 */

function defineRect(el: HTMLElement, left: number, top: number, width: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
  });
}

function makeResults() {
  document.body.innerHTML = `
    <div class="qs-results">
      <div class="qs-item active" id="r0"></div>
      <div class="qs-item" id="r1"></div>
    </div>`;
  const container = document.querySelector<HTMLElement>('.qs-results')!;
  const r0 = document.getElementById('r0')!;
  const r1 = document.getElementById('r1')!;
  defineRect(container, 0, 0, 300, 200);
  defineRect(r0, 10, 70, 280, 54);
  defineRect(r1, 10, 130, 280, 54);
  return { container, r0, r1 };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('inkBox', () => {
  it('把活动项的视口矩形换算到容器内容坐标', () => {
    expect(inkBox({ left: 10, top: 70, width: 280, height: 54 }, { left: 0, top: 0, width: 300, height: 200 })).toEqual({
      left: 10,
      top: 70,
      width: 280,
      height: 54,
    });
  });

  it('补上容器滚动量，墨迹锚在内容上', () => {
    const box = inkBox(
      { left: 10, top: 20, width: 280, height: 54 },
      { left: 0, top: 0, width: 300, height: 200 },
      0,
      60,
    );
    expect(box.top).toBe(80);
  });
});

describe('initSelectionGlide', () => {
  it('每个容器里出现一枚墨迹，落在活动项上', () => {
    makeResults();
    const stop = initSelectionGlide();

    const ink = document.querySelector<HTMLElement>(`.qs-results .${GLIDE_INK_CLASS}`);
    expect(ink).not.toBeNull();
    expect(document.documentElement.classList.contains(GLIDE_ROOT_CLASS)).toBe(true);
    expect(ink!.classList.contains('on')).toBe(true);
    expect(ink!.style.transform).toBe('translate(10.00px, 70.00px)');
    // jsdom 会把宽度归一化（280.00px → 280px），只断言数值
    expect(Number.parseFloat(ink!.style.width)).toBeCloseTo(280, 2);
    expect(Number.parseFloat(ink!.style.height)).toBeCloseTo(54, 2);
    stop();
  });

  it('活动项移动后墨迹重测', async () => {
    const { r0, r1 } = makeResults();
    const stop = initSelectionGlide();
    const ink = document.querySelector<HTMLElement>(`.qs-results .${GLIDE_INK_CLASS}`)!;

    r0.classList.remove('active');
    r1.classList.add('active');
    // observer 回调是微任务，重测合并到下一帧 rAF
    await new Promise((r) => setTimeout(r, 60));
    expect(ink.style.transform).toBe('translate(10.00px, 130.00px)');
    stop();
  });

  it('没有活动项时墨迹隐藏', () => {
    makeResults();
    document.getElementById('r0')!.classList.remove('active');
    const stop = initSelectionGlide();
    const ink = document.querySelector<HTMLElement>(`.qs-results .${GLIDE_INK_CLASS}`)!;
    expect(ink.classList.contains('on')).toBe(false);
    stop();
  });

  it('容器尚未渲染时等待出现，随后自动挂载', async () => {
    const stop = initSelectionGlide();
    expect(document.querySelector('.glide-ink')).toBeNull();

    makeResults();
    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector('.qs-results .glide-ink')).not.toBeNull();
    stop();
  });

  it('卸载后移除墨迹与总开关', () => {
    makeResults();
    const stop = initSelectionGlide();
    expect(document.querySelector('.glide-ink')).not.toBeNull();
    stop();
    expect(document.querySelector('.glide-ink')).toBeNull();
    expect(document.documentElement.classList.contains(GLIDE_ROOT_CLASS)).toBe(false);
  });
});
