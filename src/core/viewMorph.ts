/**
 * 共享元素转场（第 2、3 项）：把「一个元素长成另一个元素」交给浏览器原生的
 * View Transitions，而不是手写 FLIP。
 *
 * 为什么用原生：
 * - 浏览器自动插值 width / height / transform / **border-radius** —— 胶囊(999px)
 *   长成面板(20px) 的圆角过渡是免费的；手写 FLIP 得算逆圆角（r_inner = r_outer − padding），
 *   算错就是内外不同心的一圈白边；
 * - 新状态在快照期就按真实布局渲染，不会出现克隆层里文字被拉伸。
 * 代价：需要 Chromium 111+（Tauri v2 用常青版 WebView2，满足）。不支持或不过
 * 条件时**无转场降级**（直接切换），功能一点不受影响。
 *
 * 两个坑，这里都堵住了：
 * 1) React 的状态更新是批处理的：在 startViewTransition 的回调里直接 setState，
 *    回调返回时 DOM 还没变，新快照等于旧快照 —— 转场就看不到了。所以调用方传进来的
 *    update **必须同步生效**（用 react-dom 的 flushSync 包一层，见 Workspace 的用法）。
 * 2) view-transition-name 在同一帧内必须唯一：来源元素临时命名、目标元素接管同名，
 *    两者都要在转场结束后清掉。否则下一次转场时「上一轮留下的目标」和「这一轮的来源」
 *    重名，浏览器直接抛 DOMException。
 */
import { motionAllowed } from './motionPrefs';

/** 转场名（同一帧内全局唯一，所以不要散落在各处硬编码） */
export const MORPH = {
  /** 工具栏搜索胶囊 → 快速搜索面板 */
  search: 'qs-morph',
  /** 列表卡片标题 → 编辑器工具栏里的笔记标题 */
  noteTitle: 'note-title',
} as const;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
    skipTransition?: () => void;
  };
};

/** 浏览器是否支持同文档 View Transitions */
export function morphSupported(): boolean {
  if (typeof document === 'undefined') return false;
  return typeof (document as ViewTransitionDocument).startViewTransition === 'function';
}

/** 是否允许做转场：支持 + 系统没要求减少动态效果 + 没有 html.no-morph 急停 */
export function morphEnabled(): boolean {
  if (!morphSupported()) return false;
  if (!motionAllowed()) return false;
  return !document.documentElement.classList.contains('no-morph');
}

/** 同一时刻只允许一个转场（并发会争同一批名字） */
let running = false;

/**
 * 从一个元素形变到另一个元素。
 *
 * @param from   来源元素（会被临时命名；传 null 则只更新、不做转场）
 * @param name   转场名，取 MORPH.* 之一
 * @param to     选择器：转场后接管这个名字的元素（通常是刚渲染出来的面板/标题）
 * @param update 同步生效的状态更新（调用方用 flushSync 包住）
 */
export function morphFrom(
  from: Element | null,
  name: string,
  to: string | null,
  update: () => void,
): void {
  if (!from || !morphEnabled() || running) {
    update();
    return;
  }
  const doc = document as ViewTransitionDocument;
  const source = from as HTMLElement;
  const html = document.documentElement;
  const previous = source.style.getPropertyValue('view-transition-name');

  running = true;
  source.style.setProperty('view-transition-name', name);
  // 形变期间压掉各面板自己的入场动画（否则形态层的位移和 pop-in 会互相抢）
  html.classList.add('morphing');

  const cleanup = () => {
    if (!running) return;
    running = false;
    html.classList.remove('morphing');
    source.style.removeProperty('view-transition-name');
    if (previous) source.style.setProperty('view-transition-name', previous);
    if (to) document.querySelector<HTMLElement>(to)?.style.removeProperty('view-transition-name');
  };

  // 更新必须「恰好一次」：浏览器可能拒掉这次转场（回调根本不会被调用）、
  // 也可能在回调里抛错。任何一种情况都不能变成「页面不跳了」—— 转场是锦上添花，
  // 导航本身是主业务，所以这里用 once 兜住两条失败路径。
  let updated = false;
  const updateOnce = () => {
    if (updated) return;
    updated = true;
    update();
  };

  try {
    const transition = doc.startViewTransition?.(() => {
      updateOnce();
      // 新状态里：来源交还名字，目标接管（两步都必须在回调内同步完成）
      source.style.removeProperty('view-transition-name');
      if (to) document.querySelector<HTMLElement>(to)?.style.setProperty('view-transition-name', name);
    });
    if (!transition) {
      updateOnce();
      cleanup();
      return;
    }
    void transition.ready.catch(() => { /* 被跳过/中断：交给下面的 finished */ });
    void transition.finished.finally(cleanup);
    // 兜底：元素被卸载等情况下 finished 可能不触发，别把名字永久留在 DOM 上
    window.setTimeout(cleanup, 800);
  } catch {
    updateOnce();
    cleanup();
  }
}

/** 供测试与调试：当前是否有转场在进行 */
export function morphIsRunning(): boolean {
  return running;
}
