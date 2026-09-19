/**
 * 迁移测试：旧标识 medvault → knowlattice。
 * 这一步错了就是用户笔记 / 题库 / 复习进度全丢，必须守住：
 * localStorage 前缀改名、IndexedDB 整库复制（结构 + 记录）、幂等。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { migrateIndexedDb, migrateLocalStorage } from '../migrate';

async function wipeIndexedDb(): Promise<void> {
  const names = (await indexedDB.databases())
    .map((d) => d.name)
    .filter((n): n is string => !!n);
  await Promise.all(names.map((n) => new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(n);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  })));
}

beforeEach(async () => {
  localStorage.clear();
  await wipeIndexedDb();
});

describe('migrateLocalStorage', () => {
  it('medvault-* 键复制到 knowlattice-* 并删掉旧键', () => {
    localStorage.setItem('medvault-srs', '{"a":1}');
    localStorage.setItem('medvault-theme', 'dark');
    localStorage.setItem('other', 'keep');
    migrateLocalStorage();
    expect(localStorage.getItem('knowlattice-srs')).toBe('{"a":1}');
    expect(localStorage.getItem('knowlattice-theme')).toBe('dark');
    expect(localStorage.getItem('medvault-srs')).toBeNull();
    expect(localStorage.getItem('medvault-theme')).toBeNull();
    expect(localStorage.getItem('other')).toBe('keep');
  });

  it('幂等：新键已存在时不被旧值覆盖', () => {
    localStorage.setItem('medvault-theme', 'dark');
    localStorage.setItem('knowlattice-theme', 'light');
    migrateLocalStorage();
    expect(localStorage.getItem('knowlattice-theme')).toBe('light');
    expect(localStorage.getItem('medvault-theme')).toBeNull();
  });
});

describe('migrateIndexedDb', () => {
  it('整库复制到新名（含结构与记录），并删除旧库', async () => {
    const old = await openDB('medvault', 2, {
      upgrade(d) {
        d.createObjectStore('files', { keyPath: 'path' });
        d.createObjectStore('attachments', { keyPath: 'path' });
      },
    });
    await old.put('files', { path: 'a.md', content: '# A', mtime: 1, size: 3 });
    await old.put('files', { path: 'b.md', content: '# B', mtime: 2, size: 3 });
    await old.put('attachments', { path: '_attachments/x.png', blob: new Blob(['x']), mtime: 1, size: 1 });
    old.close();

    await migrateIndexedDb();

    const next = await openDB('knowlattice', 2);
    const files = await next.getAll('files');
    expect(files.map((f) => f.path).sort()).toEqual(['a.md', 'b.md']);
    expect((await next.get('files', 'a.md'))?.content).toBe('# A');
    expect(await next.get('attachments', '_attachments/x.png')).toBeTruthy();
    next.close();

    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain('medvault');
  });

  it('新库已存在时不动它（幂等）', async () => {
    const old = await openDB('medvault', 1, {
      upgrade(d) { d.createObjectStore('files', { keyPath: 'path' }); },
    });
    await old.put('files', { path: 'old.md', content: 'old', mtime: 1, size: 3 });
    old.close();

    const cur = await openDB('knowlattice', 2, {
      upgrade(d) { d.createObjectStore('files', { keyPath: 'path' }); },
    });
    await cur.put('files', { path: 'new.md', content: 'new', mtime: 1, size: 3 });
    cur.close();

    await migrateIndexedDb();

    const next = await openDB('knowlattice', 2);
    expect(await next.get('files', 'old.md')).toBeUndefined();
    expect((await next.get('files', 'new.md'))?.content).toBe('new');
    next.close();
  });
});
