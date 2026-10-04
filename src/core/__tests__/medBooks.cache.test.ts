// @vitest-environment node
/** 教材全文缓存与「导入/删除」的竞态：在途读库期间失效，旧内容不得写回缓存。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMedBookTexts } = vi.hoisted(() => ({ getMedBookTexts: vi.fn() }));

vi.mock('../../storage/medStore', () => ({
  getMedBookTexts,
  listMedBookMeta: vi.fn(async () => []),
  listMedBookRecords: vi.fn(async () => []),
  removeMedBook: vi.fn(async () => {}),
}));

import { invalidateMedBooksCache, medBooksSearch } from '../medBooks';

const rec = (name: string, text: string) => ({ name, text });

beforeEach(() => {
  getMedBookTexts.mockReset();
  invalidateMedBooksCache();
});

describe('medBooks 全文缓存', () => {
  it('在途读库期间导入/删除教材：旧结果不写回缓存，检索用失效后的新内容', async () => {
    let release!: (v: Array<{ name: string; text: string }>) => void;
    const inFlight = new Promise<Array<{ name: string; text: string }>>((res) => { release = res; });
    getMedBookTexts.mockReturnValueOnce(inFlight);

    const searching = medBooksSearch('麦氏点');
    // 读库还没回来就失效（用户导入了新教材 / 删了一本）
    invalidateMedBooksCache();
    getMedBookTexts.mockResolvedValueOnce([rec('外科学（第10版）', '急性阑尾炎的麦氏点压痛。')]);
    release([rec('内科学（第10版）', '急性心肌梗死的再灌注治疗。')]);

    const hits = await searching;
    expect(hits.some((h) => h.book === '外科学（第10版）')).toBe(true);
    expect(getMedBookTexts).toHaveBeenCalledTimes(2);

    // 旧内容没有污染缓存：再查一次走缓存，不再读库
    const again = await medBooksSearch('再灌注');
    expect(getMedBookTexts).toHaveBeenCalledTimes(2);
    expect(again).toHaveLength(0);
  });

  it('缓存命中不重复读库；失效后重读', async () => {
    getMedBookTexts.mockResolvedValue([rec('内科学（第10版）', '急性心肌梗死的再灌注治疗。')]);
    expect((await medBooksSearch('再灌注')).some((h) => h.book === '内科学（第10版）')).toBe(true);
    expect(getMedBookTexts).toHaveBeenCalledTimes(1);

    await medBooksSearch('再灌注');
    expect(getMedBookTexts).toHaveBeenCalledTimes(1);

    invalidateMedBooksCache();
    await medBooksSearch('再灌注');
    expect(getMedBookTexts).toHaveBeenCalledTimes(2);
  });
});
