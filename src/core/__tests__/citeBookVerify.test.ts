// @vitest-environment node
/**
 * 教材引用按需核验：引用带了书名时直接查本机教材原文，
 * 不依赖本轮是否检索过这本教材（否则真实引文会被误报「未找到出处」）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMedBookTexts, listMedBookMeta } = vi.hoisted(() => ({
  getMedBookTexts: vi.fn(),
  listMedBookMeta: vi.fn(async () => [] as Array<{ title: string; pages: number; extractablePages: number }>),
}));

vi.mock('../../storage/medStore', () => ({
  getMedBookTexts,
  getMedBookText: vi.fn(async () => null),
  listMedBookMeta,
  listMedBookRecords: vi.fn(async () => []),
  removeMedBook: vi.fn(async () => {}),
}));

import { citeKeyOf, invalidateMedBooksCache, verifyQuotesAgainstBooks } from '../medBooks';

const META = [{ title: '生理学（第9版）', pages: 400, extractablePages: 400 }];
const TEXT = '<!--kb:P142-->\n肾小球滤过率（GFR）是指单位时间内两肾生成的超滤液量，正常成人约为 125 ml/min。';

beforeEach(() => {
  getMedBookTexts.mockReset();
  listMedBookMeta.mockReset();
  listMedBookMeta.mockResolvedValue(META);
  getMedBookTexts.mockResolvedValue([{ name: '生理学（第9版）', text: TEXT }]);
  invalidateMedBooksCache();
});

describe('verifyQuotesAgainstBooks', () => {
  it('教材里逐字有的引文 → exact，并报出是哪本书', async () => {
    const out = await verifyQuotesAgainstBooks([
      { book: '生理学', quote: '正常成人约为 125 ml/min' },
    ]);
    expect(out.get(citeKeyOf('生理学', '正常成人约为 125 ml/min'))?.status).toBe('exact');
    expect(out.get(citeKeyOf('生理学', '正常成人约为 125 ml/min'))?.book).toBe('生理学（第9版）');
  });

  it('数字被改写的引文 → 数字严格通道判 fabricated（不放过 125 → 999）', async () => {
    const out = await verifyQuotesAgainstBooks([{ book: '生理学', quote: '正常成人约为 999 ml/min' }]);
    expect(out.get(citeKeyOf('生理学', '正常成人约为 999 ml/min'))?.status).toBe('fabricated');
  });

  it('没导入任何教材：不读全文，返回空（调用方保留原结论，不伪造核验通过）', async () => {
    listMedBookMeta.mockResolvedValue([]);
    const out = await verifyQuotesAgainstBooks([{ book: '生理学', quote: '任何句子' }]);
    expect(out.size).toBe(0);
    expect(getMedBookTexts).not.toHaveBeenCalled();
  });

  it('书名对不上任何一本已导入教材：不读全文，返回空', async () => {
    const out = await verifyQuotesAgainstBooks([{ book: '不存在的书', quote: '任何句子' }]);
    expect(out.size).toBe(0);
    expect(getMedBookTexts).not.toHaveBeenCalled();
  });

  it('书名带空格的多段变体也能命中（与检索同一套 bookMatches 口径）', async () => {
    const out = await verifyQuotesAgainstBooks([{ book: '生理学 第9版', quote: '正常成人约为 125 ml/min' }]);
    expect(out.size).toBe(1);
  });

  it('空书名或空引文一律跳过', async () => {
    const out = await verifyQuotesAgainstBooks([
      { book: '  ', quote: '正常成人约为 125 ml/min' },
      { book: '生理学', quote: '   ' },
    ]);
    expect(out.size).toBe(0);
  });
});
