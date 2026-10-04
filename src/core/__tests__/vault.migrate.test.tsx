// @vitest-environment jsdom
/**
 * useVault.migrateFromBrowser：切换存储后端后，把桌面端 IndexedDB 里的既有数据
 * 一次性写入本机文件夹（<文档>/KnowLattice）。
 *
 * 做法：mock tauriEnv 让 isTauri() 为真（vault 于是选 TauriAdapter），用内存文件树
 * mock 掉 @tauri-apps/plugin-fs；源数据用真实 WebAdapter 写进 fake-indexeddb。
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  type Node = { kind: 'file'; data: Uint8Array } | { kind: 'dir' };
  const tree = new Map<string, Node>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parent = (p: string) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
  const ensure = (p: string) => {
    let acc = '';
    for (const part of p.split('/')) { acc = acc ? `${acc}/${part}` : part; if (!tree.has(acc)) tree.set(acc, { kind: 'dir' }); }
  };
  const mod = {
    BaseDirectory: { Document: 'document' },
    async mkdir(path: string, opts?: { recursive?: boolean }) {
      const p = norm(path);
      if (tree.has(p)) return;
      if (opts?.recursive) ensure(p); else ensure(parent(p));
      tree.set(p, { kind: 'dir' });
    },
    async writeTextFile(path: string, data: string) {
      const p = norm(path); ensure(parent(p)); tree.set(p, { kind: 'file', data: enc.encode(data) });
    },
    async writeFile(path: string, data: Uint8Array) {
      const p = norm(path); ensure(parent(p)); tree.set(p, { kind: 'file', data: new Uint8Array(data) });
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
      const prefix = norm(path) ? `${norm(path)}/` : '';
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
        size: n.kind === 'file' ? n.data.length : 0, mtime: new Date(0), atime: null, birthtime: null,
      };
    },
  };
  return { mod, tree };
});

vi.mock('../../storage/tauriEnv', () => ({ isTauri: () => true, VAULT_ROOT: 'KnowLattice' }));
vi.mock('@tauri-apps/plugin-fs', () => h.mod);
// useVault 加载链在 Tauri 环境下会先跑「选库 + 授权 + 一次性迁移」：这里模拟
// 用户取消选库（回落默认 <文档>/KnowLattice）并放行授权命令
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => null }));
vi.mock('@tauri-apps/api/path', () => ({ documentDir: async () => 'C:/Users/t/Documents' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));

const { useVault } = await import('../vault');
const { WebAdapter } = await import('../../storage/web');

// jsdom 环境下 structuredClone 会把 Blob 克隆成空对象（fake-indexeddb 插入记录时调用），
// 导致附件在 IndexedDB 往返后内容全丢。WebAdapter 存的是 {path, blob, …} 记录：
// 含 Blob 的记录走「浅拷贝 + Blob 同引用放行」，其余仍用原生 clone。
{
  const prev = globalThis.structuredClone;
  globalThis.structuredClone = ((v: unknown, opts?: StructuredSerializeOptions) => {
    if (v instanceof Blob) return v;
    if (v && typeof v === 'object' && Object.values(v).some((x) => x instanceof Blob)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x instanceof Blob ? x : x]));
    }
    return prev(v, opts);
  }) as typeof structuredClone;
}

function Probe() {
  const v = useVault();
  const [r, setR] = useState('');
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <span data-testid="result">{r}</span>
      <button
        onClick={() => {
          void v.migrateFromBrowser().then((res) => setR(JSON.stringify(res)));
        }}
      >
        迁移
      </button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  h.tree.clear();
  // 换全新 IDBFactory：用例间 IndexedDB 隔离（否则下一个用例会读到上一个的附件）
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true, writable: true });
});

describe('useVault.migrateFromBrowser', () => {
  it('把 IndexedDB 里的笔记与附件写入文件系统，并返回真实统计', async () => {
    const seed = new WebAdapter();
    await seed.write('01-生理/a.md', '# A\n');
    await seed.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([1, 2, 3])]));

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    fireEvent.click(screen.getByText('迁移'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).not.toBe(''));

    expect(JSON.parse(screen.getByTestId('result').textContent!)).toEqual({ notes: 1, attachments: 1, failed: 0 });
    expect(await h.mod.readTextFile('KnowLattice/01-生理/a.md')).toBe('# A\n');
    expect(h.tree.has('KnowLattice/_attachments/p.png')).toBe(true);

    cleanup();
  });

  it('幂等：重复迁移不报错、结果一致', async () => {
    const seed = new WebAdapter();
    await seed.write('01-生理/a.md', '# A\n');

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    fireEvent.click(screen.getByText('迁移'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).not.toBe(''));
    fireEvent.click(screen.getByText('迁移'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('result').textContent!)).toEqual({ notes: 1, attachments: 0, failed: 0 }));

    expect(screen.getByTestId('result').textContent).toBeTruthy();
  });
});
