import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYS,
  bindingFromEvent,
  clearAllOverrides,
  compactBinding,
  formatBinding,
  getBindings,
  matchesBinding,
  normalizeBinding,
  resetAllBindings,
  resetBinding,
  saveBinding,
  toCodeMirrorKey,
  toCodeMirrorMac,
} from '../keybindings';

function ev(key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

beforeEach(() => {
  clearAllOverrides();
});

describe('keybindings', () => {
  it('默认键表完整，且没改过时读出来就是默认值', () => {
    expect(getBindings()).toEqual(DEFAULT_KEYS);
    expect(getBindings().search).toBe('Mod+K');
    expect(getBindings().bold).toBe('Alt+A');
  });

  it('事件归一化：Ctrl/⌘ 统一成 Mod，字母转大写，方向键保持', () => {
    expect(bindingFromEvent(ev('k', { ctrlKey: true }))).toBe('Mod+K');
    expect(bindingFromEvent(ev('p', { ctrlKey: true, shiftKey: true }))).toBe('Mod+Shift+P');
    expect(bindingFromEvent(ev('ArrowLeft', { altKey: true }))).toBe('Alt+ArrowLeft');
    expect(bindingFromEvent(ev('Control', { ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(ev(' '))).toBe('Space');
  });

  it('匹配：Mod 同时接受 Ctrl 与 ⌘，且修饰键必须完全一致', () => {
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'Mod+K')).toBe(true);
    expect(matchesBinding(ev('k', { metaKey: true }), 'Mod+K')).toBe(true);
    expect(matchesBinding(ev('k', { ctrlKey: true, shiftKey: true }), 'Mod+K')).toBe(false);
    expect(matchesBinding(ev('ArrowLeft', { altKey: true }), 'Alt+ArrowLeft')).toBe(true);
  });

  it('显示：Windows 用 Ctrl，mac 用 ⌘/⌥；紧凑写法固定为 Ctrl/⌘', () => {
    expect(formatBinding('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(formatBinding('Mod+Shift+P', true)).toBe('⌘+Shift+P');
    expect(formatBinding('Alt+A', true)).toBe('⌥+A');
    expect(compactBinding('Alt+A')).toBe('Alt/⌥+A');
  });

  it('保存与冲突：冲突直接拒绝，不覆盖另一个动作', () => {
    expect(saveBinding('save', 'Mod+K')).toEqual({ ok: false, reason: expect.stringContaining('全局搜索') });
    expect(getBindings().save).toBe('Mod+S');
    expect(saveBinding('save', 'Mod+Shift+S')).toEqual({ ok: true });
    expect(getBindings().save).toBe('Mod+Shift+S');
    expect(saveBinding('save', 'Control+S')).toEqual({ ok: true });
    expect(getBindings().save).toBe('Mod+S'); // 与默认相同 → 删除覆盖值
  });

  it('恢复单个 / 全部', () => {
    saveBinding('search', 'Mod+J');
    expect(getBindings().search).toBe('Mod+J');
    resetBinding('search');
    expect(getBindings().search).toBe(DEFAULT_KEYS.search);
    saveBinding('bold', 'Alt+B');
    resetAllBindings();
    expect(getBindings()).toEqual(DEFAULT_KEYS);
  });

  it('CodeMirror 键名：字母小写，mac 的 Alt 系改走 Mod-Alt', () => {
    expect(toCodeMirrorKey('Mod+Shift+P')).toBe('Mod-Shift-p');
    expect(toCodeMirrorKey('Alt+ArrowLeft')).toBe('Alt-ArrowLeft');
    expect(toCodeMirrorMac('Alt+A')).toBe('Mod-Alt-a');
    expect(toCodeMirrorMac('Mod+K')).toBe('Mod-k');
  });

  it('normalizeBinding 接受用户输入的大小写与别名', () => {
    expect(normalizeBinding('ctrl + shift + p')).toBe('Mod+Shift+P');
    expect(normalizeBinding('⌘+K')).toBe('Mod+K');
    expect(normalizeBinding('Shift')).toBeNull();
  });
});
