/**
 * PDF 书架存取（fake-indexeddb）。
 *
 * 覆盖多书切换的核心行为：进书架 / 按最近打开排序 / 切书读回正文与页码 /
 * 删除后当前指针回落 / 老的「单本存储」迁移不丢书。
 * 这些路径错一条，用户就会看到「书不见了」或「切回去页码不对」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import {
  listPdfBooks, getPdfBook, putPdfBook, removePdfBook, savePdfPage,
  setCurrentPdfBook, getCurrentPdfName, migrateLegacyPdf,
} from '../pdfLib';

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/**
 * 清空书架两个 store（不删库）：
 * 删库会被模块里缓存的连接阻塞、且 openDB 的 upgrade 只在首次跑，
 * 而每个用例要的是「干净起点」，清 store 就够了（与 history.db.test 同一思路）。
 */
async function resetDb() {
  localStorage.clear();
  const db = await openDB('knowlattice-pdfs', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs');
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'name' });
    },
  });
  await db.clear('pdfs');
  await db.clear('books');
  db.close();
}

beforeEach(resetDb);

describe('pdfLib 书架', () => {
  it('存入的书能按最近打开倒序列出，正文按需单独读回', async () => {
    await putPdfBook('解剖学.pdf', buf('A'), 100);
    await putPdfBook('生理学.pdf', buf('B'), 200);

    const books = await listPdfBooks();
    expect(books.map((b) => b.name)).toEqual(['生理学.pdf', '解剖学.pdf']);

    const rec = await getPdfBook('解剖学.pdf');
    expect(rec?.name).toBe('解剖学.pdf');
    expect(new TextDecoder().decode(new Uint8Array(rec!.data))).toBe('A');
    expect(rec?.page).toBe(0);
  });

  it('同名文件重选视为同一本书，覆盖正文而不新增一本', async () => {
    await putPdfBook('解剖学.pdf', buf('旧'), 100);
    await putPdfBook('解剖学.pdf', buf('新'), 300);

    const books = await listPdfBooks();
    expect(books).toHaveLength(1);
    const rec = await getPdfBook('解剖学.pdf');
    expect(new TextDecoder().decode(new Uint8Array(rec!.data))).toBe('新');
  });

  it('最后存入的那本自动成为当前书', async () => {
    await putPdfBook('A.pdf', buf('a'), 1);
    expect(await getCurrentPdfName()).toBe('A.pdf');
    await putPdfBook('B.pdf', buf('b'), 2);
    expect(await getCurrentPdfName()).toBe('B.pdf');

    await setCurrentPdfBook('A.pdf');
    expect(await getCurrentPdfName()).toBe('A.pdf');
  });

  it('记录并读回阅读页码', async () => {
    await putPdfBook('A.pdf', buf('a'), 1);
    await savePdfPage('A.pdf', 42);

    // 页码存在元数据里，读正文时一并带回来
    expect((await getPdfBook('A.pdf'))?.page).toBe(42);
    // 书架列表也带上页码，方便下拉里直接显示「读到第几页」
    expect((await listPdfBooks())[0].page).toBe(42);
  });

  it('删掉当前书后，当前指针回落到最近打开的一本', async () => {
    await putPdfBook('旧.pdf', buf('old'), 100);
    await putPdfBook('新.pdf', buf('new'), 200);
    expect(await getCurrentPdfName()).toBe('新.pdf');

    const rest = await removePdfBook('新.pdf');
    expect(rest.map((b) => b.name)).toEqual(['旧.pdf']);
    expect(await getCurrentPdfName()).toBe('旧.pdf');
    // 正文也一并删掉，不留孤儿数据
    expect(await getPdfBook('新.pdf')).toBeNull();
  });

  it('书架清空后当前指针为空', async () => {
    await putPdfBook('仅此一本.pdf', buf('x'), 1);
    await removePdfBook('仅此一本.pdf');
    expect(await listPdfBooks()).toEqual([]);
    expect(await getCurrentPdfName()).toBeNull();
  });

  it('迁移旧的单本存储：老用户手上那本书并入书架且不丢', async () => {
    // 造出旧版数据结构：pdfs store 里的 'current' 键
    const db = await openDB('knowlattice-pdfs', 2);
    await db.put('pdfs', { name: '老书.pdf', data: buf('legacy') }, 'current');
    db.close();

    await migrateLegacyPdf();

    const books = await listPdfBooks();
    expect(books.map((b) => b.name)).toEqual(['老书.pdf']);
    expect(await getCurrentPdfName()).toBe('老书.pdf');
    const rec = await getPdfBook('老书.pdf');
    expect(new TextDecoder().decode(new Uint8Array(rec!.data))).toBe('legacy');
    // 旧键要清掉，否则下次启动会重复迁移一遍
    const db2 = await openDB('knowlattice-pdfs', 2);
    expect(await db2.get('pdfs', 'current')).toBeUndefined();
    db2.close();
  });
});
