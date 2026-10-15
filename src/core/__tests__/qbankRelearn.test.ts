// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { initializeStats, loadStats, recordAnswer, resetQbankStatsForTests, statOf } from '../qbankStats';

const BANK = '绿皮书·生理学';
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
});

describe('qbankStats · 错题重练闭环', () => {
  it('普通练习里答对不会抹掉历史错次（错题就该一直被加权抽到）', async () => {
    await recordAnswer(BANK, 'q1', false, NOW);
    const good = await recordAnswer(BANK, 'q1', true, NOW + 1000);
    expect(good.wrong).toBe(1);
  });

  it('错题重练模式：答对一次减一次，减到 0 后移出错题池', async () => {
    await recordAnswer(BANK, 'q1', false, NOW);
    await recordAnswer(BANK, 'q1', false, NOW + 1000);
    expect(statOf(loadStats(), BANK, 'q1')!.wrong).toBe(2);
    const one = await recordAnswer(BANK, 'q1', true, NOW + 2000, true);
    expect(one.wrong).toBe(1);
    const zero = await recordAnswer(BANK, 'q1', true, NOW + 3000, true);
    expect(zero.wrong).toBe(0); // 出池（filterPool 判 wrong > 0）
  });

  it('错题重练模式里答错仍然累加，保持高权重', async () => {
    await recordAnswer(BANK, 'q1', true, NOW);
    const rec = await recordAnswer(BANK, 'q1', false, NOW + 1000, true);
    expect(rec.wrong).toBe(1);
  });

  it('wrong 不会降到负数', async () => {
    await initializeStats();
    const rec = await recordAnswer(BANK, 'q-new', true, NOW, true);
    expect(rec.wrong).toBe(0);
  });
});
