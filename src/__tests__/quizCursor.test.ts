/**
 * 断点续做：游标存取与恢复。
 * 重点守两件事——**坏数据当没有**（半个游标会让续做停在错的位置），
 * 以及**题库变了也能续上**（增量合并后题库顺序会变，靠 id 找题）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCursor, loadCursor, resumeQuestions, saveCursor } from '../core/quizCursor';

const DAY = 24 * 3600 * 1000;

describe('quizCursor', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('存进去读出来是同一份（含组卷规则）', () => {
    const rules = { count: 20, scope: 'all', order: 'random' } as never;
    saveCursor({ bank: '生理学', qids: ['a', 'b', 'c'], idx: 1, rules, at: 1000 });
    const got = loadCursor(1000 + DAY);
    expect(got).not.toBeNull();
    expect(got!.bank).toBe('生理学');
    expect(got!.qids).toEqual(['a', 'b', 'c']);
    expect(got!.idx).toBe(1);
    expect(got!.rules).toEqual(rules);
  });

  it('一轮已经做完（idx 越界）就不再提示续做', () => {
    saveCursor({ bank: 'b', qids: ['a', 'b'], idx: 2, rules: null, at: 1000 });
    expect(loadCursor(1000)).toBeNull();
  });

  it('放置超过两周的游标当作没有', () => {
    saveCursor({ bank: 'b', qids: ['a'], idx: 0, rules: null, at: 1000 });
    expect(loadCursor(1000 + 15 * DAY)).toBeNull();
    expect(loadCursor(1000 + 13 * DAY)).not.toBeNull();
  });

  it('内容坏了 / 形状不对一律当作没有，不抛出', () => {
    localStorage.setItem('knowlattice-quiz-cursor', '{坏 JSON');
    expect(loadCursor()).toBeNull();
    localStorage.setItem('knowlattice-quiz-cursor', JSON.stringify({ bank: 'b' }));
    expect(loadCursor()).toBeNull();
    localStorage.setItem('knowlattice-quiz-cursor', JSON.stringify({ bank: 'b', qids: [], idx: 0, at: Date.now() }));
    expect(loadCursor()).toBeNull();
    localStorage.setItem('knowlattice-quiz-cursor', JSON.stringify({ bank: 'b', qids: ['a'], idx: -1, at: Date.now() }));
    expect(loadCursor()).toBeNull();
  });

  it('clear 之后读到 null', () => {
    saveCursor({ bank: 'b', qids: ['a'], idx: 0, rules: null, at: Date.now() });
    clearCursor();
    expect(loadCursor()).toBeNull();
  });

  it('恢复时按 id 找题、跳过已不存在的题，并让续做位置跟着往前挪', () => {
    const pool = [
      { id: 'a', stem: 'A' },
      { id: 'c', stem: 'C' },
      { id: 'd', stem: 'D' },
    ];
    // 原顺序 a,b,c → b 已被删；原来停在下标 2（c），跳过 b 之后 c 在新数组里是下标 1
    const r = resumeQuestions({ bank: 'b', qids: ['a', 'b', 'c'], idx: 2, rules: null, at: 0 }, pool);
    expect(r).not.toBeNull();
    expect(r!.questions.map((q) => q.id)).toEqual(['a', 'c']);
    expect(r!.idx).toBe(1);
  });

  it('题库题全被换掉时返回 null（上层据此清游标）', () => {
    expect(resumeQuestions({ bank: 'b', qids: ['x'], idx: 0, rules: null, at: 0 }, [{ id: 'a' }])).toBeNull();
  });

  it('下标超出可恢复范围时钳到最后一题，不会越界', () => {
    const r = resumeQuestions({ bank: 'b', qids: ['a', 'b', 'c'], idx: 2, rules: null, at: 0 }, [{ id: 'a' }]);
    expect(r!.questions).toHaveLength(1);
    expect(r!.idx).toBe(0);
  });
it('已答对错与当前已选项一起存回：恢复后分数不会清零', () => {
    saveCursor({
      bank: 'b', qids: ['a', 'b', 'c'], idx: 2, rules: null,
      results: [true, false, null], picked: [1, 3], at: 1000,
    });
    const got = loadCursor(1000)!;
    expect(got.results).toEqual([true, false, null]);
    expect(got.picked).toEqual([1, 3]);
    const r = resumeQuestions(got, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])!;
    expect(r.results).toEqual([true, false, null]);
  });

  it('恢复时跳过已删除的题，对错表跟着题目一起搬（不错位）', () => {
    saveCursor({
      bank: 'b', qids: ['a', 'b', 'c'], idx: 2, rules: null,
      results: [true, false, true], at: 1000,
    });
    const got = loadCursor(1000)!;
    const r = resumeQuestions(got, [{ id: 'a' }, { id: 'c' }])!;
    // b 被删了，c 的记录不能顶到 b 的位置上
    expect(r.results).toEqual([true, true]);
    expect(r.idx).toBe(1);
  });

  it('对错表长度与题目数不符（旧版游标）就当没有，不让分数错位', () => {
    saveCursor({ bank: 'b', qids: ['a', 'b'], idx: 1, rules: null, results: [true], at: 1000 });
    expect(loadCursor(1000)!.results).toBeUndefined();
  });
});
