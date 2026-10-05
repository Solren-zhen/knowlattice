// @vitest-environment jsdom
/** AiPanel iframe 挂载门控：
 *  面板打开但用户未选站点时不得挂 iframe（不发任何第三方请求）；
 *  用户点选预设后才挂载，src 为所选地址。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AiPanel from '../AiPanel';

describe('AiPanel iframe 门控', () => {
  beforeEach(() => {
    localStorage.removeItem('knowlattice-ai-src');
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem('knowlattice-ai-src');
  });

  it('首次打开：不挂 iframe，显示引导文案', () => {
    render(<AiPanel onClose={() => {}} />);
    expect(document.querySelector('iframe.ai-frame')).toBeNull();
    expect(screen.getByText('尚未打开任何 AI 站点')).toBeTruthy();
  });

  it('点选预设后挂 iframe，src 为所选站点', () => {
    render(<AiPanel onClose={() => {}} />);
    expect(document.querySelector('iframe.ai-frame')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '智谱清言' }));
    const frame = document.querySelector('iframe.ai-frame') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame!.src).toBe('https://chatglm.cn/');
    // 选择写入 localStorage，下次打开恢复 armed 状态（属于用户主动行为的结果）
    expect(localStorage.getItem('knowlattice-ai-src')).toBe('https://chatglm.cn/');
  });

  it('上次选过站点、本次重开面板：仍不挂 iframe（门控按会话，不因历史选择自动联网）', () => {
    localStorage.setItem('knowlattice-ai-src', 'https://chatglm.cn/');
    render(<AiPanel onClose={() => {}} />);
    expect(document.querySelector('iframe.ai-frame')).toBeNull();
    expect(screen.getByText('尚未打开任何 AI 站点')).toBeTruthy();
    // 历史选择仍保留（预设 chip 高亮、localStorage 不变），只是本次会话尚未建立连接
    expect(screen.getByRole('button', { name: '智谱清言' }).className).toContain('on');
    expect(localStorage.getItem('knowlattice-ai-src')).toBe('https://chatglm.cn/');
    // 用户本次主动点选后才挂载
    fireEvent.click(screen.getByRole('button', { name: '智谱清言' }));
    expect(document.querySelector('iframe.ai-frame')).not.toBeNull();
  });
});
