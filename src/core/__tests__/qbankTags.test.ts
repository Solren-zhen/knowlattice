// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { QuizBank, QuizQuestion } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';
import {
  accuracyOf, buildTagContext, difficultyBand, difficultyCounts, highFreqChapters, isHighFreq,
  MIN_HIGH_FREQ, statusTagOf, tagCounts, tagsOf,
} from '../qbankTags';

function stat(over: Partial<QStat> = {}): QStat {
  return {
    due: 0, stability: 1, difficulty: 5, elapsed: 0, scheduled: 1, steps: 0,
    reps: 3, lapses: 0, state: 2, lastReview: 0, wrong: 0, ...over,
  };
}

function q(id: string, chapter: string): QuizQuestion {
  return { id, type: 'choice', stem: `s${id}`, options: ['A', 'B'], answer: 0, answerText: 'A', chapter };
}

describe('qbankTags · 状态与难度', () => {
  it('没做过 = 新题', () => {
    expect(statusTagOf(undefined)).toBe('new');
    expect(difficultyBand(undefined)).toBe('unknown');
  });

  it('错过且正确率低 = 易错；全对且做过 ≥2 次 = 已掌握；其余 = 在学', () => {
    expect(statusTagOf(stat({ reps: 4, wrong: 3 }))).toBe('weak'); // 25%
    expect(statusTagOf(stat({ reps: 3, wrong: 0 }))).toBe('solid');
    expect(statusTagOf(stat({ reps: 1, wrong: 1 }))).toBe('weak');
    expect(statusTagOf(stat({ reps: 5, wrong: 1 }))).toBe('learning'); // 80%
  });

  it('accuracyOf 从 reps/wrong 推导，且不会出现负数', () => {
    expect(accuracyOf(stat({ reps: 4, wrong: 1 }))).toBeCloseTo(0.75);
    expect(accuracyOf(stat({ reps: 0, wrong: 0 }))).toBe(0);
    expect(accuracyOf(stat({ reps: 1, wrong: 5 }))).toBe(0);
  });

  it('难度档来自 FSRS difficulty', () => {
    expect(difficultyBand(stat({ difficulty: 2 }))).toBe('easy');
    expect(difficultyBand(stat({ difficulty: 5 }))).toBe('medium');
    expect(difficultyBand(stat({ difficulty: 9 }))).toBe('hard');
  });
});

describe('qbankTags · 高频考点', () => {
  const bank: QuizBank = {
    name: 'B', importedAt: 0,
    questions: [
      ...Array.from({ length: 10 }, (_, i) => q(`big${i}`, '生理学·大章')),
      q('small0', '生理学·小章'),
      q('small1', '生理学·小章'),
    ],
  };

  it('高频阈值不低于下限，大章判为高频、小章不是', () => {
    const ctx = buildTagContext(bank);
    expect(ctx.highFreqMin).toBeGreaterThanOrEqual(MIN_HIGH_FREQ);
    expect(isHighFreq(bank.questions[0], ctx)).toBe(true);
    expect(isHighFreq(bank.questions[10], ctx)).toBe(false);
  });

  it('小题库不会被全部标成高频（阈值下限兜底）', () => {
    const tiny: QuizBank = { name: 'T', importedAt: 0, questions: [q('a', 'x'), q('b', 'x')] };
    const ctx = buildTagContext(tiny);
    expect(isHighFreq(tiny.questions[0], ctx)).toBe(false);
  });

  it('tagsOf 叠加高频维度；tagCounts 分类计数', () => {
    const ctx = buildTagContext(bank);
    expect(tagsOf(bank.questions[0], undefined, ctx)).toEqual(['new', 'highfreq']);
    const stats: StatsMap = { B: { big0: stat({ reps: 4, wrong: 3 }), small0: stat() } };
    const counts = tagCounts(bank, stats);
    expect(counts.weak).toBe(1);
    expect(counts.highfreq).toBe(10);
    expect(counts.solid).toBe(1);
    expect(counts.new).toBe(10);
  });

  it('highFreqChapters 按题量排序并带易错数', () => {
    const stats: StatsMap = { B: { big0: stat({ reps: 2, wrong: 2 }) } };
    const top = highFreqChapters(bank, stats);
    expect(top[0]).toMatchObject({ chapter: '生理学·大章', total: 10, weak: 1 });
  });

  it('difficultyCounts 按 FSRS difficulty 分档，没做过的计入 unknown', () => {
    const stats: StatsMap = {
      B: { big0: stat({ difficulty: 2 }), big1: stat({ difficulty: 5 }), big2: stat({ difficulty: 9 }) },
    };
    const counts = difficultyCounts(bank, stats);
    expect(counts).toMatchObject({ easy: 1, medium: 1, hard: 1 });
    expect(counts.unknown).toBe(9); // 12 题 - 3 题有记录
  });
});
