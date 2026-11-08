/**
 * 可编辑的快捷键表。
 *
 * 只收「应用级」快捷键：全局搜索、命令面板、打印、保存、前进/后退，以及编辑器里的
 * 五个行内格式键。面板内部的局部键（复习 A/S/D/F、待办 1/2/3）不在此列——
 * 它们只在一个视图里有意义，改键反而会和该视图的输入语义打架。
 *
 * 存储格式：`{ [id]: "Mod+Shift+P" }`，只落用户改过的键；没写的沿用默认值。
 * 匹配统一把 Ctrl/⌘ 归一成 `Mod`，显示时再按平台展开。
 */
import { defineStore } from '../storage/kv';

export type ShortcutId =
  | 'search' | 'palette' | 'print' | 'save' | 'back' | 'forward'
  | 'bold' | 'italic' | 'highlight' | 'wiki' | 'cloze';

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: '全局' | '编辑器格式';
  /** 默认键，形如 Mod+K / Alt+ArrowLeft / Shift+Enter */
  defaultKey: string;
  /** 设置页的一句话说明 */
  hint: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'search', label: '全局搜索', group: '全局', defaultKey: 'Mod+K', hint: '打开快速搜索' },
  { id: 'palette', label: '命令面板', group: '全局', defaultKey: 'Mod+Shift+P', hint: '按名字找功能' },
  { id: 'save', label: '保存当前笔记', group: '全局', defaultKey: 'Mod+S', hint: '立即落盘' },
  { id: 'print', label: '打印 / 存为 PDF', group: '全局', defaultKey: 'Mod+P', hint: '打印当前笔记，而不是整个应用界面' },
  { id: 'back', label: '后退', group: '全局', defaultKey: 'Alt+ArrowLeft', hint: '回到上一篇' },
  { id: 'forward', label: '前进', group: '全局', defaultKey: 'Alt+ArrowRight', hint: '前进到下一篇' },
  { id: 'bold', label: '加粗', group: '编辑器格式', defaultKey: 'Alt+A', hint: '包裹 **文字**' },
  { id: 'highlight', label: '高亮', group: '编辑器格式', defaultKey: 'Alt+S', hint: '包裹 ==文字==' },
  { id: 'italic', label: '斜体', group: '编辑器格式', defaultKey: 'Alt+Z', hint: '包裹 *文字*' },
  { id: 'cloze', label: '挖空', group: '编辑器格式', defaultKey: 'Alt+C', hint: '包裹 {{答案}}' },
  { id: 'wiki', label: '插入双链', group: '编辑器格式', defaultKey: 'Alt+X', hint: '包裹 [[笔记名]]' },
];

export const SHORTCUT_INDEX: Record<ShortcutId, ShortcutDef> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s]),
) as Record<ShortcutId, ShortcutDef>;

export const DEFAULT_KEYS: Record<ShortcutId, string> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s.defaultKey]),
) as Record<ShortcutId, string>;

const DEFAULT_ALL = { ...DEFAULT_KEYS };

const store = defineStore<Record<string, string>>({
  key: 'knowlattice-keybindings',
  fallback: {},
  decode(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[id] = value;
    }
    return out;
  },
});

/** 合并默认值后的完整键表。 */
export function getBindings(): Record<ShortcutId, string> {
  return { ...DEFAULT_ALL, ...(store.read() as Partial<Record<ShortcutId, string>>) };
}

function write(overrides: Record<string, string>): void {
  store.write(overrides);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(KEYBINDING_EVENT));
}

/** 只持久化「与默认不同」的键，删掉的键回到默认。 */
export function saveBinding(id: ShortcutId, key: string): { ok: true } | { ok: false; reason: string } {
  const binding = normalizeBinding(key);
  if (!binding) return { ok: false, reason: '只按下修饰键不算快捷键' };
  // 无 Mod/Alt 的绑定会在正常打字时命中（编辑器对普通字符与 Shift+字母不 preventDefault），
  // 一次误录就让那个字母全局失效，录制时直接拒绝。Shift 单独不算修饰键：Shift+K 就是打大写 K。
  const parts = binding.split('+');
  if (!parts.includes('Mod') && !parts.includes('Alt')) {
    return { ok: false, reason: '全局快捷键必须带 Ctrl/⌘ 或 Alt（Shift 单独不算），否则打字时会误触发' };
  }
  const current = getBindings();
  const conflict = SHORTCUTS.find((s) => s.id !== id && current[s.id] === binding);
  if (conflict) return { ok: false, reason: `与「${conflict.label}」冲突（${formatBinding(binding)}）` };
  const overrides = { ...(store.read() as Record<string, string>) };
  if (binding === DEFAULT_KEYS[id]) delete overrides[id];
  else overrides[id] = binding;
  write(overrides);
  return { ok: true };
}

export function resetBinding(id: ShortcutId): void {
  const overrides = { ...(store.read() as Record<string, string>) };
  delete overrides[id];
  write(overrides);
}

export function resetAllBindings(): void {
  write({});
}

export const KEYBINDING_EVENT = 'knowlattice-keybindings-changed';

function isMac(): boolean {
  try {
    return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
  } catch {
    return false;
  }
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** 键盘事件 → 规范键名；只按修饰键返回 null。 */
export function bindingFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = String(event.key ?? '');
  if (!key || ['Control', 'Meta', 'Alt', 'Shift', 'CapsLock'].includes(key)) return null;
  const normalized = KEY_ALIASES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normalized);
  return parts.join('+');
}

/** 规范键名（接受用户输入的大小写/空格差异）。 */
export function normalizeBinding(raw: string): string | null {
  const parts = String(raw ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'mod' || lower === '⌘') mods.add('Mod');
    else if (lower === 'alt' || lower === 'option' || lower === 'opt' || lower === '⌥') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else key = KEY_ALIASES[part] ?? (part.length === 1 ? part.toUpperCase() : part);
  }
  if (!key) return null;
  const ordered = ['Mod', 'Alt', 'Shift'].filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

/** 事件是否命中某个快捷键。 */
export function matchesBinding(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  binding: string,
): boolean {
  return bindingFromEvent(event) === normalizeBinding(binding);
}

/** 显示用：Windows/Linux 展开 Ctrl，mac 展开 ⌘；Alt 在 mac 显示为 ⌥。 */
export function formatBinding(binding: string, mac = isMac()): string {
  const parts = String(binding ?? '').split('+');
  return parts
    .map((part) => {
      if (part === 'Mod') return mac ? '⌘' : 'Ctrl';
      if (part === 'Alt') return mac ? '⌥' : 'Alt';
      if (part === 'Shift') return 'Shift';
      return part;
    })
    .join('+');
}

/** 窄处（右键菜单 / 按钮 title）用的紧凑写法：Alt/⌥+A。 */
export function compactBinding(binding: string): string {
  const parts = String(binding ?? '').split('+');
  return parts.map((part) => (part === 'Mod' ? 'Ctrl/⌘' : part === 'Alt' ? 'Alt/⌥' : part)).join('+');
}

/** CodeMirror 键名：Mod+K → Mod-k；Alt+ArrowLeft 保持原样。 */
export function toCodeMirrorKey(binding: string): string {
  const parts = String(binding ?? '').split('+');
  const key = parts.pop() ?? '';
  const cmKey = key.length === 1 ? key.toLowerCase() : key;
  return [...parts, cmKey].join('-');
}

/** macOS 下 Option+字母会打出特殊字符，Alt 系格式键改走 Mod-Alt。 */
export function toCodeMirrorMac(binding: string): string {
  const parts = String(binding ?? '').split('+');
  if (parts.includes('Alt') && !parts.includes('Mod')) {
    return toCodeMirrorKey(['Mod', ...parts].join('+'));
  }
  return toCodeMirrorKey(binding);
}

/** 测试用：清空覆盖值（不影响默认表）。 */
export function clearAllOverrides(): void {
  write({});
}

/** 备份用：只导出用户改过的键（与默认不同的那部分）。 */
export function exportBindings(): Record<string, string> {
  return { ...(store.read() as Record<string, string>) };
}

/** 恢复用：只补不覆盖；同一个快捷键保留本机设置。 */
export function importBindings(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const current = store.read() as Record<string, string>;
  const fresh: Record<string, string> = {};
  let added = 0;
  let kept = 0;
  for (const [id, key] of Object.entries(incoming as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (current[id]) {
      kept += 1;
      continue;
    }
    fresh[id] = key;
    added += 1;
  }
  if (added > 0) write({ ...fresh, ...current });
  return { added, kept };
}
