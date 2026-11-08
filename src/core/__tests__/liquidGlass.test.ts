import { beforeEach, describe, expect, it } from 'vitest';
import { applyRefractMode, currentRefractMode, normalizeRefractMode } from '../liquidGlass';

beforeEach(() => localStorage.clear());

describe('液态玻璃：模式', () => {
  it('只认 on / off，其余一律 auto（手改 localStorage 不会让玻璃消失）', () => {
    expect(normalizeRefractMode('on')).toBe('on');
    expect(normalizeRefractMode('off')).toBe('off');
    expect(normalizeRefractMode('auto')).toBe('auto');
    expect(normalizeRefractMode(null)).toBe('auto');
    expect(normalizeRefractMode(undefined)).toBe('auto');
    expect(normalizeRefractMode('ON')).toBe('auto');
    expect(normalizeRefractMode('')).toBe('auto');
  });

  it('默认是 auto', () => {
    expect(currentRefractMode()).toBe('auto');
  });

  it('applyRefractMode 落盘并能读回；返回值已归一化', () => {
    expect(applyRefractMode('off')).toBe('off');
    expect(localStorage.getItem('knowlattice-liquid-glass')).toBe('off');
    expect(currentRefractMode()).toBe('off');
    // 无 document 的 Node 环境下也不能抛：设置页在 jsdom，脚本/测试在 node
    expect(() => applyRefractMode('on')).not.toThrow();
    expect(currentRefractMode()).toBe('on');
  });

  it('非法值写进去也读成 auto', () => {
    localStorage.setItem('knowlattice-liquid-glass', 'ON');
    expect(currentRefractMode()).toBe('auto');
  });
});
