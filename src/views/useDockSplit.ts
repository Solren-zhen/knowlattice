import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * 右侧「功能栏」的尺寸。
 *
 * 一条竖列里上下两块（上：视频笔记，下：AI 笔记）共享整栏宽度，各自记自己的高度：
 *   w       —— 整栏宽度（拖左边缘）
 *   videoH  —— 视频块高度（拖分隔条）
 *   agentH  —— AI 笔记块高度（拖分隔条，与视频块此消彼长）
 *
 * 上下拖分隔条 = **高度真的变**：两块同开时按总高互换（视频变高、笔记等量变矮），
 * 只开一块时直接改这一块的高度。
 * 前一版把上下拖换算成「改宽度」（视频整体等比缩放）：拖的是竖直分隔条、动的却是宽度，
 * 两块高度一点没变 —— 用户实测反馈为「上下长度大小不变，这设计不合理」。
 *
 * 视频块拖矮了也不裁画面：多出来的高度归下面的「写下这一刻 / 片段库」（.vn__body 自己滚），
 * 下界按播放器本体（标题栏 + 画面）量出来。
 */
const KEY = 'knowlattice.dock.split';
/** 视频显示宽高比：量不到块高时用栏宽反算一个合理基准 */
const W_PER_H = 16 / 9;
const MIN_W = 320;
/** 任何一块的高度下限：再矮连标题栏都放不下 */
const MIN_PANEL_H = 160;
/** 整栏的上下留白（.dock-col 的 bottom:12 + 顶部余量） */
const COL_INSET = 24;

interface Size {
  w: number | null;
  videoH: number | null;
  agentH: number | null;
}

function read(): Size {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return {
      w: v && Number(v.w) > 0 ? Number(v.w) : null,
      // 旧版本存过 videoH（「按 16:9 换算宽度」那版之前的高度值），照样认
      videoH: v && Number(v.videoH) > 0 ? Number(v.videoH) : null,
      agentH: v && Number(v.agentH) > 0 ? Number(v.agentH) : null,
    };
  } catch { return { w: null, videoH: null, agentH: null }; }
}

function write(size: Size) {
  try { localStorage.setItem(KEY, JSON.stringify(size)); } catch { /* 隐私模式：本次会话照样能用 */ }
}

function clampWidth(w: number) {
  const maxW = Math.max(MIN_W, window.innerWidth - 80);
  return Math.round(Math.min(Math.max(MIN_W, w), maxW));
}

/**
 * 「宽度一变，16:9 的画面就变高」——块高是钉住的（--dock-video-h），变高的画面会被切掉一截。
 * A 方案对用户的承诺是「画面永不裁切」，所以改宽度时要把块高抬到至少装得下画面：
 *   padX    = 块宽 − 画面宽（.vn 的内边距与边框）
 *   chromeH = 块高 − 画面高（标题栏、来源行、清晰度条…）
 * 量不到（chromeH 为 0）就返回 0 = 不动，避免凭空改高度。
 */
function minVideoHForWidth(w: number, padX: number, chromeH: number) {
  if (chromeH <= 0) return 0;
  const frameH = Math.max(60, Math.round(Math.max(0, w - padX) * 9 / 16));
  return chromeH + frameH;
}

/**
 * 分隔条管哪一块 / 往哪个方向长。
 *   trade —— 两块同开，分隔条夹在中间：往下拖视频（上面那块）变高，笔记等量变矮；
 *   video / agent —— 只开一块时，分隔条贴在这一块的上沿：往上拖，这一块变高。
 * 方向不写死，按分隔条与目标块的实际位置算：贴在该块上方 = 往上拖变大（-1），
 * 夹在该块下方 = 往下拖变大（+1）。
 */
type Mode = 'trade' | 'video' | 'agent';

interface Layout {
  mode: Mode;
  dir: 1 | -1;
  /** 视频块当前高度（trade / video 用） */
  video: number;
  /** AI 笔记块当前高度（trade / agent 用） */
  agent: number;
  /** 拖动手柄那一段能缩到的最小值（视频不能矮到裁画面） */
  min: number;
  /** 拖动手柄那一段能放到多大（trade 时给另一块留 MIN_PANEL_H） */
  max: number;
  /** 画面比整栏窄掉多少（内边距 + 边框） */
  padX: number;
  /** 块内除画面以外还有多高（标题栏、来源行、清晰度条…） */
  chromeH: number;
}

/** 量一次当前布局；量不到布局（jsdom / 面板还没渲染）时按 MIN_PANEL_H 兜底 */
function measure(root: HTMLElement | null, handle?: HTMLElement | null): Layout {
  const videoEl = root?.querySelector<HTMLElement>('.video-note-wrap') ?? null;
  const agentEl = root?.querySelector<HTMLElement>(':scope > .agent-panel') ?? null;
  const bodyEl = videoEl?.querySelector<HTMLElement>('.vn__body') ?? null;
  const vRect = videoEl?.getBoundingClientRect();
  const aRect = agentEl?.getBoundingClientRect();
  const bRect = bodyEl?.getBoundingClientRect();
  const playerEl = videoEl?.querySelector<HTMLElement>('.vn__frame, .vn__video') ?? null;
  const pRect = playerEl?.getBoundingClientRect();
  const padX = vRect && pRect ? Math.max(0, Math.round(vRect.width - pRect.width)) : 0;
  const chromeH = vRect && pRect && pRect.height > 0
    ? Math.max(0, Math.round(vRect.height - pRect.height)) : 0;
  const hRect = handle?.getBoundingClientRect();

  // 标题栏 + 画面 + 内边距 = 块高减去写作/片段库那一段：视频块能缩到的最小高度
  const fixedH = vRect && bRect && bRect.height > 0
    ? Math.max(0, Math.round(vRect.height - bRect.height)) : 0;
  /*
   * 画面本体高度。fixedH 只算到「块高 − 可滚动区」= 标题栏 + 内边距，不含画面，
   * 于是拖到最矮（160）时 16:9 的画面有 160 高、留给它的只有 65 → 画面被推进
   * 滚动区里切掉一截（实测 frame bottom 243 > 块 bottom 190）。
   * 下界必须加上画面，才能兑现「拖矮也不裁画面」。
   */
  const playerH = pRect && pRect.height > 0 ? Math.round(pRect.height) : 0;
  const video = vRect && vRect.height > 0 ? Math.round(vRect.height) : 0;
  const agent = aRect && aRect.height > 0 ? Math.round(aRect.height) : 0;
  const viewportMax = Math.max(MIN_PANEL_H, Math.round(window.innerHeight - COL_INSET));

  const mode: Mode = videoEl && agentEl ? 'trade' : videoEl ? 'video' : 'agent';
  const target = mode === 'agent' ? aRect : vRect;
  const dir: 1 | -1 = hRect && target && hRect.top < target.top ? -1 : 1;

  if (mode === 'trade') {
    const total = video + agent;
    const min = Math.max(MIN_PANEL_H, fixedH + playerH);
    return { mode, dir, video, agent, min, max: Math.max(min, total - MIN_PANEL_H), padX, chromeH };
  }
  if (mode === 'video') {
    const min = Math.max(MIN_PANEL_H, fixedH + playerH);
    return { mode, dir, video, agent, min, max: Math.max(min, viewportMax), padX, chromeH };
  }
  return { mode, dir, video, agent, min: MIN_PANEL_H, max: Math.max(MIN_PANEL_H, viewportMax), padX, chromeH };
}

export interface DockSplit {
  style: CSSProperties;
  /** 整栏宽度（用户拖过的 px；没拖过是 null，用 CSS 默认值）——主区让位宽度要跟着它走 */
  width: number | null;
  /** 左边缘：拖宽度 */
  onWidthDown: (e: ReactPointerEvent<HTMLElement>) => void;
  /** 分隔条：上下拖改高度（两块同开时按总高互换） */
  onSplitDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (axis: 'w' | 'h') => (e: ReactKeyboardEvent<HTMLElement>) => void;
  reset: () => void;
}

export function useDockSplit(): DockSplit {
  const [size, setSize] = useState<Size>(read);
  const drag = useRef<{
    axis: 'w' | 'h';
    startX: number;
    startY: number;
    /** 整栏宽度（左右拖的基准） */
    baseW: number;
    /** 上下拖开始时的布局快照：基准高度 / 上下限 / 方向 */
    layout: Layout;
    pointerId: number;
    handle: HTMLElement;
    el: HTMLElement;
    /** 摘掉 window 级监听（begin 里挂上，finish 里调用） */
    cleanup: () => void;
  } | null>(null);

  /**
   * 最新尺寸的镜像：拖拽结束要用它写盘。
   * 不能写成 `setSize(prev => { write(prev); return prev })` —— 返回同一引用时 React 会跳过 updater，
   * 真浏览器里写盘根本不执行（jsdom 却会执行，于是「测试绿、实际丢」）。一律先算 next → 同步 ref → 再 setState。
   */
  const latest = useRef<Size>(read());
  const apply = useCallback((next: Size) => {
    latest.current = next;
    setSize(next);
  }, []);

  /** 两块高度之和超过视口时先压笔记、再压视频；换窗口后用得上 */
  const fitHeights = useCallback((prev: Size): Size => {
    if (prev.videoH == null && prev.agentH == null) return prev;
    const avail = Math.max(MIN_PANEL_H, Math.round(window.innerHeight - COL_INSET));
    if ((prev.videoH ?? 0) + (prev.agentH ?? 0) <= avail) return prev;
    let agentH = prev.agentH;
    let videoH = prev.videoH;
    if (agentH != null) agentH = Math.max(MIN_PANEL_H, avail - (videoH ?? 0));
    if ((videoH ?? 0) + (agentH ?? 0) > avail) videoH = Math.max(MIN_PANEL_H, avail - (agentH ?? 0));
    return { ...prev, videoH, agentH };
  }, []);

  /** 视口变化时把越界宽度 / 高度夹回来（拖到 1200px 宽后换小屏，否则整栏跑出屏幕外） */
  useEffect(() => {
    const onResize = () => {
      const prev = latest.current;
      if (prev.w == null && prev.videoH == null && prev.agentH == null) return;
      const w = prev.w == null ? null : clampWidth(prev.w);
      const fitted = fitHeights(prev);
      if (w === prev.w && fitted.videoH === prev.videoH && fitted.agentH === prev.agentH) return;
      const next = { ...fitted, w };
      apply(next);
      write(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply, fitHeights]);

  /** 首帧按当前视口再夹一次：上一个窗口尺寸下存的值，可能把整栏撑出屏幕 */
  useEffect(() => {
    const prev = latest.current;
    if (prev.w == null && prev.videoH == null && prev.agentH == null) return;
    // 用同一个 clampWidth：早先这里单独写了 innerWidth - 120，窄视口下会把宽度压到
    // MIN_W(320) 以下（412px 视口 → 292），首帧就比两条抓手能调出的最小宽度还窄。
    const w = prev.w == null ? null : clampWidth(prev.w);
    const fitted = fitHeights(prev);
    /*
     * 存档里的视频块高度可能是「下界还没把画面算进去」那版留下的（实测存过 160，
     * 而 16:9 的画面要 160、标题栏还要 65 → 首帧画面被切掉一截，拖一下才恢复）。
     * 首帧按实测下界抬上来；量不到布局时 measure 退回 MIN_PANEL_H，不会误伤。
     */
    const layout = measure(document.querySelector<HTMLElement>('[data-dock-root]'));
    const videoH = fitted.videoH != null && layout.mode !== 'agent' && fitted.videoH < layout.min
      ? layout.min
      : fitted.videoH;
    if (w === prev.w && videoH === prev.videoH && fitted.agentH === prev.agentH) return;
    const next = fitHeights({ ...fitted, videoH, w });
    apply(next);
    write(next);
  }, [apply, fitHeights]);

  /** 上下拖：把手柄位移换算成高度变化（方向由 layout.dir 定） */
  const dragHeights = useCallback((clientY: number) => {
    const d = drag.current;
    if (!d || d.axis !== 'h') return;
    const { layout } = d;
    const delta = layout.dir * (clientY - d.startY);
    const clampH = (v: number) => Math.round(Math.min(Math.max(layout.min, v), layout.max));

    if (layout.mode === 'trade') {
      // 两块共用总高：视频长多少，笔记就矮多少
      const videoH = clampH(layout.video + delta);
      apply({ ...latest.current, videoH, agentH: Math.round(layout.video + layout.agent - videoH) });
    } else if (layout.mode === 'video') {
      apply({ ...latest.current, videoH: clampH(layout.video + delta) });
    } else {
      apply({ ...latest.current, agentH: clampH(layout.agent + delta) });
    }
  }, [apply]);

  /** 把指针位置换算成新尺寸（左右拖改宽度；上下拖改高度） */
  const applyDragTo = useCallback((clientX: number, clientY: number) => {
    const d = drag.current;
    if (!d) return;
    if (d.axis === 'w') {
      // 列贴右边缘：向左拖变宽
      const w = clampWidth(d.baseW + (d.startX - clientX));
      const next: Size = { ...latest.current, w };
      /*
       * 拉宽 → 16:9 的画面跟着变高，而块高是钉住的（--dock-video-h）：
       * 不把块高抬起来，画面就会被块底切掉一截（A 方案对用户的承诺是「永不裁画面」）。
       * 抬起来多占的高度由 fitHeights 从 AI 笔记里扣。
       */
      const need = minVideoHForWidth(w, d.layout.padX, d.layout.chromeH);
      if (next.videoH != null && need > next.videoH) next.videoH = need;
      apply(fitHeights(next));
      return;
    }
    dragHeights(clientY);
  }, [apply, dragHeights, fitHeights]);

  /** 收尾：清监听、放捕获、写盘。幂等——React 处理器与 window 监听可能都会调到 */
  const finish = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.cleanup();
    try { d.handle.releasePointerCapture?.(d.pointerId); } catch { /* 指针已消失 */ }
    // 松手才写盘：拖动过程中每帧写 localStorage 会掉帧
    write(latest.current);
  }, []);

  /**
   * 拖动期间用 **window 级** pointermove/pointerup 收尾，而不是只靠 pointer capture。
   * 实测（真实鼠标经 CDP 注入同样复现）：`setPointerCapture` 一旦没生效，指针离开抓手那 8px
   * 之后事件就全丢了——表现是「拖到一半卡住、松手也不落盘」（367 → 359 就停）。
   * window 监听与指针在哪无关，才是稳的那一半。
   */
  const begin = useCallback((axis: 'w' | 'h') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget.closest<HTMLElement>('[data-dock-root]');
    if (!el) return;

    const layout = measure(el, e.currentTarget);
    // 量不到布局（jsdom / 视频还没渲染）时用记下来的值兜底，别从 0 起算
    if (layout.mode === 'video' && layout.video <= 0) {
      layout.video = latest.current.videoH ?? Math.round((el.getBoundingClientRect().width || 560) / W_PER_H) + 130;
      layout.min = Math.max(MIN_PANEL_H, Math.min(layout.min, layout.video));
    }
    if (layout.mode === 'trade') {
      if (layout.video <= 0) layout.video = latest.current.videoH ?? MIN_PANEL_H;
      if (layout.agent <= 0) layout.agent = latest.current.agentH ?? MIN_PANEL_H;
      layout.max = Math.max(layout.min, layout.video + layout.agent - MIN_PANEL_H);
    }
    if (layout.mode === 'agent' && layout.agent <= 0) {
      layout.agent = latest.current.agentH ?? Math.round(window.innerHeight * 0.72);
    }

    const onWinMove = (ev: PointerEvent) => applyDragTo(ev.clientX, ev.clientY);
    const onWinEnd = () => finish();
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinEnd);
    window.addEventListener('pointercancel', onWinEnd);
    const cleanup = () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinEnd);
      window.removeEventListener('pointercancel', onWinEnd);
    };

    drag.current = {
      axis,
      startX: e.clientX,
      startY: e.clientY,
      // 基准必须是整栏当前宽度：早先用过「整栏高度的 46%」，第一次拖动会先跳到那个值再加减位移
      baseW: el.getBoundingClientRect().width || MIN_W,
      layout,
      pointerId: e.pointerId,
      handle: e.currentTarget,
      el,
      cleanup,
    };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 捕获失败也无妨 */ }
    e.preventDefault();
  }, [applyDragTo, finish]);

  const onMove = useCallback((e: ReactPointerEvent<HTMLElement>) => applyDragTo(e.clientX, e.clientY), [applyDragTo]);
  const onUp = useCallback(() => finish(), [finish]);

  const step = useCallback((axis: 'w' | 'h') => (e: ReactKeyboardEvent<HTMLElement>) => {
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -16
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 16 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const root = e.currentTarget.closest<HTMLElement>('[data-dock-root]');
    const prev = latest.current;

    if (axis === 'h') {
      // 以屏幕上的实际高度为基准（存的值可能是旧窗口尺寸下的）
      const layout = measure(root, e.currentTarget);
      if (layout.mode === 'trade') {
        const video = layout.video || prev.videoH || MIN_PANEL_H;
        const agentBase = layout.agent || prev.agentH || MIN_PANEL_H;
        const max = Math.max(MIN_PANEL_H, video + agentBase - MIN_PANEL_H);
        const videoH = Math.round(Math.min(Math.max(layout.min, video + layout.dir * delta), max));
        const next = { ...prev, videoH, agentH: Math.round(video + agentBase - videoH) };
        apply(next);
        write(next);
        return;
      }
      if (layout.mode === 'video') {
        const video = layout.video || prev.videoH || MIN_PANEL_H;
        const videoH = Math.round(Math.min(Math.max(layout.min, video + layout.dir * delta), layout.max));
        const next = { ...prev, videoH };
        apply(next);
        write(next);
        return;
      }
      const agent = layout.agent || prev.agentH || MIN_PANEL_H;
      const next = { ...prev, agentH: Math.round(Math.min(Math.max(layout.min, agent + layout.dir * delta), layout.max)) };
      apply(next);
      write(next);
      return;
    }

    // 键盘微调以「当前实际宽度」为基准：prev 里还是 null、或者量到 0（面板还没布局）
    // 都不能当基数用，否则按一下方向键，面板会跳到 320/560 这类与眼前无关的尺寸。
    const measuredW = Math.round(root?.getBoundingClientRect().width ?? 0);
    const curW = prev.w && prev.w > 0 ? prev.w : measuredW || 560;
    const w = clampWidth(curW - delta);
    const layout = measure(root, e.currentTarget);
    const next: Size = { ...prev, w };
    // 键盘加宽同样要把块高抬起来，否则画面被切（同 applyDragTo 的注释）
    const need = minVideoHForWidth(w, layout.padX, layout.chromeH);
    if (next.videoH != null && need > next.videoH) next.videoH = need;
    const balanced = fitHeights(next);
    apply(balanced);
    write(balanced);
  }, [apply, fitHeights]);

  const reset = useCallback(() => {
    const next = { w: null, videoH: null, agentH: null };
    apply(next);
    write(next);
  }, [apply]);

  const style: CSSProperties = {
    ...(size.w != null ? { width: `${size.w}px` } : null),
    ...(size.videoH != null ? { ['--dock-video-h' as string]: `${size.videoH}px` } : null),
    ...(size.agentH != null ? { ['--dock-agent-h' as string]: `${size.agentH}px` } : null),
  } as CSSProperties;

  return {
    style,
    width: size.w,
    onWidthDown: begin('w'),
    onSplitDown: begin('h'),
    onMove,
    onUp,
    onKeyDown: step,
    reset,
  };
}
