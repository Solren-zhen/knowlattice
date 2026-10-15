/**
 * 工具条展开/收起偏好（core/mindmapToolbar.ts）。守三件事：
 *   ① 没存过 = 展开（与加入这个功能之前的观感一致）；
 *   ② 只认 '1'/'0'，脏值当没存过（不能因为一个坏值让导图打开就变样）；
 *   ③ 存储不可用（隐私模式）时不抛错——回默认、写失败静默，用户至少还能用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLS_OPEN_DEFAULT, loadToolsOpen, saveToolsOpen } from '../mindmapToolbar';

const KEY = 'knowlattice-mindmap-tools';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('思维导图工具条：展开/收起偏好', () => {
  it('没存过 = 展开（默认与加入本功能之前一致）', () => {
    expect(TOOLS_OPEN_DEFAULT).toBe(true);
    expect(loadToolsOpen()).toBe(true);
  });

  it('存过就照存过的来：收起（0）与展开（1）都能读回', () => {
    saveToolsOpen(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(loadToolsOpen()).toBe(false);

    saveToolsOpen(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(loadToolsOpen()).toBe(true);
  });

  it('脏值当没存过：回默认，而不是把界面带偏', () => {
    for (const bad of ['yes', 'false', '{}', ' ', '2']) {
      localStorage.setItem(KEY, bad);
      expect(loadToolsOpen()).toBe(TOOLS_OPEN_DEFAULT);
    }
  });

  it('存储不可用时不抛错：读回默认、写静默失败', () => {
    // 用 stubGlobal 而不是 spyOn(Storage.prototype)：本文件跑在 node 环境，
    // 那里有 localStorage 但没有 Storage 这个构造器（spyOn 会直接 ReferenceError）。
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('隐私模式'); },
      setItem: () => { throw new Error('配额满'); },
    });
    expect(loadToolsOpen()).toBe(TOOLS_OPEN_DEFAULT);
    expect(() => saveToolsOpen(false)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
