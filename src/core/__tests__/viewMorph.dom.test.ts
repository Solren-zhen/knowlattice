// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MORPH, morphEnabled, morphFrom, morphIsRunning, morphSupported } from '../viewMorph';

/**
 * 共享元素转场的可观测契约：什么时候真的交给浏览器转场、什么时候直通，
 * 以及最要命的一条 —— view-transition-name 用完必须清干净（重名会抛 DOMException）。
 * 真实视觉由浏览器负责，这里只钉「有没有正确地把名字交给浏览器又收回来」。
 */

let reduced = false;
let calls: Array<() => void> = [];
let finish: () => void = () => {};

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

function stubTransition() {
  calls = [];
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
    calls.push(cb);
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ready: Promise.resolve(), finished, skipTransition: () => {} };
  };
}

beforeEach(() => {
  reduced = false;
  stubMedia();
  document.body.innerHTML = '';
  document.documentElement.classList.remove('no-morph', 'morphing');
  stubTransition();
});

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('no-morph', 'morphing');
  document.body.innerHTML = '';
});

describe('能力与开关', () => {
  it('浏览器支持同文档转场时才算支持', () => {
    expect(morphSupported()).toBe(true);
    expect(morphEnabled()).toBe(true);
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    expect(morphSupported()).toBe(false);
    expect(morphEnabled()).toBe(false);
  });

  it('系统要求减少动态效果时不做转场', () => {
    reduced = true;
    expect(morphEnabled()).toBe(false);
  });

  it('html.no-morph 急停开关生效', () => {
    document.documentElement.classList.add('no-morph');
    expect(morphEnabled()).toBe(false);
  });
});

describe('morphFrom', () => {
  it('不支持时直通：更新照常执行，不给任何元素命名', () => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    const source = document.createElement('button');
    document.body.appendChild(source);
    const update = vi.fn(() => document.body.insertAdjacentHTML('beforeend', '<span class="target"></span>'));

    morphFrom(source, MORPH.search, '.target', update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(source.style.getPropertyValue('view-transition-name')).toBe('');
    expect(document.querySelector('.target')?.getAttribute('style')).toBeNull();
  });

  it('支持时：同步跑更新、给目标命名、结束后把名字与 morphing 类都收回来', async () => {
    const source = document.createElement('button');
    document.body.appendChild(source);
    const update = vi.fn(() => document.body.insertAdjacentHTML('beforeend', '<span class="target"></span>'));

    morphFrom(source, MORPH.search, '.target', update);

    // 回调是同步跑的（调用方用 flushSync 保证 DOM 已更新），但浏览器还没「拍新快照」
    expect(calls).toHaveLength(1);
    calls[0]();
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLElement>('.target')?.style.getPropertyValue('view-transition-name')).toBe(MORPH.search);
    expect(source.style.getPropertyValue('view-transition-name')).toBe('');
    expect(document.documentElement.classList.contains('morphing')).toBe(true);
    expect(morphIsRunning()).toBe(true);

    finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>('.target')?.style.getPropertyValue('view-transition-name')).toBe('');
    expect(document.documentElement.classList.contains('morphing')).toBe(false);
    expect(morphIsRunning()).toBe(false);
  });

  it('no-morph 时直通（不占用浏览器转场）', () => {
    document.documentElement.classList.add('no-morph');
    const source = document.createElement('button');
    const update = vi.fn();
    morphFrom(source, MORPH.noteTitle, '.note-path', update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('来源为空时直通（例如键盘快捷键打开，没有可形变的源元素）', () => {
    const update = vi.fn();
    morphFrom(null, MORPH.search, '.qs-modal', update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('上一次转场没结束时，第二次直通 —— 不抢同一批名字', async () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    document.body.append(a, b);
    const first = vi.fn();
    const second = vi.fn();

    morphFrom(a, MORPH.search, null, first);
    morphFrom(b, MORPH.noteTitle, null, second);

    expect(calls).toHaveLength(1); // 只起了一次转场
    expect(second).toHaveBeenCalledTimes(1); // 第二次直通：更新照常完成
    expect(first).not.toHaveBeenCalled(); // 第一次的更新在浏览器回调里，还没轮到它跑

    calls[0]();
    expect(first).toHaveBeenCalledTimes(1);

    // 收尾：把这次转场结束掉，别把模块里的「进行中」状态留给下一个用例
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(morphIsRunning()).toBe(false);
  });
  it('转场对象抛错时也能回到干净状态（名字不会留在 DOM 上）', () => {
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = () => {
      throw new Error('boom');
    };
    const source = document.createElement('button');
    document.body.appendChild(source);
    const update = vi.fn();

    expect(() => morphFrom(source, MORPH.search, null, update)).not.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    expect(source.style.getPropertyValue('view-transition-name')).toBe('');
    expect(document.documentElement.classList.contains('morphing')).toBe(false);
    expect(morphIsRunning()).toBe(false);
  });
});
