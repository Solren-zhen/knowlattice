/**
 * 存储适配器契约测试：WebAdapter（IndexedDB）与 TauriAdapter（文件系统）跑同一套用例，
 * 保证桌面端与浏览器端行为一致。
 *
 * TauriAdapter 依赖 @tauri-apps/plugin-fs，用 fsMock.ts 的内存文件树 mock 掉整个插件
 * （覆盖默认模式与用户所选绝对目录两种模式）；WebAdapter 用 setup.ts 里的
 * fake-indexeddb，每个用例换一个全新的 IDBFactory 保证隔离。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StorageAdapter } from '../adapter';
import { WebAdapter } from '../web';
import { TauriAdapter } from '../tauri';
import { tree, resetFs, armReadDirFailure } from './fsMock';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('./fsMock')).mod);

const factories: Array<[string, () => StorageAdapter]> = [
  ['WebAdapter', () => new WebAdapter()],
  ['TauriAdapter', () => new TauriAdapter('KnowLattice')],
  // 用户通过系统目录选择框选定的 vault（绝对路径模式，作用域由 Rust 端运行时授权）
  ['TauriAdapter(自定义目录)', () => new TauriAdapter('C:/Users/t/MyVault')],
];

describe.each(factories)('%s 存储契约', (_name, make) => {
  let a: StorageAdapter;

  beforeEach(() => {
    resetFs();
    Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true, writable: true });
    a = make();
  });

  it('写入后可读、可判存在、可删', async () => {
    expect(await a.exists('01-生理/a.md')).toBe(false);
    await a.write('01-生理/a.md', '# A\n');
    expect(await a.exists('01-生理/a.md')).toBe(true);
    expect(await a.read('01-生理/a.md')).toBe('# A\n');
    await a.remove('01-生理/a.md');
    expect(await a.exists('01-生理/a.md')).toBe(false);
  });

  it('stat：不存在返回 null，写入后给出 mtime/size（写前冲突检测的探针）', async () => {
    expect(await a.stat('01-生理/a.md')).toBeNull();
    await a.write('01-生理/a.md', '# 甲\n');
    const first = await a.stat('01-生理/a.md');
    expect(first).not.toBeNull();
    expect(first!.size).toBe(new TextEncoder().encode('# 甲\n').length);
    expect(typeof first!.mtime).toBe('number');

    // size 随内容更新，两次都必须是「当前磁盘上的字节数」
    await a.write('01-生理/a.md', '# 甲\n乙\n');
    expect((await a.stat('01-生理/a.md'))!.size).toBe(new TextEncoder().encode('# 甲\n乙\n').length);

    await a.remove('01-生理/a.md');
    expect(await a.stat('01-生理/a.md')).toBeNull();
  });

  it('readAll 读出全部 .md，且不含二进制附件', async () => {
    await a.write('01/a.md', '# A\n');
    await a.write('02/b.md', '# B\n');
    await a.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([1, 2, 3])]));
    const all = await a.readAll();
    expect([...all.keys()].sort()).toEqual(['01/a.md', '02/b.md']);
    expect(all.get('01/a.md')).toBe('# A\n');
  });

  it('附件读写回环：二进制内容不变，删除后消失', async () => {
    await a.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([10, 20, 30])]));
    const atts = await a.readAllAttachments();
    expect(atts.has('_attachments/p.png')).toBe(true);
    const got = new Uint8Array(await atts.get('_attachments/p.png')!.arrayBuffer());
    expect([...got]).toEqual([10, 20, 30]);
    await a.removeAttachment('_attachments/p.png');
    expect((await a.readAllAttachments()).has('_attachments/p.png')).toBe(false);
  });

  it('writeMany / removeMany 批量生效', async () => {
    await a.writeMany!([{ path: 'x/1.md', content: '1' }, { path: 'x/2.md', content: '2' }]);
    expect((await a.readAll()).size).toBe(2);
    await a.removeMany!(['x/1.md', 'x/2.md']);
    expect((await a.readAll()).size).toBe(0);
  });
});

describe('TauriAdapter 安全与原子写', () => {
  let a: TauriAdapter;
  beforeEach(() => { resetFs(); a = new TauriAdapter('KnowLattice'); });

  it('拒绝 .. 越界与绝对路径', async () => {
    await expect(a.write('../evil.md', 'x')).rejects.toThrow();
    await expect(a.write('/etc/passwd', 'x')).rejects.toThrow();
    await expect(a.write('C:/Windows/x.md', 'x')).rejects.toThrow();
    await expect(a.read('a/../../b.md')).rejects.toThrow();
  });

  it('原子写不残留 .tmp 临时文件', async () => {
    await a.write('01/a.md', '# A\n');
    expect([...tree.keys()].filter((k) => k.includes('.tmp-'))).toEqual([]);
  });

  it('listAll 返回 .md 元信息', async () => {
    await a.write('01/a.md', '# A\n');
    await a.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([1])]));
    const metas = await a.listAll();
    expect(metas.map((m) => m.path)).toEqual(['01/a.md']);
  });

  // 回归守卫：目录「存在但读不动」绝不能被伪装成空库，
  // 否则迁移守卫失效，IndexedDB 快照会覆盖用户磁盘上的真实笔记。
  it('readDir 失败时 readAll/listAll 抛错而不是返回空（目录存在但读不动）', async () => {
    await a.write('01/a.md', '# A\n');
    armReadDirFailure(() => true);
    await expect(a.readAll()).rejects.toThrow('模拟目录读取失败');
    await expect(a.listAll()).rejects.toThrow('模拟目录读取失败');
  });

  it('目录确实不存在时才算空库（新库语义保留）', async () => {
    // 不写入任何文件：root 目录从未创建
    expect(await a.readAll()).toEqual(new Map());
    expect(await a.listAll()).toEqual([]);
    expect(await a.readAllAttachments()).toEqual(new Map());
  });

  it('附件目录读不动时抛错；不存在时返回空 Map', async () => {
    expect(await a.readAllAttachments()).toEqual(new Map());
    await a.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([1])]));
    armReadDirFailure((p) => p.endsWith('_attachments'));
    await expect(a.readAllAttachments()).rejects.toThrow('模拟目录读取失败');
  });
});

describe('TauriAdapter 自定义目录（绝对路径模式）', () => {
  beforeEach(() => { resetFs(); });

  it('fs 调用落在所选绝对目录下，vault 相对路径仍拒绝越界', async () => {
    const a = new TauriAdapter('C:/Users/t/MyVault');
    expect(a.root).toBe('C:/Users/t/MyVault');
    await a.write('01/a.md', '# A\n');
    expect(tree.has('C:/Users/t/MyVault/01/a.md')).toBe(true);
    expect(await a.read('01/a.md')).toBe('# A\n');
    await expect(a.write('../evil.md', 'x')).rejects.toThrow();
    await expect(a.write('/etc/passwd', 'x')).rejects.toThrow();
    expect([...tree.keys()].some((k) => !k.startsWith('C:/Users/t/MyVault/') && k.endsWith('.md'))).toBe(false);
  });

  it('目录表达形式规范化：反斜杠、尾随斜杠归一', async () => {
    const a = new TauriAdapter('C:\\Users\\t\\MyVault\\');
    await a.write('a.md', '# A\n');
    expect(tree.has('C:/Users/t/MyVault/a.md')).toBe(true);
  });

  it('拒绝含 NUL 的目录', () => {
    expect(() => new TauriAdapter('C:/bad\0dir')).toThrow();
  });
});
