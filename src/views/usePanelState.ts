/**
 * 面板开关的**唯一状态容器**：一个集合代替 28 个 `useState`。
 *
 * 为什么不是一个面板一个 boolean：
 *   - `closeModals()` 要遍历「所有整屏面板」，28 个独立 state 只能靠手写一张
 *     `modalClosers` 表维护，加了面板忘了登记就是「关掉题库冒出错题本」；
 *   - 面板之间会有互斥组（AI 问答 / AI 笔记 / 智能草稿），独立 state 下要记住
 *     「开 A 的同时关 B、C」，写在十几处入口里，改一处漏一处。
 *
 * 存的是「开着的集合」而不是「全量 boolean 表」：未出现的键就是关着，
 * 关闭时删键，`closeModals` 遍历 `MODAL_IDS` 也不会产生 24 次无谓的 setState。
 *
 * **写操作（open / close / toggle / set）的引用永久稳定**（`useCallback([])`），
 * 可以安全地进 `useCallback` / `useEffect` 的依赖数组；`is` 依赖当前集合，
 * 引用随集合变化——所以它只用于渲染期求值，进依赖时请先提成局部变量
 * （`const visible = panels.is('video')`），否则每次渲染都会换身份。
 */
import { useCallback, useState } from 'react';
import type { PanelId } from './panelRegistry';

type OpenSet = Partial<Record<PanelId, true>>;

export interface PanelState {
  is: (id: PanelId) => boolean;
  open: (id: PanelId) => void;
  close: (id: PanelId) => void;
  toggle: (id: PanelId) => void;
  /** 显式设值（用于「已经开着就保持」之外的场景，如按条件打开） */
  set: (id: PanelId, next: boolean) => void;
}

function withValue(prev: OpenSet, id: PanelId, next: boolean): OpenSet {
  const on = prev[id] === true;
  if (on === next) return prev; // 引用不变 → React 跳过渲染
  if (next) return { ...prev, [id]: true };
  const { [id]: _dropped, ...rest } = prev;
  return rest;
}

export function usePanelState(): PanelState {
  const [openSet, setOpenSet] = useState<OpenSet>({});

  const set = useCallback((id: PanelId, next: boolean) => {
    // 副作用一律不放进 updater（jsdom 会执行 updater，真浏览器对「返回同一引用」会跳过，
    // 两者行为不同；这里 updater 是纯函数，规避了那个坑）
    setOpenSet((prev) => withValue(prev, id, next));
  }, []);

  const open = useCallback((id: PanelId) => setOpenSet((prev) => withValue(prev, id, true)), []);
  const close = useCallback((id: PanelId) => setOpenSet((prev) => withValue(prev, id, false)), []);
  const toggle = useCallback((id: PanelId) => setOpenSet((prev) => withValue(prev, id, prev[id] !== true)), []);

  const is = useCallback((id: PanelId) => openSet[id] === true, [openSet]);

  return { is, open, close, toggle, set };
}
