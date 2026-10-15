// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { QuizBank, QuizQuestion } from '../qbank';
import {
  buildExamPaper, buildExamResult, chapterScores, DEFAULT_EXAM_CONFIG, EXAM_PASS,
  formatClock, gradeExam, score100, scoreDelta, weakChapters,
} from '../exam';

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

function choice(id: string, chapter: string, answer = 0): QuizQuestion {
  return {
    id, type: 'choice', stem: `题干 ${id}`, options: ['A', 'B', 'C', 'D'],
    answer, answerText: 'A', chapter,
  };
}

describe('exam · 判分', () => {
  it('score100：四舍五入到整数，空卷返回 0（不产生 NaN）', () => {
    expect(score100(2, 3)).toBe(67);
    expect(score100(1, 3)).toBe(33);
    expect(score100(0, 0)).toBe(0);
    expect(EXAM_PASS).toBe(60);
  });

  it('gradeExam：全对算对、少选/错选/未作答都算错，未作答进错题 id', () => {
    const qs = [choice('a', 'X'), choice('b', 'X', 1)];
    const { total, correct, wrongIds } = gradeExam(qs, [[0], null]);
    expect(total).toBe(2);
    expect(correct).toBe(1);
    expect(wrongIds).toEqual(['b']);
  });

  it('多选题全对才算对（少选算错）', () => {
    const multi: QuizQuestion = { id: 'm', type: 'choice', stem: 's', options: ['A', 'B', 'C'], answer: 0, answers: [0, 2], answerText: 'A；C' };
    expect(gradeExam([multi], [[0, 2]]).correct).toBe(1);
    expect(gradeExam([multi], [[0]]).correct).toBe(0);
  });

  it('chapterScores：按主章节归组、正确率低的排前面', () => {
    const qs = [choice('a', '生理学'), choice('b', '生理学'), choice('c', '生化')];
    const scores = chapterScores(qs, [[0], null, [0]]);
    expect(scores[0]).toMatchObject({ chapter: '生理学', total: 2, correct: 1 });
    expect(scores[0].accuracy).toBeCloseTo(0.5);
    expect(scores[1]).toMatchObject({ chapter: '生化', total: 1, correct: 1 });
  });

  it('buildExamResult：用时按限时封顶，成绩与错题 id 一并产出', () => {
    const qs = [choice('a', 'X'), choice('b', 'X')];
    const r = buildExamResult('B', qs, [[0], null], NOW, NOW + 90 * 60_000, 60 * 60_000);
    expect(r.usedMs).toBe(60 * 60_000); // 超时封顶
    expect(r.total).toBe(2);
    expect(r.correct).toBe(1);
    expect(r.score).toBe(50);
    expect(r.wrongIds).toEqual(['b']);
    expect(r.id).toBeTruthy();
  });

  it('weakChapters：只挑样本 ≥2 且正确率 <60% 的章', () => {
    const qs = [choice('a', '弱'), choice('b', '弱'), choice('c', '单题')];
    const r = buildExamResult('B', qs, [[1], [1], [1]], NOW, NOW + 1000, 0);
    expect(weakChapters(r).map((c) => c.chapter)).toEqual(['弱']);
  });

  it('formatClock：分:秒 / 时:分:秒', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_665_000)).toBe('1:01:05');
  });

  it('scoreDelta：与同题库上一场比，没有历史返回 null', () => {
    const a = buildExamResult('B', [choice('a', 'X')], [[0]], NOW, NOW + 1000, 0);
    const b = buildExamResult('B', [choice('a', 'X')], [[1]], NOW + 5000, NOW + 6000, 0);
    expect(scoreDelta(b, [a])).toBe(-100);
    expect(scoreDelta(a, [])).toBeNull();
  });
});

describe('exam · 组卷', () => {
  const bank: QuizBank = {
    name: 'B', importedAt: 0,
    questions: [choice('a', 'X'), choice('b', 'X'), { id: 'r', type: 'recall', stem: 's', options: [], answer: -1, answerText: '答案' }],
  };

  it('只组选择题：简答题无法自动判分，不进整卷', () => {
    const paper = buildExamPaper(bank, { ...DEFAULT_EXAM_CONFIG, count: 0 }, {});
    expect(paper.map((q) => q.id).sort()).toEqual(['a', 'b']);
  });

  it('题量上限 = 候选池大小（只选选择题后按选择题数封顶）', () => {
    const paper = buildExamPaper(bank, { ...DEFAULT_EXAM_CONFIG, count: 50 }, {});
    expect(paper).toHaveLength(2);
  });
});
