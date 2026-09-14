/**
 * 测试环境垫片：core 各模块直接用 localStorage（srs/qbank/mistakes/stats），
 * Node 下没有该全局，这里注入一个与 Storage 接口一致的内存实现。
 * 每个测试文件通过 beforeEach 清空，保证用例隔离。
 */

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
