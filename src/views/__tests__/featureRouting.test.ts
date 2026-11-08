/**
 * 功能路由的纯规则测试（featureRouting）。
 *
 * 这些规则原先散在 Workspace.tsx 里，只能靠「改完跑起来点一遍」验证。
 * 搬出来之后，三条最容易错的不变量被钉住：
 *   1. 高亮优先级：多个浮层共存时，轨上标的是「盖在最上面」的那个；
 *   2. 整屏面板互斥表：除了能与内容共存的（目录 / 视频 / AI 浮层），每个导轨入口都要有对应的面板键；
 *   3. 最近使用的 LRU：不重复、不超长、已置顶时不产生新引用（调用方据此跳过写盘）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RAIL_INDEX, type RailKey } from '../railCatalog';
import {
  RAIL_MODAL,
  RECENT_FEATURES_KEY,
  RECENT_FEATURES_MAX,
  activeRailOf,
  buildRailOrder,
  loadRecentFeatures,
  pushRecentFeature,
  saveRecentFeatures,
  type RailOpenFlags,
} from '../featureRouting';

const none: RailOpenFlags = {
  search: false, pdf: false, anatomy: false, brain: false, graph: false,
  review: false, mistakes: false, quiz: false, todos: false, tags: false, report: false,
  ai: false, history: false, convert: false, video: false, import: false, mind: false,
  medref: false, notice: false, course: false, words: false, matgen: false,
};

describe('轨上高亮优先级', () => {
  it('都没开时没有高亮', () => {
    expect(buildRailOrder(none)).toEqual([]);
    expect(activeRailOf(buildRailOrder(none))).toBeNull();
  });

  it('搜索盖在题库上时高亮搜索，而不是题库', () => {
    const order = buildRailOrder({ ...none, quiz: true, search: true });
    expect(order).toEqual(['search', 'quiz']);
    expect(activeRailOf(order)).toBe('search');
  });

  it('视频小窗不会抢走全屏面板的高亮', () => {
    const order = buildRailOrder({ ...none, video: true, quiz: true });
    expect(activeRailOf(order)).toBe('quiz');
  });
});

describe('整屏面板互斥表', () => {
  /** 能与内容共存的去处：目录侧栏、右侧 AI 浮层（问答 / 笔记 / 草稿）、视频小窗 */
  const COEXISTING: Record<string, true> = { tree: true, ai: true, video: true };
  const railKeys = Object.keys(RAIL_INDEX) as RailKey[];

  it('医学通路已下架，不再出现在导航入口', () => {
    expect(railKeys).not.toContain('pathway');
  });

  it('智能问诊已下架，不再出现在导航入口', () => {
    expect(railKeys).not.toContain('clinic');
  });

  it('每个导轨入口都有面板键（漏一个 → 打开它时不会关掉别的面板，两个遮罩叠在一起）', () => {
    const missing = railKeys.filter((key) => !COEXISTING[key] && !RAIL_MODAL[key]);
    expect(missing).toEqual([]);
  });

  it('能与内容共存的去处不得登记为整屏面板', () => {
    for (const key of Object.keys(COEXISTING)) expect(RAIL_MODAL[key as RailKey]).toBeUndefined();
  });

  it('两个入口不许映射到同一个面板键（关掉一个会顺手关掉另一个）', () => {
    const values = Object.values(RAIL_MODAL).filter(Boolean) as string[];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('最近使用的 LRU', () => {
  beforeEach(() => localStorage.clear());

  it('新条目提到最前，旧条目保留相对顺序', () => {
    expect(pushRecentFeature(['quiz', 'review', 'todos'], 'review')).toEqual(['review', 'quiz', 'todos']);
  });

  it('不重复、不超长', () => {
    const keys: RailKey[] = ['quiz', 'review', 'todos', 'graph', 'mind', 'tags', 'pdf', 'medref'];
    let list: RailKey[] = [];
    for (const k of keys) list = pushRecentFeature(list, k);
    list = pushRecentFeature(list, 'quiz');
    expect(list).toHaveLength(RECENT_FEATURES_MAX);
    expect(list[0]).toBe('quiz');
    expect(new Set(list).size).toBe(list.length);
  });

  it('已经置顶时返回原引用：调用方据此跳过写盘', () => {
    const prev: RailKey[] = ['quiz', 'review'];
    expect(pushRecentFeature(prev, 'quiz')).toBe(prev);
  });

  it('读回时过滤下架/未知键，坏 JSON 当空表', () => {
    localStorage.setItem(RECENT_FEATURES_KEY, JSON.stringify(['quiz', 'dead-key', 'mind', 42]));
    // mind 已从导轨下架（RAIL_INDEX 里没有），历史残留不能把首页撑崩
    expect(loadRecentFeatures()).toEqual(['quiz']);
    localStorage.setItem(RECENT_FEATURES_KEY, '{not json');
    expect(loadRecentFeatures()).toEqual([]);
    localStorage.setItem(RECENT_FEATURES_KEY, '"quiz"');
    expect(loadRecentFeatures()).toEqual([]);
  });

  it('写盘后能原样读回', () => {
    saveRecentFeatures(['review', 'quiz']);
    expect(loadRecentFeatures()).toEqual(['review', 'quiz']);
  });
});
