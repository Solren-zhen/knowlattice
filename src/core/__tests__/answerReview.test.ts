import { describe, expect, it } from 'vitest';
import { analyzePick, letterOf, pickHint } from '../answerReview';
import type { QuizQuestion } from '../qbank';

const single = (answer: number): QuizQuestion => ({ answer, options: ['甲', '乙', '丙', '丁'], stem: 'q' }) as QuizQuestion;
const multi = (answers: number[]): QuizQuestion => ({ answers, options: ['甲', '乙', '丙', '丁'], stem: 'q' }) as QuizQuestion;

describe('analyzePick', () => {
  it('单选答对：全对 + success', () => {
    const a = analyzePick(single(1), [1]);
    expect(a.verdict).toBe('correct');
    expect(a.label).toBe('全对');
    expect(a.tone).toBe('success');
    expect(a.missing).toEqual([]);
    expect(a.extra).toEqual([]);
  });

  it('单选选错项：错选 + danger', () => {
    const a = analyzePick(single(1), [2]);
    expect(a.verdict).toBe('wrong');
    expect(a.label).toBe('错选');
    expect(a.missing).toEqual([1]);
    expect(a.extra).toEqual([2]);
  });

  it('多选少选：漏掉的项进 missing', () => {
    const a = analyzePick(multi([0, 2]), [0]);
    expect(a.verdict).toBe('partial');
    expect(a.label).toBe('少选');
    expect(a.missing).toEqual([2]);
    expect(a.extra).toEqual([]);
  });

  it('多选既漏又添：少选 + 多选', () => {
    const a = analyzePick(multi([0, 2]), [0, 3]);
    expect(a.label).toBe('少选 + 多选');
    expect(a.missing).toEqual([2]);
    expect(a.extra).toEqual([3]);
  });

  it('多选全是错的项：多选', () => {
    const a = analyzePick(multi([0, 2]), [1, 3]);
    expect(a.label).toBe('少选 + 多选');
    const b = analyzePick(multi([0, 2]), [0, 2, 3]);
    expect(b.label).toBe('多选');
    expect(b.extra).toEqual([3]);
  });

  it('未作答：blank，且把正确项列进 missing', () => {
    const a = analyzePick(single(3), []);
    expect(a.verdict).toBe('blank');
    expect(a.label).toBe('未作答');
    expect(a.tone).toBe('neutral');
    expect(a.missing).toEqual([3]);
  });

  it('重复与乱序的下标按集合处理，顺序不影响判定', () => {
    const a = analyzePick(multi([0, 2]), [2, 0, 0]);
    expect(a.verdict).toBe('correct');
    expect(a.missing).toEqual([]);
    expect(a.extra).toEqual([]);
  });
});

describe('pickHint', () => {
  it('把漏选/多选落到字母上', () => {
    expect(letterOf(0)).toBe('A');
    expect(letterOf(3)).toBe('D');
    const a = analyzePick(multi([0, 2]), [0, 3]);
    expect(pickHint(a)).toBe('少选 + 多选：漏选 C，多选 D');
  });

  it('单选答错用「应选/你选了」，不说多选', () => {
    expect(pickHint(analyzePick(single(1), [2]))).toBe('错选：应选 B，你选了 C');
  });

  it('全对时只给标签', () => {
    expect(pickHint(analyzePick(single(1), [1]))).toBe('全对');
  });
});
