// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOW_ATTR, glowPoint, initHoverGlow } from '../hoverGlow';

/**
 * 指针跟光：纯函数 glowPoint 直接断言；DOM 部分断言「进入 → 挂标记 + 写局部坐标、
 * 离开 → 清空」，以及减少动态效果时完全不工作。jsdom 里没有真实布局，
 * 所以给元素显式写一个 getBoundingClientRect。
 *
 * 坐标写入走 rAF 合并（每帧最多一次），所以断言坐标前要让出一帧 ——
 * 标记（GLOW_ATTR）本身仍是同步挂的，CSS 据此才画柔光。
 */

let reduced = false;
/** 是否有精确定位指针（鼠标） */
let fine = true;

function stubMedia() {
  vi.stubGlobal(
    'matchMedia',
    ((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : fine,
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

function defineRect(el: HTMLElement, left: number, top: number, width: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
  });
}

function moveTo(el: Element, x: number, y: number) {
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
}

beforeEach(() => {
  reduced = false;
  fine = true;
  stubMedia();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('glowPoint', () => {
  it('指针在元素内 → 返回局部坐标', () => {
    expect(glowPoint({ left: 100, top: 50, width: 200, height: 40 }, 150, 60)).toEqual({ x: 50, y: 10 });
  });

  it('越界被夹到边界内', () => {
    expect(glowPoint({ left: 100, top: 50, width: 200, height: 40 }, 0, 999)).toEqual({ x: 0, y: 40 });
  });
});

describe('initHoverGlow', () => {
  it('指针进入行 → 挂标记并写入局部坐标', async () => {
    document.body.innerHTML = '<div class="qs-item" id="row"></div>';
    const row = document.getElementById('row')!;
    defineRect(row, 100, 50, 200, 40);
    const stop = initHoverGlow();

    moveTo(row, 150, 60);
    // 标记同步挂上（CSS 据此才画柔光）；坐标进 rAF 队列，下一帧才写
    expect(row.getAttribute(GLOW_ATTR)).toBe('');
    expect(row.style.getPropertyValue('--glow-x')).toBe('');
    await new Promise((r) => setTimeout(r, 40));
    expect(row.style.getPropertyValue('--glow-x')).toBe('50.0px');
    expect(row.style.getPropertyValue('--glow-y')).toBe('10.0px');
    stop();
  });

  it('同一帧内连续移动只写一次，且写的是最后一次的坐标', async () => {
    document.body.innerHTML = '<div class="qs-item" id="row"></div>';
    const row = document.getElementById('row')!;
    defineRect(row, 100, 50, 200, 40);
    const stop = initHoverGlow();

    // pointermove 的频率高于刷新率（125Hz 鼠标每秒 125+ 个事件），
    // 逐事件写入会让这一行的 radial-gradient 重绘多次，而一帧只显示一次
    moveTo(row, 110, 55);
    moveTo(row, 120, 58);
    moveTo(row, 150, 60);
    await new Promise((r) => setTimeout(r, 40));
    expect(row.style.getPropertyValue('--glow-x')).toBe('50.0px');
    expect(row.style.getPropertyValue('--glow-y')).toBe('10.0px');
    stop();
  });

  it('换到另一行：旧行的标记被清掉', () => {
    document.body.innerHTML = `
      <div class="qs-item" id="a"></div>
      <div class="tree-row" id="b"></div>`;
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    defineRect(a, 0, 0, 100, 30);
    defineRect(b, 0, 40, 100, 30);
    const stop = initHoverGlow();

    moveTo(a, 10, 10);
    moveTo(b, 20, 50);
    expect(a.hasAttribute(GLOW_ATTR)).toBe(false);
    expect(a.style.getPropertyValue('--glow-x')).toBe('');
    expect(b.getAttribute(GLOW_ATTR)).toBe('');
    stop();
  });

  it('离开元素后清空', () => {
    document.body.innerHTML = '<div class="qs-item" id="row"></div>';
    const row = document.getElementById('row')!;
    defineRect(row, 0, 0, 100, 30);
    const stop = initHoverGlow();
    moveTo(row, 10, 10);

    row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(row.hasAttribute(GLOW_ATTR)).toBe(false);
    stop();
  });

  it('不在跟光面上的元素不产生标记', () => {
    document.body.innerHTML = '<div class="plain" id="p"></div>';
    const p = document.getElementById('p')!;
    defineRect(p, 0, 0, 100, 30);
    const stop = initHoverGlow();
    moveTo(p, 10, 10);
    expect(p.hasAttribute(GLOW_ATTR)).toBe(false);
    stop();
  });

  it('系统减少动态效果：完全不工作', () => {
    reduced = true;
    stubMedia();
    document.body.innerHTML = '<div class="qs-item" id="row"></div>';
    const row = document.getElementById('row')!;
    defineRect(row, 0, 0, 100, 30);
    const stop = initHoverGlow();
    moveTo(row, 10, 10);
    expect(row.hasAttribute(GLOW_ATTR)).toBe(false);
    stop();
  });

  it('纯触摸设备（无精确定位指针）：完全不工作', () => {
    fine = false;
    stubMedia();
    document.body.innerHTML = '<div class="qs-item" id="row"></div>';
    const row = document.getElementById('row')!;
    defineRect(row, 0, 0, 100, 30);
    const stop = initHoverGlow();
    moveTo(row, 10, 10);
    expect(row.hasAttribute(GLOW_ATTR)).toBe(false);
    stop();
  });
});
