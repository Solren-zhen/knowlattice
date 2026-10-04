/**
 * 医学教材索引存储（fake-indexeddb）。
 *
 * 覆盖清单 / 正文分离、同名覆盖、删除清理，以及缓存失效后检索能读到新书。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { getMedBookTexts, listMedBookMeta, listMedBookRecords, putMedBook, removeMedBook } from '../../storage/medStore';
import { invalidateMedBooksCache, medBooksSearch } from '../medBooks';

async function resetDb() {
  const db = await openDB('knowlattice-medbooks', 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'name' });
      if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
    },
  });
  await db.clear('meta');
  await db.clear('texts');
  db.close();
}

beforeEach(async () => {
  await resetDb();
  invalidateMedBooksCache();
});

const rec = (name: string, at: number, text: string) => ({
  name, pages: 3, extractablePages: 3, chars: text.length, at, text,
});

describe('medStore', () => {
  it('清单不含正文，按导入时间倒序', async () => {
    await putMedBook(rec('生理学（第10版）', 100, '呼吸系统。'));
    await putMedBook(rec('内科学（第10版）', 200, '循环系统。'));

    const list = await listMedBookRecords();
    expect(list.map((r) => r.name)).toEqual(['内科学（第10版）', '生理学（第10版）']);
    const meta = await listMedBookMeta();
    expect(meta[0]).toEqual({ title: '内科学（第10版）', pages: 3, extractablePages: 3 });
  });

  it('读回全文供检索', async () => {
    await putMedBook(rec('药理学（第10版）', 1, '阿司匹林不可逆抑制环氧化酶。'));
    const texts = await getMedBookTexts();
    expect(texts).toEqual([{ name: '药理学（第10版）', text: '阿司匹林不可逆抑制环氧化酶。' }]);
  });

  it('同名覆盖，不新增条目', async () => {
    await putMedBook(rec('A', 1, '旧内容'));
    await putMedBook(rec('A', 2, '新内容'));
    expect((await listMedBookRecords())).toHaveLength(1);
    expect((await getMedBookTexts())[0].text).toBe('新内容');
  });

  it('删除后正文与清单一并清掉', async () => {
    await putMedBook(rec('A', 1, 'x'));
    await removeMedBook('A');
    expect(await listMedBookRecords()).toEqual([]);
    expect(await getMedBookTexts()).toEqual([]);
  });
});

describe('medBooks 门面', () => {
  it('检索走缓存，失效后能读到新导入的书', async () => {
    await putMedBook(rec('内科学（第10版）', 1, '急性心肌梗死的再灌注治疗。'));
    const before = await medBooksSearch('再灌注');
    // 未失效缓存：先加载
    expect((await medBooksSearch('再灌注')).length + before.length).toBeGreaterThan(0);

    await putMedBook(rec('外科学（第10版）', 2, '急性阑尾炎的麦氏点压痛。'));
    invalidateMedBooksCache();
    const hits = await medBooksSearch('麦氏点');
    expect(hits.some((h) => h.book === '外科学（第10版）')).toBe(true);
  });
});
