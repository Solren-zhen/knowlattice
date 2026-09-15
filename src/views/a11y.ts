/**
 * 键盘可达性：把「可点的 div / span」补成真正的按钮语义。
 *
 * 只补语义与键盘事件，不接管 onClick —— 鼠标点击仍走元素原本的 onClick。
 * Enter / Space 触发时直接调用元素自身的 click()，让键盘与鼠标走同一条代码路径，
 * 不必把回调重复写两遍，也不会让 React 编译器误判为「渲染期读取 ref」。
 *
 * 用法：<div className="row" onClick={() => onOpen(id)} {...clickable('打开笔记')} />
 */
import type { KeyboardEvent } from 'react';

export function clickable(label?: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.currentTarget.click();
      }
    },
  };
}
