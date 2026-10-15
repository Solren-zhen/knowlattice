// @vitest-environment jsdom
/**
 * 收藏 / 重点题：切换 → 读回 → 持久化 → 备份合并。
 * 与逐题统计分开存（见 core/qbankStarred 头部），所以这里单独覆盖它自己的读写纪律。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetQbankStorageForTests } from '../../storage/qbank';
import {
  initializeStars, importStars, isStarred, loadStars, resetStarsForTests,
  setStar, starCount, toggleStar,
} from '../qbankStarred';

const BANK = '绿皮书·生理学';

describe('收藏 / 重点题', () => {
  beforeEach(async () => {
    localStorage.clear();
    await resetQbankStorageForTests();
    resetStarsForTests();
  });

  it('切换收藏后能读回，并真的持久化到 IndexedDB', async () => {
    await initializeStars();
    expect(isStarred(loadStars(), BANK, 'a')).toBe(false);

    expect(await toggleStar(BANK, 'a')).toBe(true);
    expect(isStarred(loadStars(), BANK, 'a')).toBe(true);

    // 重新初始化（模拟重启）应从存储读回同一份，而不是靠内存缓存
    resetStarsForTests();
    await initializeStars();
    expect(isStarred(loadStars(), BANK, 'a')).toBe(true);

    expect(await toggleStar(BANK, 'a')).toBe(false);
    expect(isStarred(loadStars(), BANK, 'a')).toBe(false);
  });

  it('starCount 只数该题库', async () => {
    await initializeStars();
    await toggleStar(BANK, 'a');
    await toggleStar(BANK, 'b');
    await toggleStar('另一库', 'a');
    expect(starCount(loadStars(), BANK)).toBe(2);
    expect(starCount(loadStars(), '另一库')).toBe(1);
  });

  it('setStar 幂等：已是目标状态不重复写', async () => {
    await initializeStars();
    await setStar(BANK, 'a', true);
    await setStar(BANK, 'a', true);
    expect(starCount(loadStars(), BANK)).toBe(1);
    await setStar(BANK, 'a', false);
    await setStar(BANK, 'a', false);
    expect(starCount(loadStars(), BANK)).toBe(0);
  });

  it('importStars 只增不减（并集）：本地已收藏的保留，备份里多出来的补上', async () => {
    await initializeStars();
    await toggleStar(BANK, 'keep');
    await importStars({ [BANK]: { local: true }, 新库: { x: true } } as unknown);
    const s = loadStars();
    expect(isStarred(s, BANK, 'keep')).toBe(true);
    expect(isStarred(s, BANK, 'local')).toBe(true);
    expect(isStarred(s, '新库', 'x')).toBe(true);
  });

  it('importStars 忽略非法形状，且不抛错', async () => {
    await initializeStars();
    await importStars(null);
    await importStars([1, 2]);
    await importStars({ [BANK]: 'not-an-object' });
    expect(loadStars()).toEqual({});
  });
});
