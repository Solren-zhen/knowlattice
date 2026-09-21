/**
 * 懒加载分块取不到时，React 在渲染阶段抛错。没有边界的话整棵树被卸载——用户看到白屏，
 * 只有控制台里写着 "Failed to fetch dynamically imported module"。离线版最容易碰到：
 * 本地小服务关掉/崩掉之后，任何**还没加载过**的面板（图谱、题库、PDF、脑图谱、思维导图…）
 * 都会走到这里。
 *
 * 重试按钮用整页刷新而不是 setState 复位：React.lazy 会把失败的 import Promise 缓存住，
 * 单纯重渲染会立刻再抛同一个错，只有重新加载页面才真的重新发请求。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { netErrorHint } from '../core/netError';

interface Props { children: ReactNode }
interface State { err: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('界面渲染失败：', err, info.componentStack);
  }

  render() {
    if (!this.state.err) return this.props.children;
    // 复用知识库加载失败页那套样式（.load-error）：两种「进不去」长得一样，用户不用学第二遍
    return (
      <div className="load-error" role="alert">
        <h2>界面没能加载出来</h2>
        <p className="load-error-msg">{netErrorHint(this.state.err)}</p>
        <p className="muted">笔记都存在浏览器本地，重新加载不会丢。</p>
        <button className="btn-primary" onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
}
