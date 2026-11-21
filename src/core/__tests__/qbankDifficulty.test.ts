// @vitest-environment node
/** 实测难度校准：样本不足不下结论、标称 vs 实测的三种关系、自适应用的收缩预测。 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_ACCURACY, EMPIRICAL_EASY_MIN, EMPIRICAL_HARD_MAX, UNSEEN_PRIOR,
  bandOfLevel, calibSentence, calibrateBank, calibrateQuestion, empiricalAccuracy,
  empiricalBand, hardestFirst, levelOfBand, predictedAccuracy, summarizeCalib,
  targetDistance, withDifficulty, type QuestionCalib,
} from '../qbankDifficulty';
import { normalizeQuestions, type QuizBank, type QuizQuestion } from '../qbank';
import type { QStat } from '../qbankStats';

const stat = (o: Partial<QStat> = {}): QStat => ({
  due: 0, stability: 0, difficulty: 5, elapsed: 0, scheduled: 0, steps: 0,
  reps: 0, lapses: 0, state: 0, lastReview: 0, wrong: 0, ...o,
});

describe('empiricalAccuracy', () => {
  it('没作答过是 null，不是 0（「没练过」不能说成「全错」）', () => {
    expect(empiricalAccuracy(undefined)).toBeNull();
    expect(empiricalAccuracy(stat())).toBeNull();
  });
  it('(reps - wrong) / reps', () => {
    expect(empiricalAccuracy(stat({ reps: 4, wrong: 1 }))).toBeCloseTo(0.75);
    expect(empiricalAccuracy(stat({ reps: 3, wrong: 5 }))).toBe(0); // 数据脏了也不返回负
  });
});

describe('empiricalBand', () => {
  it('分档边界：85% 及以上算简单，低于 55% 算困难', () => {
    expect(empiricalBand(1)).toBe('easy');
    expect(empiricalBand(EMPIRICAL_EASY_MIN)).toBe('easy');
    expect(empiricalBand(0.7)).toBe('medium');
    expect(empiricalBand(EMPIRICAL_HARD_MAX)).toBe('medium');
    expect(empiricalBand(EMPIRICAL_HARD_MAX - 0.01)).toBe('hard');
    expect(empiricalBand(null)).toBe('unknown');
  });
});

describe('calibrateQuestion', () => {
  it('作答次数不够时只记 unrated，不判校准', () => {
    const r = calibrateQuestion('q1', stat({ reps: 2, wrong: 2, difficulty: 2 }), '第1章');
    expect(r.status).toBe('unrated');
    expect(r.nominal).toBe('easy');
    expect(r.empirical).toBe('hard');
    expect(r.chapter).toBe('第1章');
  });
  it('FSRS 说简单、实测全错 → tooHard（按「简单」筛会漏掉它）', () => {
    const r = calibrateQuestion('q1', stat({ reps: 4, wrong: 4, difficulty: 1 }));
    expect(r.nominal).toBe('easy');
    expect(r.empirical).toBe('hard');
    expect(r.status).toBe('tooHard');
  });
  it('FSRS 说困难、实测全对 → tooEasy', () => {
    const r = calibrateQuestion('q1', stat({ reps: 4, wrong: 0, difficulty: 9 }));
    expect(r.status).toBe('tooEasy');
  });
  it('两档一致 → ok', () => {
    expect(calibrateQuestion('q1', stat({ reps: 4, wrong: 1, difficulty: 5 })).status).toBe('ok');
  });
  it('没做过 → nominal/empirical 都是 unknown', () => {
    const r = calibrateQuestion('q1', undefined);
    expect(r.nominal).toBe('unknown');
    expect(r.empirical).toBe('unknown');
    expect(r.rate).toBeNull();
    expect(r.status).toBe('unrated');
  });
});

const row = (canon: Partial<QuestionCalib>): QuestionCalib => ({
  id: 'q', chapter: '', attempts: 3, wrong: 0, rate: 1, nominal: 'medium', declared: false,
  empirical: 'medium', suggested: 2, status: 'ok', ...canon,
});

describe('summarizeCalib / calibSentence', () => {
  it('从未做过的题不进 total', () => {
    const s = summarizeCalib([
      row({ attempts: 0, rate: null, status: 'unrated' }),
      row({ status: 'tooHard' }),
      row({ status: 'tooEasy' }),
      row({ status: 'ok' }),
      row({ attempts: 2, status: 'unrated' }),
    ]);
    expect(s).toEqual({ total: 4, rated: 3, ok: 1, tooHard: 1, tooEasy: 1, unrated: 1, declared: 0 });
  });
  it('没样本时不给结论（空串）', () => {
    expect(calibSentence(summarizeCalib([]))).toBe('');
    expect(calibSentence(summarizeCalib([row({ attempts: 1, status: 'unrated' })]))).toBe('');
  });
  it('全部一致时说一致，不报无意义的 0', () => {
    expect(calibSentence(summarizeCalib([row({}), row({})]))).toContain('一致');
    const mixed = calibSentence(summarizeCalib([row({ status: 'tooHard' }), row({})]));
    expect(mixed).toContain('1 题实测比标称难');
    expect(mixed).not.toContain('比标称容易');
  });
});

describe('hardestFirst', () => {
  it('只取 tooHard，正确率低的在前，受 limit 限制', () => {
    const rows = [
      row({ id: 'a', status: 'tooHard', rate: 0.5 }),
      row({ id: 'b', status: 'ok', rate: 0.1 }),
      row({ id: 'c', status: 'tooHard', rate: 0.1, attempts: 9 }),
      row({ id: 'd', status: 'tooHard', rate: 0.4 }),
    ];
    expect(hardestFirst(rows, 2).map((r) => r.id)).toEqual(['c', 'd']);
  });
});

describe('predictedAccuracy', () => {
  it('样本够就用实测', () => {
    expect(predictedAccuracy(stat({ reps: 3, wrong: 1 }))).toBeCloseTo(2 / 3);
    expect(predictedAccuracy(stat({ reps: 10, wrong: 5 }))).toBeCloseTo(0.5);
  });
  it('样本少向先验收缩：做对一次不等于 100%', () => {
    const one = predictedAccuracy(stat({ reps: 1, wrong: 0 }));
    expect(one).toBeGreaterThan(0.6);
    expect(one).toBeLessThan(0.8);
  });
  it('没做过返回先验', () => {
    expect(predictedAccuracy(undefined)).toBe(UNSEEN_PRIOR);
  });
  it('正好命中目标时距离为 0', () => {
    // 10 次里错 3 次 = 70%，正好是默认目标
    expect(targetDistance(stat({ reps: 10, wrong: 3 }))).toBeCloseTo(0, 5);
    // 全错 → 预测 0，距离就是整个目标值
    expect(targetDistance(stat({ reps: 3, wrong: 3 }))).toBeCloseTo(DEFAULT_TARGET_ACCURACY, 5);
  });
});

describe('作者标称难度（difficulty 1/2/3）', () => {
  it('标称与 FSRS 估计是两种东西：作者标了就用作者的', () => {
    // FSRS 觉得很难（difficulty 9 → hard），作者标「简单」，实测全对
    const r = calibrateQuestion('q1', stat({ reps: 4, wrong: 0, difficulty: 9 }), '第1章', 1);
    expect(r.nominal).toBe('easy');
    expect(r.declared).toBe(true);
    expect(r.empirical).toBe('easy');
    expect(r.status).toBe('ok'); // 拿 FSRS 的 hard 当标称会误判成 tooEasy
  });
  it('没标注才退回 FSRS 估计，并标记 declared: false', () => {
    const r = calibrateQuestion('q1', stat({ reps: 4, wrong: 0, difficulty: 9 }), '第1章');
    expect(r.nominal).toBe('hard');
    expect(r.declared).toBe(false);
    expect(r.status).toBe('tooEasy');
  });
  it('从没作答、也没有标称 → unrated，不给建议', () => {
    const r = calibrateQuestion('q1', undefined);
    expect(r.nominal).toBe('unknown');
    expect(r.suggested).toBeNull();
    expect(r.status).toBe('unrated');
  });
  it('1/2/3 与 easy/medium/hard 互转闭环', () => {
    expect(bandOfLevel(1)).toBe('easy');
    expect(bandOfLevel(3)).toBe('hard');
    expect(bandOfLevel(undefined)).toBe('unknown');
    expect(levelOfBand('medium')).toBe(2);
    expect(levelOfBand('unknown')).toBeNull();
    expect(levelOfBand(bandOfLevel(3))).toBe(3);
  });
});

describe('withDifficulty', () => {
  const q = (id: string, difficulty?: 1 | 2 | 3): QuizQuestion => ({
    id, type: 'choice', stem: id, options: ['a', 'b'], answer: 0, answerText: 'a', difficulty,
  });
  const bank: QuizBank = { name: 'b1', importedAt: 1, questions: [q('x', 1), q('y')] };
  it('只改目标题的 difficulty，其余题与题库字段原样', () => {
    const next = withDifficulty(bank, 'x', 3);
    expect(next).not.toBe(bank);
    expect(next.questions[0]).toEqual({ ...q('x', 1), difficulty: 3 });
    expect(next.questions[1]).toEqual(q('y')); // 没标的题不会被顺手补上
    expect(next.name).toBe('b1');
    expect(next.importedAt).toBe(1);
    // 入参不变：落库失败时可以直接丢掉副本
    expect(bank.questions[0].difficulty).toBe(1);
  });
});

describe('calibrateBank 的上下文', () => {
  it('每行带题库名与题干，标称从题目字段读出来', () => {
    const bank: QuizBank = {
      name: 'b1', importedAt: 1,
      questions: [{ id: 'q1', type: 'choice', stem: '题干一', options: ['a'], answer: 0, answerText: 'a', difficulty: 3 }],
    };
    const [row] = calibrateBank(bank, { b1: { q1: stat({ reps: 4, wrong: 4 }) } });
    expect(row.bank).toBe('b1');
    expect(row.stem).toBe('题干一');
    expect(row.nominal).toBe('hard');
    expect(row.declared).toBe(true);
    expect(row.status).toBe('ok');
    expect(summarizeCalib([row]).declared).toBe(1);
  });
});

describe('difficulty 字段的导入透传', () => {
  it('认数字 1-3 与中文/英文档位，其余当没标', () => {
    const pick = (stem: string, extra: Record<string, unknown>) =>
      ({ stem, options: ['a', 'b'], answer: 0, ...extra });
    const [ok, zh, en, bad] = normalizeQuestions([
      pick('s1', { difficulty: 2 }),
      pick('s2', { 难度: '困难' }),
      pick('s3', { level: 'easy' }),
      pick('s4', { difficulty: '很难懂' }),
    ]);
    expect(ok.difficulty).toBe(2);
    expect(zh.difficulty).toBe(3);
    expect(en.difficulty).toBe(1);
    expect('difficulty' in bad).toBe(false);
  });
});
