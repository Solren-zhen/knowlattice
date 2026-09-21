// @vitest-environment jsdom
/**
 * 渲染兜底页：懒加载分块取不到时不能再白屏。
 * React 的边界只接渲染/生命周期里抛的错（事件回调与异步里的错它接不住），
 * 而懒加载失败恰好发生在渲染阶段——所以这个边界能兜住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import ErrorBoundary from '../ErrorBoundary';

/** 返回类型写成 ReactNode 而不是 never：只抛错的组件用 never 时 TS 不认它是个 JSX 组件 */
function Boom({ err }: { err: Error }): ReactNode {
  throw err;
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React 会把捕获到的错误再打到 console.error，测试里静音（错误本身仍会被断言到）
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('正常子树原样渲染，不显示兜底页', () => {
    render(<ErrorBoundary><p>正常内容</p></ErrorBoundary>);
    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('子组件抛错 → 显示中文兜底页 + 重新加载按钮，而不是白屏', () => {
    render(<ErrorBoundary><Boom err={new TypeError('Failed to fetch')} /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('界面没能加载出来')).toBeTruthy();
    // 传输层原文被翻成可执行提示
    expect(screen.getByText(/连不上本地服务/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
    // 数据安全的话必须说出来，否则用户不敢点
    expect(screen.getByText(/不会丢/)).toBeTruthy();
  });

  it('懒加载分块失败也走同一套兜底（不再只有控制台里那行英文）', () => {
    render(<ErrorBoundary>
      <Boom err={new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/GraphView-x.js')} />
    </ErrorBoundary>);

    expect(screen.getByText(/连不上本地服务/)).toBeTruthy();
    expect(screen.getByText(/GraphView-x\.js/)).toBeTruthy(); // 原文保留，便于回帖排查
  });

  it('非传输层错误照原样显示，不被中文提示覆盖', () => {
    render(<ErrorBoundary><Boom err={new Error('Cannot read properties of null')} /></ErrorBoundary>);

    expect(screen.getByText('Cannot read properties of null')).toBeTruthy();
    expect(screen.queryByText(/连不上本地服务/)).toBeNull();
  });
});
