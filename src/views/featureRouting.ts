/**
 * 功能路由的**纯数据层**：全屏面板的互斥表、高亮优先级、首页「最近使用」的 LRU。
 *
 * 从 Workspace.tsx 里搬出来的是「规则」，不是「开关」：
 *   - `RAIL_MODAL`：哪个去处在打开时是整屏面板（同一时刻只该存在一个）；
 *   - `buildRailOrder`：轨上高亮谁——按「谁盖在上面」排优先级，写成表而不是 19 层三元链；
 *   - 最近使用的读写：坏 JSON、下架键、配额满都在这里收口。
 *
 * `RAIL_MODAL` 不再是手写表：它由 `panelRegistry` 的 `PANELS` 派生（`rail` + `modal` 两个字段），
 * 这样「加一个面板」只需要在注册表里加一行，不必在这里补第二遍。
 * 本文件保留这个导出名，是因为 `featureRouting.test.ts` 的轨上完整性断言读的就是它。
 */
import { RAIL_INDEX, type RailKey } from './railCatalog';

export { RAIL_MODAL } from './panelRegistry';

/** 首页「最近使用」：localStorage 键与上限（一排 4 列 × 2 行） */
export const RECENT_FEATURES_KEY = 'knowlattice-recent-features';
export const RECENT_FEATURES_MAX = 8;

const RAIL_KEYS = new Set<string>(Object.keys(RAIL_INDEX));

/**
 * 轨上高亮的优先级：前一个开着就标前一个（同一时刻可能有多个浮层共存，
 * 比如搜索盖在题库上，此时高亮搜索）。
 *
 * `ai` 是三者合一：问答 / AI 笔记 / 智能草稿任意一个开，轨上都标 AI。
 */
export interface RailOpenFlags {
  search: boolean;
  pdf: boolean;
  anatomy: boolean;
  brain: boolean;
  graph: boolean;
  review: boolean;
  mistakes: boolean;
  quiz: boolean;
  todos: boolean;
  tags: boolean;
  report: boolean;
  ai: boolean;
  history: boolean;
  convert: boolean;
  video: boolean;
  import: boolean;
  mind: boolean;
  medref: boolean;
  notice: boolean;
  /** 课程工坊：整屏面板 */
  course: boolean;
  /** 单词工坊：整屏面板 */
  words: boolean;
  /** 资料生成：整屏面板 */
  matgen: boolean;
}

/** 优先级表：数组顺序即优先级（高 → 低）。加一个去处只加一行。 */
const RAIL_ORDER: Array<keyof RailOpenFlags> = [
  'search', 'pdf', 'anatomy', 'brain', 'graph', 'course', 'words', 'matgen', 'review', 'mistakes',
  'quiz', 'todos', 'tags', 'report', 'ai', 'history', 'convert', 'video',
  'import', 'mind', 'medref', 'notice',
];

/** 按当前打开状态排出高亮顺序 */
export function buildRailOrder(flags: RailOpenFlags): RailKey[] {
  return RAIL_ORDER.filter((key) => flags[key]);
}

/** 轨上高亮的那一处：优先级最高且开着的；都没开时返回 null */
export function activeRailOf(order: readonly RailKey[]): RailKey | null {
  return order[0] ?? null;
}

/**
 * 读回最近使用的去处。
 * 功能改名/下架后残留的键按 RAIL_INDEX 过滤，坏 JSON 或非数组当空表。
 */
export function loadRecentFeatures(): RailKey[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_FEATURES_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((key): key is RailKey => typeof key === 'string' && RAIL_KEYS.has(key))
      .slice(0, RECENT_FEATURES_MAX);
  } catch {
    return [];
  }
}

/**
 * LRU 推进一格：把 key 提到最前，最多保留 RECENT_FEATURES_MAX 条。
 * 已经在第一位时**返回原数组**（引用不变）——调用方据此跳过 setState 与写盘。
 */
export function pushRecentFeature(prev: readonly RailKey[], key: RailKey): RailKey[] {
  if (prev[0] === key) return prev as RailKey[];
  return [key, ...prev.filter((k) => k !== key)].slice(0, RECENT_FEATURES_MAX);
}

/** 落盘；配额满时静默失败（本次会话内内存里的顺序仍然可用） */
export function saveRecentFeatures(list: readonly RailKey[]): void {
  try {
    localStorage.setItem(RECENT_FEATURES_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式 / 配额满：不打断点击 */
  }
}
