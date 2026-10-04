/**
 * @tauri-apps/plugin-fs 的内存文件树 mock（契约测试与迁移测试共用）。
 *
 * 路径即键、不区分 baseDir（与 TauriAdapter 的两种模式兼容：默认模式传 Document
 * 相对路径、自定义模式传绝对路径，mock 都按原样收）。用 vi.mock 的异步工厂引用本模块：
 *   vi.mock('@tauri-apps/plugin-fs', async () => (await import('./fsMock')).mod);
 *
 * armWriteFailure 注入持续生效的写入失败（写 tmp 与回退直写都会中），模拟磁盘故障，
 * 供「迁移中途失败可重试」用例使用；clearWriteFailure 解除。
 */

export type FsNode = { kind: 'file'; data: Uint8Array; mtime: number } | { kind: 'dir' };
export const tree = new Map<string, FsNode>();

export function resetFs(): void {
  tree.clear();
  clearWriteFailure();
  clearReadDirFailure();
}

let writeFailure: ((p: string) => boolean) | null = null;
export function armWriteFailure(match: (p: string) => boolean): void {
  writeFailure = match;
}
export function clearWriteFailure(): void {
  writeFailure = null;
}

/** 注入持续的 readDir 失败（模拟目录权限被拒 / IO 故障），供「读失败不得伪装成空库」用例使用 */
let readDirFailure: ((p: string) => boolean) | null = null;
export function armReadDirFailure(match: (p: string) => boolean): void {
  readDirFailure = match;
}
export function clearReadDirFailure(): void {
  readDirFailure = null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const parent = (p: string) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
const ensure = (p: string) => {
  let acc = '';
  for (const part of p.split('/')) {
    acc = acc ? `${acc}/${part}` : part;
    if (!tree.has(acc)) tree.set(acc, { kind: 'dir' });
  }
};
const failIfArmed = (p: string) => {
  if (writeFailure?.(p)) throw new Error('模拟磁盘写入失败');
};

export const mod = {
  BaseDirectory: { Document: 'document' },
  async mkdir(path: string, opts?: { recursive?: boolean }) {
    const p = norm(path);
    if (tree.has(p)) return;
    if (opts?.recursive) ensure(p);
    else ensure(parent(p));
    tree.set(p, { kind: 'dir' });
  },
  async writeTextFile(path: string, data: string) {
    const p = norm(path);
    failIfArmed(p);
    ensure(parent(p)); tree.set(p, { kind: 'file', data: enc.encode(data), mtime: Date.now() });
  },
  async writeFile(path: string, data: Uint8Array) {
    const p = norm(path);
    failIfArmed(p);
    ensure(parent(p)); tree.set(p, { kind: 'file', data: new Uint8Array(data), mtime: Date.now() });
  },
  async readTextFile(path: string) {
    const n = tree.get(norm(path));
    if (!n || n.kind !== 'file') throw new Error(`not found: ${path}`);
    return dec.decode(n.data);
  },
  async readFile(path: string) {
    const n = tree.get(norm(path));
    if (!n || n.kind !== 'file') throw new Error(`not found: ${path}`);
    return n.data;
  },
  async exists(path: string) { return tree.has(norm(path)); },
  async remove(path: string, opts?: { recursive?: boolean }) {
    const p = norm(path);
    const n = tree.get(p);
    if (!n) throw new Error(`not found: ${path}`);
    if (n.kind === 'dir') {
      const kids = [...tree.keys()].filter((k) => k.startsWith(`${p}/`));
      if (kids.length && !opts?.recursive) throw new Error('dir not empty');
      for (const k of kids) tree.delete(k);
    }
    tree.delete(p);
  },
  async rename(oldPath: string, newPath: string) {
    const o = norm(oldPath); const nw = norm(newPath);
    const node = tree.get(o);
    if (!node) throw new Error(`not found: ${oldPath}`);
    const moves = [...tree.keys()].filter((k) => k.startsWith(`${o}/`)).map((k) => [k, `${nw}${k.slice(o.length)}`] as const);
    tree.delete(o);
    for (const [from, to] of moves) { tree.set(to, tree.get(from)!); tree.delete(from); }
    tree.set(nw, node);
  },
  async readDir(path: string) {
    const p = norm(path);
    if (readDirFailure?.(p)) throw new Error('模拟目录读取失败');
    const prefix = p ? `${p}/` : '';
    const names = new Set<string>();
    for (const k of tree.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    return [...names].map((name) => {
      const n = tree.get(`${prefix}${name}`);
      return { name, isDirectory: n?.kind === 'dir', isFile: n?.kind === 'file', isSymlink: false };
    });
  },
  async stat(path: string) {
    const n = tree.get(norm(path));
    if (!n) throw new Error(`not found: ${path}`);
    return {
      isFile: n.kind === 'file', isDirectory: n.kind === 'dir', isSymlink: false,
      size: n.kind === 'file' ? n.data.length : 0, mtime: new Date(n.kind === 'file' ? n.mtime : 0), atime: null, birthtime: null,
    };
  },
};
