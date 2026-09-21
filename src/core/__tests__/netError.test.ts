import { describe, expect, it } from 'vitest';
import { TRANSPORT_ERROR_HINT, isTransportError, netErrorHint } from '../netError';

describe('netError · 传输层错误识别', () => {
  it('三种浏览器的网络失败原文都认', () => {
    // Chrome / Safari / Firefox 各自的措辞，逐个查过
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransportError(new TypeError('Load failed'))).toBe(true);
    expect(isTransportError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
  });

  it('懒加载分块取不到（Failed to fetch dynamically imported module）也算', () => {
    expect(isTransportError(new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/GraphView-abc.js',
    ))).toBe(true);
  });

  it('主动取消不算网络故障（否则会把用户带向错误方向）', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect(isTransportError(abort)).toBe(false);
    expect(netErrorHint(abort)).toBe('The operation was aborted.');
  });

  it('404 / 配额 / 业务异常不算', () => {
    expect(isTransportError(new Error('无法加载解剖数据 (HTTP 404)'))).toBe(false);
    expect(isTransportError(new Error('QuotaExceededError: 存储空间不足'))).toBe(false);
    expect(isTransportError(new Error('同名笔记已存在'))).toBe(false);
  });

  it('非 Error 输入不炸', () => {
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError('Failed to fetch')).toBe(true);
  });
});

describe('netError · 展示文案', () => {
  it('传输层失败给中文提示，并保留浏览器原文', () => {
    const out = netErrorHint(new TypeError('Failed to fetch'));
    expect(out).toContain('连不上本地服务');
    expect(out).toContain('Start-KnowLattice.bat');
    expect(out).toContain('Failed to fetch'); // 原文保留：用户能贴回来，排查有据
  });

  it('非传输层错误原样返回，不被覆盖', () => {
    expect(netErrorHint(new Error('无法加载解剖数据 (HTTP 404)'))).toBe('无法加载解剖数据 (HTTP 404)');
  });

  it('空错误给一句兜底，不留空', () => {
    expect(netErrorHint(undefined)).toBe('未知错误');
    expect(netErrorHint('')).toBe('未知错误');
  });

  it('提示文案本身必须给出下一步动作（不只是「失败了」）', () => {
    expect(TRANSPORT_ERROR_HINT).toMatch(/黑色窗口|Start-KnowLattice/);
  });
});
