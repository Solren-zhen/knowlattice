/**
 * 浮层面板的拖动（视频笔记这类常驻小窗）。
 *
 * 只做一件事：把「抓着头往哪挪」记成 transform 偏移，并把位置存下来。
 * 刻意不引入拖拽库 —— 一个 pointermove + clamp 就够，库的体积是这个文件的十倍。
 *
 * 四条约束都是实际会踩的：
 * · **抓手必须留在屏幕内**：水平方向至少留 80px；垂直方向不让标题栏离开视口。
 *   面板主体可以移出屏幕，但唯一能拖回来的标题栏不行。
 * · **标题栏里的控件不参与拖动**：按钮的 pointerdown 不能被抓手吞掉。
 * · **拖动过程不经过 React state**：直接写 element.style.transform，
 *   每帧 setState 会把整个面板重渲染，拖起来发黏；松手时再同步一次状态。
 * · **只在松手时写 localStorage**。
 */
import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent,
} from 'react';

const KEY_PREFIX = 'knowlattice-panel-pos:';
const SIZE_PREFIX = 'knowlattice-panel-size:';
/** 拖到边缘后仍要留在屏幕里的最小可见尺寸 */
const MIN_VISIBLE_X = 80;
const MIN_VISIBLE_Y = 40;

interface Offset {
  x: number;
  y: number;
}

function read(key: string): Offset {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw) as Partial<Offset>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return { x: 0, y: 0 };
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return { x: 0, y: 0 };
    return { x: parsed.x, y: parsed.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

export interface PanelDrag {
  /** 挂在被拖动的元素上 */
  style: CSSProperties;
  /** 挂在抓手（标题栏）上 */
  onHandlePointerDown: (e: PointerEvent<HTMLElement>) => void;
  /** 复位到默认位置 */
  reset: () => void;
}

export interface PanelResize {
  /** 挂在被调整尺寸的面板根节点上 */
  style: CSSProperties;
  /** 挂在左上角的缩放抓手上 */
  onHandlePointerDown: (e: PointerEvent<HTMLElement>) => void;
  /** 键盘可访问：左/上放大，右/下缩小 */
  onHandleKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** 恢复默认自适应宽高 */
  reset: () => void;
}

interface Size {
  w: number;
  h: number;
}

function readSize(key: string): Size | null {
  try {
    const raw = localStorage.getItem(SIZE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Size>;
    if (!Number.isFinite(parsed.w) || !Number.isFinite(parsed.h)) return null;
    if ((parsed.w ?? 0) <= 0 || (parsed.h ?? 0) <= 0) return null;
    return { w: Math.round(parsed.w!), h: Math.round(parsed.h!) };
  } catch {
    return null;
  }
}

function saveSize(key: string, size: Size): void {
  try {
    localStorage.setItem(SIZE_PREFIX + key, JSON.stringify(size));
  } catch {
    // 存不下只影响下次打开，不阻塞本次缩放
  }
}

/**
 * 弹窗（不是浮窗）的拖动：抓手是「除控件以外的任意位置」。
 *
 * 与 usePanelDrag 的区别是有意的：
 * · 不持久化位置——弹窗是临时界面，下次打开回到中间才符合预期；
 * · 按在 input/button/textarea 上不拖，否则控件永远点不动（拖动会把点击吞掉）。
 */
const NO_DRAG =
  'input, textarea, select, button, a, label, summary, [contenteditable="true"], [data-no-drag]';

export interface DialogDrag {
  style: CSSProperties | undefined;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
}

export function useDialogDrag(getEl: () => HTMLElement | null): DialogDrag {
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const drag = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    el: HTMLElement;
    moved: Offset;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return; // 右键留给浏览器菜单
      const target = e.target as HTMLElement | null;
      if (target?.closest(NO_DRAG)) return;
      const el = getEl();
      if (!el) return;
      const rect = el.getBoundingClientRect();
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: offset.x,
        baseY: offset.y,
        minX: MIN_VISIBLE_X - rect.width - rect.left,
        maxX: window.innerWidth - MIN_VISIBLE_X - rect.left,
        minY: MIN_VISIBLE_Y - rect.height - rect.top,
        maxY: window.innerHeight - MIN_VISIBLE_Y - rect.top,
        el,
        moved: offset,
      };
    },
    [getEl, offset],
  );

  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + (event.clientX - d.startX), d.minX), d.maxX);
      const y = Math.min(Math.max(d.baseY + (event.clientY - d.startY), d.minY), d.maxY);
      d.moved = { x, y };
      // 直接写 style：面板里常有长列表，每帧 setState 会让整棵树重渲染，拖起来掉帧
      d.el.style.transform = `translate(${x}px, ${y}px)`;
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setOffset(d.moved);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return {
    // 只在真的拖过之后才写 transform：transform 会给 fixed 子元素造新包含块，
    // 没动过的弹窗保持原样，免得里面的浮层跟着错位
    style: offset.x || offset.y ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined,
    onPointerDown,
  };
}

export function usePanelDrag(key: string): PanelDrag {
  const [pos, setPos] = useState<Offset>(() => read(key));
  const drag = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    el: HTMLElement;
    moved: Offset;
  } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return; // 只接左键/触摸，右键留给浏览器菜单
      // 标题栏里还有「本地文件 / 关闭」等控件：按在它们上面时不能把点击吞成拖动
      if ((e.target as HTMLElement | null)?.closest(NO_DRAG)) return;
      const handle = e.currentTarget;
      // 标题栏外面还可能包着内容容器；真正带固定定位和 transform 的是标了根节点的外框。
      const el = handle.closest<HTMLElement>('[data-panel-drag-root]') ?? handle.parentElement;
      if (!el) return;
      const elRect = el.getBoundingClientRect();
      /**
       * 夹边量的是**整块面板**，不是抓手：抓手可以挂在面板底部（右侧功能栏的下方拖条），
       * 按抓手上沿算会把整窗拖出屏幕顶。抓手在顶部时两者重合（标题栏就是面板上沿），
       * 所以这处换算与旧行为等价。
       *
       * rect 已包含当前的 translate。夹边范围必须换算回「未位移」的默认矩形，
       * 否则会把 base 重复计一次：面板停在右边界后再往右拖，maxX 会变成很小的值，
       * translate 直接被夹回 0，看起来就是整窗突然跳回默认位置。
       */
      const baseLeft = elRect.left - pos.x;
      const baseTop = elRect.top - pos.y;
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: pos.x,
        baseY: pos.y,
        // 允许的位移范围：让 elRect.left + dx 落在 [MIN_VISIBLE_X - width, innerWidth - MIN_VISIBLE_X]
        minX: MIN_VISIBLE_X - elRect.width - baseLeft,
        maxX: window.innerWidth - MIN_VISIBLE_X - baseLeft,
        // 上沿不许离开视口顶：否则整块面板只剩底部 40px 可见，用户再也抓不回来
        //（抓手上沿离顶 40px 也没有意义——那意味着面板顶上那截已经在屏幕外）。
        minY: -baseTop,
        maxY: window.innerHeight - MIN_VISIBLE_Y - baseTop,
        el,
        moved: pos,
      };
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    },
    [pos],
  );

  useEffect(() => {
    const apply = (x: number, y: number) => {
      const d = drag.current;
      if (d) d.el.style.transform = `translate(${x}px, ${y}px)`;
    };
    const onMove = (e: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + (e.clientX - d.startX), d.minX), d.maxX);
      const y = Math.min(Math.max(d.baseY + (e.clientY - d.startY), d.minY), d.maxY);
      d.moved = { x, y };
      apply(x, y);
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setPos(d.moved);
      try {
        localStorage.setItem(KEY_PREFIX + key, JSON.stringify(d.moved));
      } catch {
        // 存不下就只在本次会话里生效，不影响拖动本身
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [key]);

  const reset = useCallback(() => {
    // 双击复位时可能还有一次点击的 pointerup 没走完：先丢掉拖动态，
    // 否则那次 pointerup 会把刚归零的位置又写回夹边值（表现为「双击复位后还差一截」）
    drag.current = null;
    setPos({ x: 0, y: 0 });
    try {
      localStorage.removeItem(KEY_PREFIX + key);
    } catch {
      // 忽略：位置本来也只在本次会话内有效
    }
  }, [key]);

  return {
    // touch-action:none 只挂在标题栏（见 .vn__head--drag）；铺到整块面板会让手机端片段库无法滚动
    style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    onHandlePointerDown,
    reset,
  };
}

/**
 * 浮窗尺寸缩放：面板的 right/bottom 固定，所以抓手放在左上角。
 * 向左/上拖 = 面板向右下固定、向左上变大；向右/下拖 = 缩小，指针与抓手始终同向。
 */
export function usePanelResize(
  key: string,
  limits: { minWidth?: number; minHeight?: number } = {},
): PanelResize {
  const minWidth = limits.minWidth ?? 360;
  const minHeight = limits.minHeight ?? 260;
  const [size, setSize] = useState<Size | null>(() => readSize(key));
  const resize = useRef<{
    startX: number;
    startY: number;
    baseW: number;
    baseH: number;
    minW: number;
    maxW: number;
    minH: number;
    maxH: number;
    el: HTMLElement;
    moved: Size | null;
  } | null>(null);

  const bounds = useCallback(() => ({
    minW: Math.min(minWidth, Math.max(120, window.innerWidth - 36)),
    minH: Math.min(minHeight, Math.max(120, window.innerHeight - 36)),
    maxW: Math.max(120, window.innerWidth - 36),
    maxH: Math.max(120, window.innerHeight - 36),
  }), [minHeight, minWidth]);

  const onHandlePointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const el = handle.closest<HTMLElement>('[data-panel-drag-root]') ?? handle.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { minW, minH, maxW, maxH } = bounds();
    resize.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseW: rect.width,
      baseH: rect.height,
      minW,
      // 上限不能小于「面板当前尺寸」：AI 问答默认就贴着整高（实测 900 > innerHeight-36 = 864），
      // 往上拖本来是「放大」，却先被夹到 864 —— 越往上拖反而越小。
      maxW: Math.max(maxW, rect.width),
      maxH: Math.max(maxH, rect.height),
      minH,
      el,
      moved: null,
    };
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, [bounds]);

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const d = resize.current;
      if (!d) return;
      const w = Math.round(Math.min(Math.max(d.baseW - (e.clientX - d.startX), d.minW), d.maxW));
      const h = Math.round(Math.min(Math.max(d.baseH - (e.clientY - d.startY), d.minH), d.maxH));
      d.moved = { w, h };
      d.el.style.width = `${w}px`;
      d.el.style.height = `${h}px`;
    };
    const onUp = () => {
      const d = resize.current;
      if (!d) return;
      resize.current = null;
      if (!d.moved) return;
      setSize(d.moved);
      saveSize(key, d.moved);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [key]);

  const reset = useCallback(() => {
    setSize(null);
    try {
      localStorage.removeItem(SIZE_PREFIX + key);
    } catch {
      // 清除失败只影响下次打开
    }
  }, [key]);

  const onHandleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const el = e.currentTarget.closest<HTMLElement>('[data-panel-drag-root]');
    if (!el) return;
    const step = e.shiftKey ? 80 : 20;
    const rect = el.getBoundingClientRect();
    let w = Math.round(rect.width);
    let h = Math.round(rect.height);
    if (e.key === 'ArrowLeft') w += step;
    else if (e.key === 'ArrowRight') w -= step;
    else if (e.key === 'ArrowUp') h += step;
    else if (e.key === 'ArrowDown') h -= step;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const { minW, minH, maxW, maxH } = bounds();
    const next = {
      w: Math.min(Math.max(w, minW), maxW),
      h: Math.min(Math.max(h, minH), maxH),
    };
    el.style.width = `${next.w}px`;
    el.style.height = `${next.h}px`;
    setSize(next);
    saveSize(key, next);
  }, [bounds, key]);

  return {
    style: size ? { width: `${size.w}px`, height: `${size.h}px` } : {},
    onHandlePointerDown,
    onHandleKeyDown,
    reset,
  };
}
