/**
 * 面板预取：把「点击才开始下载」变成「有意图就先下」。
 *
 * 现状：Workspace 里 20 个面板都是 `lazy(() => import(...))`，第一次打开要等 chunk 下载 + 挂载，
 * 大面板（QuizView / AiAgentPanel / AnatomyViewer3D）会有肉眼可见的空窗。
 * 导轨悬停是极强的意图信号，停留一下就把对应 chunk 拉下来，点击时基本已经是热的。
 *
 * 三条纪律（照搬 HelixMind 的 routePrefetch 口径）：
 * 1. **只预取、不改变行为**：失败静默，绝不因为预取失败影响打开面板。
 * 2. **同 specifier 即同 chunk**：这里 `import()` 的模块与 Workspace 的 `lazy()` 完全一致，
 *    打包器会把两条边指向同一个 chunk，不会重复下载。
 * 3. **省流量**：`saveData`（省流量模式）下不做任何预取；同一个面板只预取一次。
 */
import type { RailKey } from './railCatalog';

/**
 * 悬停可预取的面板。键是导轨入口（RailKey），值是**和 Workspace 里同一个**动态 import。
 * 只列重面板；轻量的（命令面板、设置、标签）悬停预取收益小于它的存在成本。
 */
const LOADERS: Partial<Record<RailKey, () => Promise<unknown>>> = {
  quiz: () => import('./QuizView'),
  review: () => import('./ReviewView'),
  mistakes: () => import('./MistakeBook'),
  graph: () => import('./GraphView'),
  mind: () => import('./MindMapView'),
  import: () => import('./ImportView'),
  convert: () => import('./ConvertView'),
  history: () => import('./HistoryPanel'),
  course: () => import('./CourseWorkshopView'),
  words: () => import('./WordDrillView'),
  anatomy: () => import('./AnatomyViewer3D'),
  brain: () => import('./BrainAtlasView'),
  medref: () => import('./MedRefView'),
  pdf: () => import('./PdfSplitView'),
};

/** 空闲时主动预取的三块：进入应用后最可能先点的三个重面板。 */
export const IDLE_PREFETCH: readonly RailKey[] = ['quiz', 'review', 'mistakes'];

const started = new Set<RailKey>();
let idleScheduled = false;

function shouldSkip(): boolean {
  // 省流量/弱网：不做任何投机下载。`connection` 是非标准 API，读不到就当正常。
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

/** 预取一个导轨入口对应的面板 chunk（幂等、静默失败）。 */
export function prefetchPanel(key: RailKey): void {
  if (started.has(key) || shouldSkip()) return;
  const load = LOADERS[key];
  if (!load) return;
  started.add(key);
  void load().catch(() => {
    // 失败（离线、chunk 404、被中断）就把标记撤回，下次悬停还能再试一次
    started.delete(key);
  });
}

/**
 * 空闲预取：用 `requestIdleCallback`（没有就退回 `setTimeout`）。
 * 整个页面生命周期只排一次——重复排会在每次交互后再拉一遍已完成的 chunk。
 */
export function prefetchIdle(delayMs = 2000, keys: readonly RailKey[] = IDLE_PREFETCH): void {
  if (idleScheduled || shouldSkip()) return;
  idleScheduled = true;
  const run = () => keys.forEach(prefetchPanel);
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(run, { timeout: delayMs + 2000 });
  else window.setTimeout(run, delayMs);
}

/** 测试用：清空「已预取」标记（真实运行时不调用）。 */
export function resetPrefetchState(): void {
  started.clear();
  idleScheduled = false;
}
