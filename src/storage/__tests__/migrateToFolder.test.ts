/**
 * IndexedDB → 文件夹 一次性迁移测试（migrateToFolder.ts）。
 *
 * 源用 fake-indexeddb 里的 WebAdapter 播种，目标用 fsMock 的内存文件树
 * （TauriAdapter 绝对目录模式）。覆盖：附件不丢（含旧版 dataURL 附件转二进制）、
 * 二次运行不重复导入、中途失败可重试、非法路径拒绝、非空文件夹保护。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { WebAdapter } from '../web';
import { TauriAdapter } from '../tauri';
import { migrateIndexedDbToFolder, MIGRATION_MARKER_PATH } from '../migrateToFolder';
import { tree, resetFs, armWriteFailure, clearWriteFailure } from './fsMock';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('./fsMock')).mod);

const VAULT = 'C:/Users/t/MyVault';
const LEGACY_DATAURL = 'data:image/png;base64,AAEC'; // 字节 [0,1,2]

/** 播种一份含笔记、二进制附件、旧版 dataURL 附件的 IndexedDB */
async function seedIdb(): Promise<WebAdapter> {
  const src = new WebAdapter();
  await src.write('01/生理/a.md', '# A\n');
  await src.write('02/b.md', '# B\n');
  await src.writeAttachment('_attachments/p.png', new Blob([new Uint8Array([9, 8, 7])]));
  await src.write('_attachments/legacy.png', LEGACY_DATAURL);
  return src;
}

const bytesOf = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

beforeEach(() => {
  resetFs();
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true, writable: true });
});

describe('migrateIndexedDbToFolder', () => {
  it('迁移不丢附件：笔记、二进制附件、旧版 dataURL 附件都落到所选文件夹', async () => {
    await seedIdb();
    const target = new TauriAdapter(VAULT);
    const r = await migrateIndexedDbToFolder(target);
    expect(r).toMatchObject({ notes: 2, attachments: 2, failed: 0, skipped: false });

    // 笔记按原相对路径写成 .md
    expect(await target.read('01/生理/a.md')).toBe('# A\n');
    expect(await target.read('02/b.md')).toBe('# B\n');
    // 二进制附件原样
    const atts = await target.readAllAttachments();
    expect(await bytesOf(atts.get('_attachments/p.png')!)).toEqual([9, 8, 7]);
    // 旧版 dataURL 附件转成真实二进制（不再是文本 dataURL）
    expect(await bytesOf(atts.get('_attachments/legacy.png')!)).toEqual([0, 1, 2]);
    // 版本标记：done + 计数
    const marker = JSON.parse(await target.read(MIGRATION_MARKER_PATH));
    expect(marker).toMatchObject({ version: 1, status: 'done', notes: 2, attachments: 2 });
  });

  it('二次运行不重复导入：done 标记直接跳过', async () => {
    await seedIdb();
    const target = new TauriAdapter(VAULT);
    await migrateIndexedDbToFolder(target);
    const snapshot = [...tree.entries()].map(([k, v]) => [k, v.kind === 'file' ? [...v.data] : null] as const);
    const r2 = await migrateIndexedDbToFolder(target);
    expect(r2.skipped).toBe(true);
    expect(r2.notes + r2.attachments + r2.failed).toBe(0);
    expect([...tree.entries()].map(([k, v]) => [k, v.kind === 'file' ? [...v.data] : null] as const)).toEqual(snapshot);
  });

  it('中途失败可重试：失败不写 done 标记，重跑自动续齐', async () => {
    await seedIdb();
    const target = new TauriAdapter(VAULT);
    // 让 01/生理/a.md 的写入（tmp 与回退直写）持续失败
    armWriteFailure((p) => p.replace(/\.tmp-.*$/, '') === `${VAULT}/01/生理/a.md`);
    const r1 = await migrateIndexedDbToFolder(target);
    expect(r1.failed).toBeGreaterThan(0);
    clearWriteFailure();

    // 失败后：done 未写、pending 在（允许下次重入续传），其余成功的文件已在
    const pendingMarker = JSON.parse(await target.read(MIGRATION_MARKER_PATH));
    expect(pendingMarker.status).toBe('pending');
    expect(await target.exists('02/b.md')).toBe(true);

    const r2 = await migrateIndexedDbToFolder(target);
    expect(r2).toMatchObject({ notes: 2, attachments: 2, failed: 0, skipped: false });
    expect(await target.read('01/生理/a.md')).toBe('# A\n');
    const marker = JSON.parse(await target.read(MIGRATION_MARKER_PATH));
    expect(marker.status).toBe('done');
  });

  it('目标文件夹已有笔记时拒绝迁移：一个字节都不写，直接标记完成', async () => {
    const target = new TauriAdapter(VAULT);
    await target.write('已有的笔记.md', '# 用户自己的内容\n');
    const r = await migrateIndexedDbToFolder(target);
    expect(r.skipped).toBe(true);
    expect(await target.read('已有的笔记.md')).toBe('# 用户自己的内容\n');
    expect(await target.exists('01/生理/a.md')).toBe(false);
    const marker = JSON.parse(await target.read(MIGRATION_MARKER_PATH));
    expect(marker.status).toBe('done');
  });

  it('非法路径拒绝：源里的越界路径被过滤，不写出 vault 根', async () => {
    const src = await seedIdb();
    await src.write('../evil.md', 'evil');
    await src.writeAttachment('_attachments/../../escape.png', new Blob([new Uint8Array([1])]));
    const target = new TauriAdapter(VAULT);
    const r = await migrateIndexedDbToFolder(target);
    expect(r.notes).toBe(2); // 越界路径不计入成功
    expect([...tree.keys()].some((k) => k.endsWith('evil.md') && !k.startsWith(VAULT))).toBe(false);
    expect([...tree.keys()].some((k) => k.endsWith('escape.png') && !k.startsWith(VAULT))).toBe(false);
  });

  it('浏览器里没有数据时也标记完成，不会反复探测', async () => {
    const target = new TauriAdapter(VAULT);
    const r = await migrateIndexedDbToFolder(target);
    expect(r).toMatchObject({ notes: 0, attachments: 0, failed: 0, skipped: false });
    const marker = JSON.parse(await target.read(MIGRATION_MARKER_PATH));
    expect(marker.status).toBe('done');
    const r2 = await migrateIndexedDbToFolder(target);
    expect(r2.skipped).toBe(true);
  });
});
