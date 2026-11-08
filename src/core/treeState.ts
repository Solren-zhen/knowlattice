/**
 * 章节目录树的展开状态持久化。
 *
 * 之前 openDirs 只活在组件内存里：关掉目录卡片、切换面板或重启后，
 * 目录层级全部收回到「前两层」，翻找过的层级要重新一层层点开。
 * 这里把「哪些目录是展开的」（路径集合）落到 localStorage，
 * 由 ChapterTree 在 toggle 时写回、初始化时读回。
 *
 * 只存路径字符串数组：目录改名/删除后，读回的旧路径在 merge 时自然失效
 * （ChapterTree 只保留仍存在于当前树里的路径），不需要额外的清理逻辑。
 */
import { defineStore } from '../storage/kv';

const store = defineStore<string[]>({
  key: 'knowlattice-tree-open-dirs',
  fallback: [],
  decode(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === 'string');
  },
});

export function loadTreeOpenDirs(): Set<string> {
  return new Set(store.read());
}

export function saveTreeOpenDirs(paths: ReadonlySet<string>): void {
  store.write([...paths]);
}
