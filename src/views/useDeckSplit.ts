import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * 工作区三列的宽度：左侧目录（`.c-tree`）与右侧关联（`.c-insp`）。
 *
 * 只存两个 px 值，中间编辑列吃剩下的空间（它本来就是 `flex: 1.12`），
 * 所以不需要记第三个数字，也不会出现「三列加起来不等于容器宽」的漂移。
 *
 * 拖动用 **window 级** pointermove/pointerup：抓手只有 8px 宽，靠 pointer capture
 * 一旦失效，指针一离开抓手事件就丢（右栏那次实测过：拖到一半就停）。
 */
const KEY = 'knowlattice.deck.split';

const MIN_SIDE = 180;
/** 侧列再宽就是它在抢编辑区了；真正的上限还要看视口（见 maxSide） */
const MAX_SIDE = 760;

/** 侧列上限：不超过 760，也不超过视口 55%——另一半留给编辑列 */
function maxSide() {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(window.innerWidth * 0.55)));
}

function clampSide(px: number) {
  return Math.round(Math.min(Math.max(MIN_SIDE, px), maxSide()));
}

interface Size {
  treeW: number | null;
  inspW: number | null;
}

function read(): Size {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return {
      treeW: v && Number(v.treeW) > 0 ? Number(v.treeW) : null,
      inspW: v && Number(v.inspW) > 0 ? Number(v.inspW) : null,
    };
  } catch { return { treeW: null, inspW: null }; }
}

function write(size: Size) {
  try { localStorage.setItem(KEY, JSON.stringify(size)); } catch { /* 隐私模式：本次会话照样能用 */ }
}

export interface DeckSplit {
  /** 挂在 .deck 上：--tree-w / --insp-w */
  style: CSSProperties;
  onTreeDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onInspDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (side: 'tree' | 'insp') => (e: ReactKeyboardEvent<HTMLElement>) => void;
  reset: () => void;
}

export function useDeckSplit(): DeckSplit {
  const [size, setSize] = useState<Size>(read);
  const latest = useRef<Size>(size);

  const apply = useCallback((next: Size) => {
    latest.current = next;
    setSize(next);
  }, []);

  /** 视口变窄时把过宽的侧列夹回来，别把编辑区挤成一条缝 */
  useEffect(() => {
    const onResize = () => {
      const prev = latest.current;
      if (prev.treeW == null && prev.inspW == null) return;
      const max = maxSide();
      const treeW = prev.treeW == null ? null : Math.min(prev.treeW, max);
      const inspW = prev.inspW == null ? null : Math.min(prev.inspW, max);
      if (treeW === prev.treeW && inspW === prev.inspW) return;
      const next = { treeW, inspW };
      apply(next);
      write(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  const begin = useCallback((side: 'tree' | 'insp') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget.closest<HTMLElement>('.deck');
    if (!el) return;
    const tree = el.querySelector<HTMLElement>('.c-tree');
    const insp = el.querySelector<HTMLElement>('.c-insp');
    /*
     * 量到 0（还没布局、或列被隐藏）时退回「已存值 / 默认宽度」，别拿 0 当基准——
     * 否则一拖就直接跳到 MIN_SIDE（jsdom 里必然如此，真实浏览器在列刚打开时也可能）。
     */
    const treePx = tree ? Math.round(tree.getBoundingClientRect().width) : 0;
    const inspPx = insp ? Math.round(insp.getBoundingClientRect().width) : 0;
    const base = side === 'tree'
      ? (treePx > 0 ? treePx : (latest.current.treeW ?? 248))
      : (inspPx > 0 ? inspPx : (latest.current.inspW ?? 236));
    const startX = e.clientX;

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      // 目录在左边：往右拖变宽；关联在右边：往左拖变宽
      const raw = side === 'tree' ? base + delta : base - delta;
      apply({ ...latest.current, [side === 'tree' ? 'treeW' : 'inspW']: clampSide(raw) });
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove('is-col-drag');
      write(latest.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    /* 拖动期间整页保持 col-resize 光标并禁止拖选（见 index.css 的 body.is-col-drag） */
    document.body.classList.add('is-col-drag');
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 捕获失败无妨 */ }
    e.preventDefault();
  }, [apply]);

  const step = useCallback((side: 'tree' | 'insp') => (e: ReactKeyboardEvent<HTMLElement>) => {
    const delta = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const prev = latest.current;
    const key = side === 'tree' ? 'treeW' : 'inspW';
    const cur = prev[key] ?? (side === 'tree' ? 248 : 236);
    // 目录在左：← 变窄；关联在右：← 变宽
    const raw = side === 'tree' ? cur + delta : cur - delta;
    const px = clampSide(raw);
    const next = { ...prev, [key]: px };
    apply(next);
    write(next);
  }, [apply]);

  const reset = useCallback(() => {
    const next = { treeW: null, inspW: null };
    apply(next);
    write(next);
  }, [apply]);

  const style = {
    ...(size.treeW != null ? { ['--tree-w' as string]: `${size.treeW}px` } : null),
    ...(size.inspW != null ? { ['--insp-w' as string]: `${size.inspW}px` } : null),
  } as CSSProperties;

  return { style, onTreeDown: begin('tree'), onInspDown: begin('insp'), onKeyDown: step, reset };
}
