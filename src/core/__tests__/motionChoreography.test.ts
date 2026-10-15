// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initReveal, magnetOffset, revealIndex, STAGGER_CAP } from '../motionChoreography';

/**
 * 动效编排：纯函数（序号、磁吸位移）在这里直接断言；
 * initReveal 测的是 DOM 可观测的契约——错峰序号写入、进入视口挂类、
 * IntersectionObserver 缺失/不触发时的安全网。具体弹簧手感在 motion.test.ts。
 */

let reduced = false;

function stubMedia() {
  vi.stubGlobal(
    'matchMedia',
    ((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : true,
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

/** 立刻回调 isIntersecting 的 IO 替身：把「进入视口」变成同步可断言的动作 */
class FakeIO {
  static instances: FakeIO[] = [];
  cb: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
    this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}

beforeEach(() => {
  reduced = false;
  stubMedia();
  document.body.innerHTML = '';
  document.documentElement.className = '';
  FakeIO.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('revealIndex', () => {
  it('负数/非数归零，超过上限封顶', () => {
    expect(revealIndex(-3)).toBe(0);
    expect(revealIndex(Number.NaN)).toBe(0);
    expect(revealIndex(4)).toBe(4);
    expect(revealIndex(99)).toBe(STAGGER_CAP);
    expect(revealIndex(99, 3)).toBe(3);
  });
});

describe('magnetOffset', () => {
  it('指针在中心不动', () => {
    expect(magnetOffset(100, 100, 100, 100, 5)).toEqual({ x: 0, y: 0 });
  });

  it('朝指针方向偏移并按比例缩放', () => {
    const o = magnetOffset(100, 100, 140, 60, 100, 0.1);
    expect(o.x).toBeCloseTo(4, 5);
    expect(o.y).toBeCloseTo(-4, 5);
  });

  it('夹到 ±max，不会无限漂移', () => {
    const o = magnetOffset(0, 0, 1000, -1000, 5, 0.12);
    expect(o.x).toBe(5);
    expect(o.y).toBe(-5);
  });
});

describe('initReveal', () => {
  it('进入视口后挂 is-revealed；错峰容器按顺序写入 --reveal-i', () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    document.body.innerHTML = `
      <div data-stagger>
        <section data-reveal>1</section>
        <p>无标记，不参与</p>
        <section data-reveal>2</section>
      </div>`;
    const stop = initReveal();

    const items = document.querySelectorAll<HTMLElement>('[data-reveal]');
    expect(items[0].style.getPropertyValue('--reveal-i')).toBe('0');
    // 中间的无标记项不占号：第二项序号是 1，不是 2
    expect(items[1].style.getPropertyValue('--reveal-i')).toBe('1');
    expect(items[0].classList.contains('is-revealed')).toBe(true);
    expect(items[1].classList.contains('is-revealed')).toBe(true);
    stop();
  });

  it('没有 IntersectionObserver 时直接显现（降级不留白）', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    document.body.innerHTML = '<div data-reveal>x</div>';
    const stop = initReveal();
    expect(document.querySelector('[data-reveal]')!.classList.contains('is-revealed')).toBe(true);
    stop();
  });

  it('系统减少动态效果：不进入隐藏态，全部立即显现', () => {
    reduced = true;
    stubMedia();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    document.body.innerHTML = '<div data-reveal>x</div>';
    const stop = initReveal();
    expect(document.querySelector('[data-reveal]')!.classList.contains('is-revealed')).toBe(true);
    expect(FakeIO.instances[0]?.observed.length ?? 0).toBe(0);
    stop();
  });

  it('IO 迟迟不触发时有安全网：1.6s 后全部显现', () => {
    vi.useFakeTimers();
    // IO 存在但不回调
    class SilentIO {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', SilentIO);
    document.body.innerHTML = '<div data-reveal>x</div>';
    const stop = initReveal();
    expect(document.querySelector('[data-reveal]')!.classList.contains('is-revealed')).toBe(false);
    vi.advanceTimersByTime(1700);
    expect(document.querySelector('[data-reveal]')!.classList.contains('is-revealed')).toBe(true);
    stop();
  });

  it('运行中新增的节点会被登记（MutationObserver）', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const stop = initReveal();

    const div = document.createElement('div');
    div.setAttribute('data-reveal', '');
    document.body.appendChild(div);
    // MutationObserver 回调是微任务：等一轮宏任务把微任务队列抽干
    await new Promise((resolve) => setImmediate(resolve));
    expect(div.classList.contains('is-revealed')).toBe(true);
    stop();
  });
});
