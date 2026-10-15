// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initNavIndicator } from '../navIndicator';

/**
 * 导航轨滑动指示器：jsdom 里几何量全是 0，所以显式给按钮写 offsetTop / offsetHeight。
 * 用「减少动态效果」路径断言，因为那时落位是同步的（不走 rAF），结果确定。
 */

let reduced = true;

function stubMedia() {
  vi.stubGlobal(
    'matchMedia',
    ((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
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

function defineBox(el: HTMLElement, top: number, height: number) {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

function makeRail() {
  document.body.innerHTML = `
    <div class="rail">
      <div class="rail-scroll">
        <button class="rail-btn on" aria-current="page" id="a"></button>
        <button class="rail-btn" id="b"></button>
      </div>
    </div>`;
  const a = document.getElementById('a')!;
  const b = document.getElementById('b')!;
  defineBox(a, 100, 42);
  defineBox(b, 200, 42);
  return { a, b };
}

beforeEach(() => {
  reduced = true;
  stubMedia();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('initNavIndicator', () => {
  it('创建指示器并把它放到激活按钮的垂直中心（减少动态效果 → 同步落位）', () => {
    makeRail();
    const stop = initNavIndicator();

    const ind = document.querySelector<HTMLElement>('.rail-indicator');
    expect(ind).not.toBeNull();
    expect(ind!.classList.contains('on')).toBe(true);
    expect(document.documentElement.classList.contains('nav-ink')).toBe(true);
    // 100 + (42 - 20) / 2 = 111
    expect(ind!.style.transform).toBe('translate3d(0, 111.00px, 0)');
    stop();
  });

  it('激活项移动后指示器跟着重测', async () => {
    const { a, b } = makeRail();
    const stop = initNavIndicator();
    const ind = document.querySelector<HTMLElement>('.rail-indicator')!;

    a.classList.remove('on');
    a.removeAttribute('aria-current');
    b.classList.add('on');
    b.setAttribute('aria-current', 'page');
    // observer 回调是微任务，重测合并到下一帧 rAF
    await new Promise((r) => setTimeout(r, 60));
    expect(ind.style.transform).toBe('translate3d(0, 211.00px, 0)');
    stop();
  });

  it('没有激活项时指示器隐藏', () => {
    const { a } = makeRail();
    a.classList.remove('on');
    a.removeAttribute('aria-current');
    const stop = initNavIndicator();
    const ind = document.querySelector<HTMLElement>('.rail-indicator')!;
    expect(ind.classList.contains('on')).toBe(false);
    stop();
  });

  it('没有页面项时退回 .on（目录展开态）', () => {
    const { a } = makeRail();
    a.removeAttribute('aria-current'); // a 仍带 .on
    const stop = initNavIndicator();
    const ind = document.querySelector<HTMLElement>('.rail-indicator')!;
    expect(ind.classList.contains('on')).toBe(true);
    expect(ind.style.transform).toBe('translate3d(0, 111.00px, 0)');
    stop();
  });

  it('卸载后移除指示器与 nav-ink 标记', () => {
    makeRail();
    const stop = initNavIndicator();
    expect(document.querySelector('.rail-indicator')).not.toBeNull();
    stop();
    expect(document.querySelector('.rail-indicator')).toBeNull();
    expect(document.documentElement.classList.contains('nav-ink')).toBe(false);
  });

  it('导轨尚未渲染时等待出现，随后自动挂载', async () => {
    document.body.innerHTML = '';
    const stop = initNavIndicator();
    expect(document.querySelector('.rail-indicator')).toBeNull();

    makeRail();
    await new Promise((r) => setImmediate(r));
    expect(document.querySelector('.rail-indicator')).not.toBeNull();
    stop();
  });
});
