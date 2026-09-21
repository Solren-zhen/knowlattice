/**
 * 全局 Esc 栈：一次 Esc 只让**最上面那一层**响应。
 *
 * 起因：各面板各自 `window.addEventListener('keydown')` 抢 Esc，谁注册谁响应，
 * 于是一次 Esc 会同时关掉两层——例如「解剖图谱 + Ctrl+K 搜索」：搜索框的 React
 * onKeyDown 处理完继续冒泡到 window，图谱也被一起关掉；反过来「AI 面板 + 错题本」
 * 则会出现看得见的那层不响应、看不见的那层被关掉。
 *
 * 这里把「谁该响应」收敛成一个显式栈：后打开的压在上面，只调用栈顶。
 * 组件挂载即入栈（挂载顺序 = 打开顺序），卸载即出栈。
 *
 * 注意：本模块不 stopPropagation —— 编辑器右键菜单、表格菜单等**局部** Esc 处理器
 * 仍应照常工作；这里只解决「多个面板互相抢」的问题。
 * 确认框（core/feedback.ts）走 document 捕获阶段并 stopPropagation，仍先于本栈生效。
 */

export type EscHandler = (e: KeyboardEvent) => void;

interface Frame {
  key: symbol;
  handler: EscHandler;
}

const stack: Frame[] = [];
let installed = false;

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.handler(e);
}

function ensureListener() {
  if (installed || typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeydown);
  installed = true;
}

/** 压入一层，返回出栈函数（组件卸载时调用；可重复调用）。 */
export function pushEsc(handler: EscHandler): () => void {
  ensureListener();
  const key = Symbol('esc-frame');
  stack.push({ key, handler });
  return () => {
    const i = stack.findIndex((f) => f.key === key);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 当前栈深（测试与调试用） */
export function escDepth(): number {
  return stack.length;
}

/** 清空栈（仅测试用） */
export function resetEscStack(): void {
  stack.length = 0;
}
