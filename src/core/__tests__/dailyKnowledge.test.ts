/**
 * 今日知识点的挑选规则。
 *
 * 为什么值得测：这条建议是每天一开面板就看到的，规则错了用户不会察觉「错了」，
 * 只会觉得「推荐得莫名其妙」然后不再看它。三个必须成立的性质：
 * 1) 同一天必须固定——半天内刷新就换一个知识点，「今日」这个词就没意义了；
 * 2) 有错题的章节必须排在没碰过的章节前面——不然和随机没区别；
 * 3) 题太少的章节不进候选——一题一章练不出掌握度。
 */
import { describe, expect, it } from 'vitest';
import { isKnowledgeDone, markKnowledgeDone, pickTodayKnowledge, type KnowledgePick } from '../dailyKnowledge';
import type { QuizQuestion, QuizBank } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';

function q(id: string, chapter: string): QuizQuestion {
  return { id, type: 'choice', stem: `题干${id}`, options: ['甲', '乙'], answer: 0, answerText: '', chapter };
}

function bank(name: string, qs: QuizQuestion[]): QuizBank {
  return { name, importedAt: 1, questions: qs };
}

function stat(patch: Partial<QStat> = {}): QStat {
  return {
    due: Date.now() + 86400_000, stability: 1, difficulty: 5, elapsed: 0, scheduled: 0,
    steps: 0, reps: 1, lapses: 0, state: 2, lastReview: Date.now(), wrong: 0, ...patch,
  } as QStat;
}

const NOW = new Date('2026-03-05T10:00:00').getTime();

describe('pickTodayKnowledge', () => {
  it('没有题库或没有够题的章节时返回 null', () => {
    expect(pickTodayKnowledge([], {}, NOW)).toBeNull();
    // 只有 2 题：低于 MIN_COUNT，不进候选
    expect(pickTodayKnowledge([bank('A', [q('1', '一章'), q('2', '一章')])], {}, NOW)).toBeNull();
  });

  it('有错题的章节排在没练过的章节前面', () => {
    const b = bank('A', [
      q('1', '错题章'), q('2', '错题章'), q('3', '错题章'),
      q('4', '新章'), q('5', '新章'), q('6', '新章'),
    ]);
    const stats: StatsMap = {
      A: {
        '1': stat({ wrong: 2 }), '2': stat({ wrong: 1 }), '3': stat({ wrong: 1 }),
        '4': stat({ reps: 1 }), '5': stat({ reps: 1 }), '6': stat({ reps: 1 }),
      },
    };
    const pick = pickTodayKnowledge([b], stats, NOW);
    expect(pick?.chapter).toBe('错题章');
    expect(pick?.reason).toBe('wrong');
    expect(pick?.wrong).toBe(4);
  });

  it('同一天多次调用结果一致（刷新不换知识点）', () => {
    const b = bank('A', [
      ...['1', '2', '3'].map((i) => q(i, '甲章')),
      ...['4', '5', '6'].map((i) => q(i, '乙章')),
      ...['7', '8', '9'].map((i) => q(i, '丙章')),
    ]);
    const first = pickTodayKnowledge([b], {}, NOW);
    for (let i = 0; i < 5; i += 1) {
      expect(pickTodayKnowledge([b], {}, NOW + 1000 * i)?.chapter).toBe(first?.chapter);
    }
  });

  it('掌握度按已做题里的正确比例算，没做过是 0', () => {
    const b = bank('A', [q('1', '章'), q('2', '章'), q('3', '章'), q('4', '章')]);
    // 4 题里答过 2 题：1 题从没答错、1 题错过 → 掌握度 = 1/2
    const stats: StatsMap = { A: { '1': stat({ reps: 2 }), '2': stat({ reps: 1, wrong: 3 }) } };
    const pick = pickTodayKnowledge([b], stats, NOW);
    expect(pick?.count).toBe(4);
    expect(pick?.mastery).toBe(0.5);
  });

  it('到期的题会把章节往前排（没错题时）', () => {
    const b = bank('A', [
      ...['1', '2', '3'].map((i) => q(i, '到期章')),
      ...['4', '5', '6'].map((i) => q(i, '未做章')),
    ]);
    // 到期时间必须相对 NOW 算：用 Date.now() 会因为「今天是 2026-03-05」而永远不到期
    const past = NOW - 86400_000;
    const stats: StatsMap = { A: { '1': stat({ due: past }), '2': stat({ due: past }), '3': stat({ due: past }) } };
    const pick = pickTodayKnowledge([b], stats, NOW);
    expect(pick?.chapter).toBe('到期章');
    expect(pick?.reason).toBe('due');
  });
});

describe('今日知识点的完成标记', () => {
  const pick = (date: string): KnowledgePick => ({
    date, bank: 'A', chapter: '一章', reason: 'fresh', count: 3, wrong: 0, due: 0, mastery: 0,
  });

  it('标记后当天为已看过，换天自然失效', () => {
    const today = pick('2026-03-05');
    expect(isKnowledgeDone(today)).toBe(false);
    expect(markKnowledgeDone(today)).toBe(true);
    expect(isKnowledgeDone(today)).toBe(true);
    // 同一天同一个知识点，刷新后仍然是「看过了」
    expect(isKnowledgeDone(pick('2026-03-05'))).toBe(true);
    // 第二天同一个知识点要重新出现
    expect(isKnowledgeDone(pick('2026-03-06'))).toBe(false);
  });
});
