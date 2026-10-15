/**
 * 测试环境垫片：为 Node 注入 localStorage 与 IndexedDB 内存实现，
 * 分别供轻量模块和题库存储测试使用。
 * 每个测试文件通过 beforeEach 清空，保证用例隔离。
 */

import 'fake-indexeddb/auto';
// 只取 config 子模块：整个 @testing-library/dom 有 ~140ms/文件的加载成本（150 个测试文件就是几秒），
// 而这里只要 configure 一个函数（子模块 ~30ms）。深引内部路径的代价是升级时可能挪位置——真挪了会
// 立刻报「模块找不到」，不会静默失效；这段接线本身另有 src/__tests__/setupContract.test.ts 守着。
import { configure } from '@testing-library/dom/dist/config.js';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

// URL.createObjectURL 供导出类模块兜底（Node 21+ 有内置实现，这里只做防御）
if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = () => 'blob:mem:placeholder';
  globalThis.URL.revokeObjectURL = () => {};
}

/**
 * 统一放宽 RTL 的等待上限（waitFor / findBy* 默认只等 1s）。
 *
 * 为什么放全局 setup 而不是各测试文件：本项目 150+ 个测试文件并行跑（每文件一个 worker），
 * 大量用例等的是**真实异步链**——打开库要读全部笔记 + 媒体 + 跑一遍 Markdown 自动修正、
 * fake-indexeddb 的一次写入、逐文件导入分流。负载高时一次等待就能超过 1s，表现为
 * 「单跑全绿、整套偶尔红」。早先我是在出问题的文件里各写一遍 configure(...)，同一个理由抄了四份；
 * 放到这里一份即可，新增测试文件也自动享有。
 *
 * 改动只影响**等待上限**：断言条件一个字没改，条件不成立照样失败，判定力不变。
 * 注意与 vitest.config.ts 的 testTimeout 保持匹配（单测预算要大于用例里等待之和）。
 */
configure({ asyncUtilTimeout: 5000 });
