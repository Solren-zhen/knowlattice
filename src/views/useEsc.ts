/**
 * Esc 栈的 React 绑定（见 core/escStack.ts）。
 */
import { useEffect, useRef } from 'react';
import { pushEsc, type EscHandler } from '../core/escStack';

/**
 * 让当前组件在「栈顶」时响应 Esc。
 *
 * handler 每次渲染都是新闭包，但只入栈一次（用 ref 转发最新值）：如果每次渲染都
 * 重新入栈，这一层会被顶到栈顶，打开顺序就乱了。
 */
export function useEsc(handler: EscHandler, enabled = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return pushEsc((e) => ref.current(e));
  }, [enabled]);
}

/** 焦点是否落在可输入元素上（输入框 / 文本域 / contenteditable） */
export function isEditable(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable === true;
}

/**
 * 给「关闭会丢草稿」的面板用：焦点在输入框里时，Esc 只退出输入框（blur），
 * 再按一次才关面板。否则用户在文本框里按 Esc 想收起输入，结果是整块面板
 * 连同没保存的草稿一起没了。
 */
export function escThenClose(onClose: () => void): EscHandler {
  return (e) => {
    if (isEditable(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    onClose();
  };
}
