// @vitest-environment node
/** 自适应抽题（P0-2）：按「离目标正确率多远」分桶取题，桶内仍加权随机。 */
import { describe, expect, it } from 'vitest';
import { adaptivePick, composeQuestions, DEFAULT_RULES } from '../qbankCompose';
import { targetDistance } from '../qbankDifficulty';
import type { QuizBank, QuizQuestion } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';

const stat = (o: Partial<QStat> = {}): QStat => ({
  due: 0, stability: 0, difficulty: 5, elapsed: 0, scheduled: 0, steps: 0,
  reps: 0, lapses: 0, state: 0, lastReview: 0, wrong: 0, ...o,
});
const q = (id: string, chapter = '第1章'): QuizQuestion => ({
  id, type: 'choice', stem: '题 ' + id, options: ['A', 'B'], answer: 0, answerText: 'A', chapter,
});
const bank = (qs: QuizQuestion[]): QuizBank => ({ name: '测试库', importedAt: 0, questions: qs });
const bucketOf = (s: QStat | undefined) => Math.floor(targetDistance(s) / 0.1);

describe('adaptivePick', () => {
  it('优先取离目标正确率最近的题', () => {
    const qs = [q('perfect'), q('near'), q('awful')];
    const per: Record<string, QStat> = {
      perfect: stat({ reps: 3, wrong: 0 }),
      near: stat({ reps: 3, wrong: 1 }),
      awful: stat({ reps: 3, wrong: 3 }),
    };
    expect(adaptivePick(qs, per, 1).map((x) => x.id)).toEqual(['near']);
  });

  it('没做过的题用先验（50%），挤不掉更接近目标的题', () => {
    const qs = [q('unseen'), q('near')];
    const per: Record<string, QStat> = { near: stat({ reps: 3, wrong: 1 }) };
    expect(adaptivePick(qs, per, 1).map((x) => x.id)).toEqual(['near']);
  });

  it('输出按桶由近到远，且不超过 k', () => {
    const qs = ['a', 'b', 'c', 'd'].map((id) => q(id));
    const per: Record<string, QStat> = {
      a: stat({ reps: 3, wrong: 3 }),   // 0%
      b: stat({ reps: 3, wrong: 1 }),   // 66.7%
      c: stat({ reps: 3, wrong: 1 }),   // 66.7%
      d: stat({ reps: 3, wrong: 0 }),   // 100%
    };
    const out = adaptivePick(qs, per, 3);
    expect(out).toHaveLength(3);
    const buckets = out.map((x) => bucketOf(per[x.id]));
    expect(buckets).toEqual([...buckets].sort((x, y) => x - y));
    // 最近的那桶（b/c）一定在里面，最远的（a，0%）一定不在
    expect(out.map((x) => x.id)).toContain('b');
    expect(out.map((x) => x.id)).not.toContain('a');
  });

  it('同一桶里的题只要 k 够就都取到（桶内是随机而不是 Top-1）', () => {
    const qs = ['x', 'y'].map((id) => q(id));
    const per: Record<string, QStat> = {
      x: stat({ reps: 3, wrong: 1 }),
      y: stat({ reps: 3, wrong: 1 }),
    };
    expect(adaptivePick(qs, per, 2).map((x) => x.id).sort()).toEqual(['x', 'y']);
  });

  it('k 超过候选数时返回全部，不死循环', () => {
    const qs = [q('only')];
    expect(adaptivePick(qs, {}, 5)).toHaveLength(1);
  });
});

describe('composeQuestions + order=adaptive', () => {
  it('遵守 count 与 scope，并按目标正确率挑题', () => {
    const bk = bank([q('perfect'), q('near'), q('awful')]);
    const stats: StatsMap = {
      测试库: {
        perfect: stat({ reps: 3, wrong: 0 }),
        near: stat({ reps: 3, wrong: 1 }),
        awful: stat({ reps: 3, wrong: 3 }),
      },
    };
    const got = composeQuestions(bk, { ...DEFAULT_RULES, count: 2, order: 'adaptive' }, stats);
    expect(got).toHaveLength(2);
    expect(got.map((x) => x.id)).toContain('near');
    expect(got.map((x) => x.id)).not.toContain('awful');
  });

  it('过滤池仍然生效：scope=wrong 只从错过的题里挑', () => {
    const bk = bank([q('clean'), q('missed')]);
    const stats: StatsMap = {
      测试库: {
        clean: stat({ reps: 3, wrong: 0 }),
        missed: stat({ reps: 3, wrong: 1 }),
      },
    };
    const got = composeQuestions(bk, { ...DEFAULT_RULES, count: 5, order: 'adaptive', scope: 'wrong' }, stats);
    expect(got.map((x) => x.id)).toEqual(['missed']);
  });
});
