// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllQuestionStats, resetQbankStorageForTests } from '../../storage/qbank';
import {
  bankProgress, chapterMastery, consumeSaveFailure, dropBankStats, initializeStats, isDue, loadStats,
  recordAnswer, resetQbankStatsForTests, statOf,
} from '../qbankStats';
import type { QuizBank } from '../qbank';

const KEY = 'knowlattice-qstats';
const BANK = '绿皮书·生理学';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
});

describe('qbankStats · 记录与排程', () => {
  it('答对：写进表里、reps 增加、下次到期时间被推到未来', async () => {
    const rec = await recordAnswer(BANK, 'q-1', true, NOW);
    expect(rec.reps).toBe(1);
    expect(rec.wrong).toBe(0);
    expect(rec.lastReview).toBe(NOW);
    expect(rec.due).toBeGreaterThan(NOW);
    expect(statOf(loadStats(), BANK, 'q-1')).toEqual(rec);
    expect(isDue(rec, NOW)).toBe(false);
  });

  it('答错会累计并采用比答对更短的间隔', async () => {
    const first = await recordAnswer(BANK, 'q-1', false, NOW);
    expect(first.wrong).toBe(1);
    expect(first.state).not.toBe(0);
    const again = await recordAnswer(BANK, 'q-1', false, NOW + 1000);
    expect(again.wrong).toBe(2);
    const good = await recordAnswer(BANK, 'q-2', true, NOW);
    expect(again.due).toBeLessThan(good.due);
  });

  it('连续答对会把到期时间越推越远', async () => {
    let t = NOW;
    let prev = await recordAnswer(BANK, 'q-1', true, t);
    for (let i = 0; i < 4; i++) {
      t = prev.due;
      const next = await recordAnswer(BANK, 'q-1', true, t);
      expect(next.due).toBeGreaterThan(prev.due);
      prev = next;
    }
  });

  it('题目之间互不干扰；不同题库的同名 id 互不干扰', async () => {
    await recordAnswer(BANK, 'q-1', false, NOW);
    await recordAnswer('医考帮·生理学', 'q-1', true, NOW);
    expect(statOf(loadStats(), BANK, 'q-1')!.wrong).toBe(1);
    expect(statOf(loadStats(), '医考帮·生理学', 'q-1')!.wrong).toBe(0);
    expect(statOf(loadStats(), BANK, 'q-2')).toBeUndefined();
  });

  it('迁移旧 localStorage 逐题记录并删除旧副本', async () => {
    localStorage.setItem(KEY, JSON.stringify({ [BANK]: { q1: [100, 1, 1, 0, 0, 0, 0, 0, 0, -1, 2] } }));
    const stats = await initializeStats();
    expect(statOf(stats, BANK, 'q1')).toMatchObject({ due: 100 * 60_000, lastReview: 0, wrong: 2 });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(await getAllQuestionStats()).toHaveLength(1);
  });

  it('迁移旧统计不覆盖 IndexedDB 中较新的逐题记录', async () => {
    await recordAnswer(BANK, 'q1', true, NOW);
    localStorage.setItem(KEY, JSON.stringify({ [BANK]: { q1: [100, 1, 1, 0, 0, 0, 0, 0, 0, -1, 2] } }));
    const restored = statOf(await initializeStats(), BANK, 'q1');
    expect(restored?.wrong).toBe(0);
    expect(restored?.due).toBeGreaterThan(NOW);
  });

  it('暂时无法读取 localStorage 时不标记迁移完成，之后仍能重试', async () => {
    localStorage.setItem(KEY, JSON.stringify({ [BANK]: { q1: [100, 1, 1, 0, 0, 0, 0, 0, 0, -1, 2] } }));
    const readSpy = vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    await expect(initializeStats()).resolves.toEqual({});
    readSpy.mockRestore();
    await recordAnswer(BANK, 'q2', true, NOW);
    expect(statOf(loadStats(), BANK, 'q1')).toBeDefined();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('损坏旧数据里的无效记录会忽略，但有效记录仍可迁移', async () => {
    localStorage.setItem(KEY, JSON.stringify({
      [BANK]: {
        good: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1],
        short: [1, 2],
        notArray: { a: 1 },
        hasNaN: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'x'],
      },
      notAnObject: 42,
    }));
    const stats = await initializeStats();
    expect(statOf(stats, BANK, 'good')).toBeDefined();
    expect(statOf(stats, BANK, 'short')).toBeUndefined();
    expect(statOf(stats, BANK, 'notArray')).toBeUndefined();
    expect(statOf(stats, BANK, 'hasNaN')).toBeUndefined();
    expect(stats.notAnObject).toBeUndefined();
  });

  it('整表是坏 JSON 时不抛，不写迁移标记并可继续答题', async () => {
    localStorage.setItem(KEY, '{oops');
    await expect(initializeStats()).resolves.toEqual({});
    expect(localStorage.getItem(KEY)).toBe('{oops');
    await expect(recordAnswer(BANK, 'q-1', true, NOW)).resolves.toMatchObject({ reps: 1 });
  });
});

describe('qbankStats · IndexedDB 持久化', () => {
  it('题库记录写入 IndexedDB，不再依赖 localStorage 配额', async () => {
    const rec = await recordAnswer(BANK, 'q-1', true, NOW);
    expect(consumeSaveFailure()).toBe(false);
    expect(await getAllQuestionStats()).toEqual([{ bank: BANK, qid: 'q-1', tuple: expect.any(Array) }]);
    resetQbankStatsForTests();
    const restored = statOf(await initializeStats(), BANK, 'q-1')!;
    expect(restored).toMatchObject({ due: rec.due, reps: rec.reps, wrong: rec.wrong });
    expect(restored.stability).toBe(Math.round(rec.stability * 1000) / 1000);
  });
});

describe('qbankStats · 题库级统计与清理', () => {
  it('bankProgress 数出做过/错过/待复习', async () => {
    await recordAnswer(BANK, 'q-1', false, NOW);
    await recordAnswer(BANK, 'q-2', true, NOW);
    const p = bankProgress(BANK, ['q-1', 'q-2', 'q-3'], undefined, NOW);
    expect(p).toMatchObject({ total: 3, seen: 2, wrong: 1, due: 0 });
    expect(bankProgress(BANK, ['q-1', 'q-2', 'q-3'], undefined, NOW + 2 * DAY).due).toBeGreaterThan(0);
  });

  it('dropBankStats 只清掉指定题库', async () => {
    await recordAnswer(BANK, 'q-1', true, NOW);
    await recordAnswer('另一个库', 'q-1', true, NOW);
    await dropBankStats(BANK);
    expect(loadStats()[BANK]).toBeUndefined();
    expect(statOf(loadStats(), '另一个库', 'q-1')).toBeDefined();
  });

  it('逐题记录在 IndexedDB 中保持紧凑元组', async () => {
    const N = 400;
    for (let i = 0; i < N; i++) await recordAnswer(BANK, 'q-' + i, i % 3 !== 0, NOW);
    const records = await getAllQuestionStats();
    expect(records).toHaveLength(N);
    expect(records.every((record) => record.tuple.length === 11)).toBe(true);
  });
});

describe('qbankStats · 章节掌握度（软门控）', () => {
  /** 只关心 id 与 chapter：掌握度不看题干 */
  const mk = (rows: Array<[string, string | undefined]>): QuizBank => ({
    name: BANK,
    importedAt: 0,
    questions: rows.map(([id, chapter]) => ({
      id, type: 'recall', stem: id, options: [], answer: -1, answerText: '', chapter,
    })),
  });
  const chap = (n: number, chapter: string): Array<[string, string]> =>
    Array.from({ length: n }, (_, i) => [`${chapter}-${i}`, chapter]);

  it('没作答过的章节不进样本：不会把「还没练」显示成 0%', () => {
    expect(chapterMastery(mk(chap(3, '第一章')))).toEqual([]);
  });

  it('按题统计：同一道题错三次也只算一道错题', async () => {
    await recordAnswer(BANK, '第一章-0', false, NOW);
    await recordAnswer(BANK, '第一章-0', false, NOW + 1000);
    await recordAnswer(BANK, '第一章-0', false, NOW + 2000);
    await recordAnswer(BANK, '第一章-1', true, NOW);
    await recordAnswer(BANK, '第一章-2', true, NOW);
    const [m] = chapterMastery(mk(chap(3, '第一章')));
    expect(m).toMatchObject({ chapter: '第一章', seen: 3, wrong: 1, weak: false });
    expect(m.accuracy).toBeCloseTo(2 / 3);
  });

  it('样本不足三题不下结论（两题全错也不算 weak）', async () => {
    await recordAnswer(BANK, '第一章-0', false, NOW);
    await recordAnswer(BANK, '第一章-1', false, NOW);
    expect(chapterMastery(mk(chap(2, '第一章')))[0]).toMatchObject({ seen: 2, wrong: 2, accuracy: 0, weak: false });
  });

  it('样本够且正确率低于 60% 才标 weak', async () => {
    for (const [i, ok] of [false, false, false, true, true].entries()) {
      await recordAnswer(BANK, `第一章-${i}`, ok, NOW);
    }
    const [m] = chapterMastery(mk(chap(5, '第一章')));
    expect(m).toMatchObject({ seen: 5, wrong: 3, weak: true });
    expect(m.accuracy).toBeCloseTo(0.4);
  });

  it('正确率正好 60% 不提示（边界是严格小于）', async () => {
    for (const [i, ok] of [true, true, true, false, false].entries()) {
      await recordAnswer(BANK, `第一章-${i}`, ok, NOW);
    }
    expect(chapterMastery(mk(chap(5, '第一章')))[0]).toMatchObject({ seen: 5, wrong: 2, weak: false });
  });

  it('多章节按正确率从差到好排序，没写 chapter 的归到空串', async () => {
    for (let i = 0; i < 3; i++) await recordAnswer(BANK, `甲-${i}`, false, NOW);
    for (let i = 0; i < 3; i++) await recordAnswer(BANK, `乙-${i}`, true, NOW);
    for (const [i, ok] of [false, false, true].entries()) await recordAnswer(BANK, `无-${i}`, ok, NOW);
    const out = chapterMastery(mk([...chap(3, '甲'), ...chap(3, '乙'), ['无-0', undefined], ['无-1', undefined], ['无-2', undefined]]));
    expect(out.map((m) => m.chapter)).toEqual(['甲', '', '乙']);
    expect(out.map((m) => m.weak)).toEqual([true, true, false]);
  });

  it('只统计本库：别的库里的同名题目 id 不会串进来', async () => {
    await recordAnswer('别的库', '第一章-0', false, NOW);
    expect(chapterMastery(mk(chap(3, '第一章')))).toEqual([]);
  });
});
