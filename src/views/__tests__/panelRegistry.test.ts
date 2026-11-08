// @vitest-environment jsdom
/**
 * 面板注册表与开关容器的可执行版本。
 *
 * 钉住三件「重构后会悄悄退化」的事：
 *   1. 注册表自身的一致性（id / rail 不重复，modal 标记与 MODAL_IDS 同步）；
 *   2. `usePanelState` 的写操作**引用稳定**——Workspace 里十几个 useCallback/useEffect
 *      把它放进依赖数组，一旦每次渲染换身份，监听会被反复解绑重挂、图谱会重建；
 *   3. 关闭一个没开的面板不触发重渲染（`withValue` 返回同一引用），
 *      这是 `closeModals` 能一次遍历 24 个面板而不用担心性能的前提。
 */
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MODAL_IDS, PANELS, PANEL_BY_RAIL, PANEL_INDEX, RAIL_MODAL, siblingsOf } from '../panelRegistry';
import { usePanelState } from '../usePanelState';
import { RAIL_INDEX, type RailKey } from '../railCatalog';

describe('面板注册表', () => {
  it('id 不重复', () => {
    const ids = PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('一个导轨入口只能对应一个面板', () => {
    const rails = PANELS.map((p) => p.rail).filter(Boolean) as RailKey[];
    expect(new Set(rails).size).toBe(rails.length);
  });

  it('轨上每个入口都能在注册表里找到面板（tree 是侧栏，不在此列）', () => {
    // 注意方向：RAIL_INDEX 是「轨上现在有哪些按钮」，可能出现 rail 键已下架、
    // 但面板仍能从首页/命令面板进入的情况（mind / pdf 就是这样），所以只断言这一侧。
    const missing = (Object.keys(RAIL_INDEX) as RailKey[]).filter(
      (key) => key !== 'tree' && !PANEL_BY_RAIL[key],
    );
    expect(missing).toEqual([]);
  });

  it('MODAL_IDS 与 modal 标记严格同步', () => {
    expect(new Set(MODAL_IDS)).toEqual(new Set(PANELS.filter((p) => p.modal).map((p) => p.id)));
  });

  it('RAIL_MODAL 只收模态面板，PANEL_BY_RAIL 收全部', () => {
    for (const [rail, id] of Object.entries(RAIL_MODAL)) {
      expect(PANEL_INDEX[id as keyof typeof PANEL_INDEX].modal).toBe(true);
      expect(PANEL_BY_RAIL[rail as RailKey]?.id).toBe(id);
    }
  });

  it('互斥组：AI 三块互相是兄弟，且都不关别的面板', () => {
    expect(siblingsOf('ai').sort()).toEqual(['agent', 'draft']);
    expect(siblingsOf('agent').sort()).toEqual(['ai', 'draft']);
    expect(siblingsOf('quiz')).toEqual([]);
    for (const id of ['ai', 'agent', 'draft'] as const) {
      expect(PANEL_INDEX[id].modal).toBe(false);
    }
  });

  it('video 与 tree 一样属于可共存的浮层，不在模态集合里', () => {
    expect(MODAL_IDS).not.toContain('video');
    expect(RAIL_MODAL.video).toBeUndefined();
  });
});

describe('usePanelState', () => {
  it('开 / 关 / 切换 / 读', () => {
    const { result } = renderHook(() => usePanelState());
    expect(result.current.is('quiz')).toBe(false);
    act(() => result.current.open('quiz'));
    expect(result.current.is('quiz')).toBe(true);
    act(() => result.current.toggle('quiz'));
    expect(result.current.is('quiz')).toBe(false);
    act(() => result.current.toggle('quiz'));
    expect(result.current.is('quiz')).toBe(true);
    act(() => result.current.close('quiz'));
    expect(result.current.is('quiz')).toBe(false);
  });

  it('写操作的引用永久稳定（依赖数组可以安全地放它）', () => {
    const { result, rerender } = renderHook(() => usePanelState());
    const first = result.current;
    act(() => first.open('quiz'));
    rerender();
    act(() => result.current.close('quiz'));
    rerender();
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);
    expect(result.current.toggle).toBe(first.toggle);
    expect(result.current.set).toBe(first.set);
  });

  it('关一个本来就没开的面板，不产生新集合（不触发重渲染）', () => {
    const { result, rerender } = renderHook(() => usePanelState());
    act(() => result.current.open('quiz'));
    const before = result.current.is('quiz');
    act(() => result.current.close('review')); // review 没开
    rerender();
    expect(result.current.is('quiz')).toBe(before);
    expect(result.current.is('review')).toBe(false);
  });

  it('多个面板互不影响', () => {
    const { result } = renderHook(() => usePanelState());
    act(() => result.current.open('quiz'));
    act(() => result.current.open('video'));
    expect(result.current.is('quiz')).toBe(true);
    expect(result.current.is('video')).toBe(true);
    act(() => result.current.close('quiz'));
    expect(result.current.is('quiz')).toBe(false);
    expect(result.current.is('video')).toBe(true);
  });
});
