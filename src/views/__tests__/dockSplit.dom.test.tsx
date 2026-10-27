// @vitest-environment jsdom
/**
 * 「右侧功能栏」尺寸的 DOM 验收（useDockSplit）。
 *
 * 守六件事：
 *  ① 拖左边缘 = 改整栏宽度；落盘的值等于屏幕上的宽度；
 *  ② 键盘方向键也能调宽度（无障碍），且以当前实际宽度为基准；
 *  ③ 两块同开时上下拖分隔条 = **两块按总高互换高度**（视频 +80 ⇒ 笔记 −80），整栏高度不变；
 *     前一版拖竖直分隔条只改宽度，两块高度一动不动 —— 用户实测反馈「上下长度大小不变」；
 *  ④ 视频块拖矮有下限：矮到「标题栏 + 画面」为止（这里块高 − .vn__body），不裁画面；
 *     拖高有上限：同开时上面那块至少留 MIN_PANEL_H；
 *  ⑤ 只开视频时也有一条分隔条（贴在块上沿），上下拖直接改这一块的高度；
 *  ⑥ 松手后写盘的值必须等于屏幕上正在用的值（曾经在 setState updater 里写盘，
 *     返回同一引用被 React 跳过 → jsdom 会执行、真浏览器不执行，形成「测试绿、实际丢」）。
 *
 * 注：jsdom 没有真实布局（getBoundingClientRect 全 0），需要像素的地方在这里显式打桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDockSplit } from '../useDockSplit';

const KEY = 'knowlattice.dock.split';
const SPLIT_LABEL = '上下拖动调整高度（方向键微调，双击复位）';

function Harness({ agent = true }: { agent?: boolean }) {
  const dock = useDockSplit();
  return (
    <div className="dock-col" data-dock-root style={dock.style}>
      <button
        type="button"
        className="dock-col__grip"
        aria-label="拖宽"
        onPointerDown={dock.onWidthDown}
        onPointerMove={dock.onMove}
        onPointerUp={dock.onUp}
        onPointerCancel={dock.onUp}
        onKeyDown={dock.onKeyDown('w')}
        onDoubleClick={dock.reset}
      />
      {/* 只开视频：分隔条贴在视频块上沿（与 Workspace 的渲染顺序一致） */}
      {!agent && (
        <div
          className="dock-col__split"
          data-testid="split"
          role="separator"
          tabIndex={0}
          aria-label={SPLIT_LABEL}
          onPointerDown={dock.onSplitDown}
          onPointerMove={dock.onMove}
          onPointerUp={dock.onUp}
          onPointerCancel={dock.onUp}
          onKeyDown={dock.onKeyDown('h')}
          onDoubleClick={dock.reset}
        />
      )}
      <div className="video-note-wrap" data-testid="video-block">
        <div className="vn__head" />
        <div className="vn__stage" data-testid="vn-frame" />
        {/* 写作 / 片段库：块高减去它就是「标题栏 + 画面」，也就是视频块能缩到的最小高度 */}
        <div className="vn__body" data-testid="vn-body" />
      </div>
      {agent && (
        <>
          {/* 两块同开：分隔条夹在视频与 AI 笔记之间 */}
          <div
            className="dock-col__split"
            data-testid="split"
            role="separator"
            tabIndex={0}
            aria-label={SPLIT_LABEL}
            onPointerDown={dock.onSplitDown}
            onPointerMove={dock.onMove}
            onPointerUp={dock.onUp}
            onPointerCancel={dock.onUp}
            onKeyDown={dock.onKeyDown('h')}
            onDoubleClick={dock.reset}
          />
          <div className="agent-panel" data-testid="agent-panel" />
        </>
      )}
    </div>
  );
}

const root = () => screen.getByLabelText('拖宽').closest<HTMLElement>('[data-dock-root]')!;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
  w: number | null; videoH: number | null; agentH: number | null;
} | null;
const cssVar = (name: string) => root().style.getPropertyValue(name);

function rect(width: number, height: number, top = 0): DOMRect {
  return {
    width, height, top, left: 0, right: width, bottom: top + height, x: 0, y: top, toJSON: () => ({}),
  } as DOMRect;
}

/**
 * 给整栏、视频块、块内的播放器区 / 写作区、AI 笔记、分隔条各打一个「真实」布局。
 * jsdom 没有布局：不打桩，基准会退化成兜底常量，上下限也全被夹到 MIN_PANEL_H。
 */
function stubLayout(opts: {
  dockW?: number; blockH?: number; bodyH?: number; agentH?: number; splitTop?: number; blockTop?: number;
} = {}) {
  const dockW = opts.dockW ?? 560;
  vi.spyOn(root(), 'getBoundingClientRect').mockReturnValue(rect(dockW, 900));
  vi.spyOn(screen.getByTestId('video-block'), 'getBoundingClientRect')
    .mockReturnValue(rect(dockW, opts.blockH ?? 400, opts.blockTop ?? 0));
  vi.spyOn(screen.getByTestId('vn-frame'), 'getBoundingClientRect')
    .mockReturnValue(rect(dockW, (opts.blockH ?? 400) - 80 - (opts.bodyH ?? 80)));
  vi.spyOn(screen.getByTestId('vn-body'), 'getBoundingClientRect')
    .mockReturnValue(rect(dockW, opts.bodyH ?? 80));
  vi.spyOn(screen.getByTestId('split'), 'getBoundingClientRect')
    .mockReturnValue(rect(dockW, 10, opts.splitTop ?? 0));
  const agent = screen.queryByTestId('agent-panel');
  if (agent) vi.spyOn(agent, 'getBoundingClientRect').mockReturnValue(rect(dockW, opts.agentH ?? 300));
}

describe('useDockSplit · 功能栏尺寸', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('拖左边缘：向左拖变宽，松手后落盘的值等于屏幕上的宽度', () => {
    render(<Harness />);
    const grip = screen.getByLabelText('拖宽');

    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 440, clientY: 300, pointerId: 1 });
    const applied = root().style.width;
    expect(applied).toMatch(/^\d+px$/);
    // 拖动过程中不写盘（避免每帧一次 localStorage）
    expect(localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(grip, { clientX: 440, clientY: 300, pointerId: 1 });
    // 关键：落盘值必须与正在生效的宽度一致（曾经这里写的是被 React 跳过的 updater）
    expect(stored()?.w).toBe(Number.parseInt(applied, 10));
  });

  it('键盘微调宽度：以当前尺寸为基准，并立即落盘', () => {
    render(<Harness />);
    const grip = screen.getByLabelText('拖宽');

    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    const first = stored()?.w ?? 0;
    expect(first).toBeGreaterThan(0);

    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(stored()?.w ?? 0).toBe(first - 16);
  });

  it('两块同开：往下拖分隔条 ⇒ 视频变高、笔记等量变矮，总高不变', () => {
    render(<Harness />);
    stubLayout({ blockH: 400, bodyH: 80, agentH: 300 }); // 必须 render 之后再打桩
    const split = screen.getByTestId('split');

    fireEvent.pointerDown(split, { button: 0, clientX: 300, clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(split, { clientX: 300, clientY: 780, pointerId: 1 });
    expect(cssVar('--dock-video-h')).toBe('480px');
    expect(cssVar('--dock-agent-h')).toBe('220px');
    // 拖动中不写盘
    expect(localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(split, { clientX: 300, clientY: 780, pointerId: 1 });
    expect(stored()).toMatchObject({ videoH: 480, agentH: 220 });
  });

  it('往下拖过头：视频最多长到「笔记只剩 160」，笔记不会被挤没', () => {
    render(<Harness />);
    stubLayout({ blockH: 400, bodyH: 80, agentH: 300 }); // 总高 700 ⇒ 视频上限 540
    const split = screen.getByTestId('split');

    fireEvent.pointerDown(split, { button: 0, clientX: 300, clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(split, { clientX: 300, clientY: 1000, pointerId: 1 });
    fireEvent.pointerUp(split, { clientX: 300, clientY: 1000, pointerId: 1 });

    expect(stored()).toMatchObject({ videoH: 540, agentH: 160 });
  });

  it('往上拖过头：视频收回到「标题栏 + 画面」为止（块高 − 写作区 = 320），不裁画面', () => {
    render(<Harness />);
    stubLayout({ blockH: 400, bodyH: 80, agentH: 300 });
    const split = screen.getByTestId('split');

    fireEvent.pointerDown(split, { button: 0, clientX: 300, clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(split, { clientX: 300, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(split, { clientX: 300, clientY: 0, pointerId: 1 });

    expect(stored()).toMatchObject({ videoH: 320, agentH: 380 });
  });

  it('只开视频：分隔条贴在块上沿，往上拖整块变高', () => {
    render(<Harness agent={false} />);
    stubLayout({ blockH: 400, bodyH: 80, splitTop: 100, blockTop: 200 });
    const split = screen.getByTestId('split');

    // 往上拖 80：块长高到 480
    fireEvent.pointerDown(split, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(split, { clientX: 300, clientY: 220, pointerId: 1 });
    fireEvent.pointerUp(split, { clientX: 300, clientY: 220, pointerId: 1 });

    expect(stored()?.videoH).toBe(480);
    expect(stored()?.agentH).toBeNull();
    expect(cssVar('--dock-video-h')).toBe('480px');
  });

  it('双击回到默认：清掉宽度与两块高度并清空记录', () => {
    render(<Harness />);
    stubLayout({ blockH: 400, bodyH: 80, agentH: 300 });
    const split = screen.getByTestId('split');
    fireEvent.pointerDown(split, { button: 0, clientX: 300, clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(split, { clientX: 300, clientY: 760, pointerId: 1 });
    fireEvent.pointerUp(split, { clientX: 300, clientY: 760, pointerId: 1 });
    expect(stored()?.videoH).toBe(460);

    fireEvent.doubleClick(split);
    expect(cssVar('--dock-video-h')).toBe('');
    expect(cssVar('--dock-agent-h')).toBe('');
    expect(stored()).toEqual({ w: null, videoH: null, agentH: null });
  });

  /**
   * ⑦ 拉宽 ⇒ 16:9 的画面变高，钉住的块高必须跟着抬，否则画面被块底切掉。
   *    A 方案（上下拖 = 分高度、画面尺寸只由宽度定）对用户的承诺是「永不裁画面」，
   *    这条是它的必要条件：宽度成了新的主人，高度至少要让开画面。
   */
  it('拉宽后画面变高：块高自动抬到装得下画面，多占的高度从 AI 笔记里扣', () => {
    localStorage.setItem(KEY, JSON.stringify({ w: 560, videoH: 400, agentH: 300 }));
    render(<Harness />);
    stubLayout({ dockW: 560, blockH: 400, bodyH: 80, agentH: 300 });
    // 真实播放器盒子：块 560 宽里占 400（padX 160），块 400 高里占 225（chrome 175）
    const frame = document.createElement('div');
    frame.className = 'vn__frame';
    screen.getByTestId('video-block').appendChild(frame);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(400, 225));

    const grip = screen.getByLabelText('拖宽');
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 380, clientY: 300, pointerId: 1 }); // 向左 120 = 变宽 120
    fireEvent.pointerUp(grip, { clientX: 380, clientY: 300, pointerId: 1 });

    // 画面高 = (680 − 160) × 9/16 ≈ 293；块高 = chrome 175 + 293 = 468；笔记 744 − 468 = 276
    expect(stored()).toMatchObject({ w: 680, videoH: 468, agentH: 276 });
    expect(cssVar('--dock-video-h')).toBe('468px');
  });
});
