import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '../qbank';
import { MASTERY_MIN_SEEN, MASTERY_WEAK_ACCURACY, type QStat } from '../qbankStats';
import { buildChapterIndex } from '../qbankNotes';
import { knowledgeLookup } from '../knowledgeLookup';

// 全部为合成占位数据（甲/乙/丙），不含任何真实医学内容。
const q = (id: string, extra: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id,
  type: 'choice',
  stem: `题干-${id}`,
  options: ['甲选项', '乙选项'],
  answer: 0,
  answerText: '甲选项',
  ...extra,
});

const stat = (wrong: number): QStat => ({
  due: 0, stability: 0, difficulty: 0, elapsed: 0, scheduled: 0,
  steps: 0, reps: 1, lapses: 0, state: 1, lastReview: 0, wrong,
});

const statsOf = (per: Record<string, number>): Record<string, QStat> =>
  Object.fromEntries(Object.entries(per).map(([id, wrong]) => [id, stat(wrong)]));

describe('knowledgeLookup · 空输入与基本形状', () => {
  it('没有题目 → 空数组（stats 缺省也不抛）', () => {
    expect(knowledgeLookup([])).toEqual([]);
    expect(knowledgeLookup([], {})).toEqual([]);
    expect(knowledgeLookup([], statsOf({ 'q-1': 3 }))).toEqual([]);
  });

  it('stats 里出现题目之外 id → 忽略（以题目数组为准）', () => {
    const rows = knowledgeLookup([q('q-1', { chapter: '甲' })], statsOf({ 'q-1': 0, 'q-9': 5 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ knowledge: '甲', total: 1, seen: 1, wrong: 0, topWrong: null });
  });

  it('单章一道题：题数/已做/正确题数/正确率逐项对得上', () => {
    const rows = knowledgeLookup([q('q-1', { chapter: '甲' })], statsOf({ 'q-1': 1 }));
    expect(rows).toEqual([
      {
        knowledge: '甲',
        total: 1,
        seen: 1,
        correct: 0,
        wrong: 1,
        accuracy: 0,
        weak: false,
        topWrong: { id: 'q-1', stem: '题干-q-1', wrong: 1 },
        notePath: null,
      },
    ]);
  });

  it('没标章节的题归到空串那一档（既有「未标注」档位，不新开）', () => {
    const rows = knowledgeLookup([q('q-1'), q('q-2', { chapter: '甲' })], statsOf({ 'q-1': 0, 'q-2': 0 }));
    expect(rows.map((r) => r.knowledge).sort()).toEqual(['', '甲'].sort());
    expect(rows.find((r) => r.knowledge === '')).toMatchObject({ total: 1, seen: 1, accuracy: 1 });
  });
});

describe('knowledgeLookup · 多章节题在各章各计一次', () => {
  it('一道题归两章：total / seen / topWrong 在两章里都各出现一次', () => {
    const rows = knowledgeLookup(
      [q('q-1', { chapters: ['甲', '乙'] })],
      statsOf({ 'q-1': 2 }),
    );
    expect(rows.map((r) => r.knowledge).sort()).toEqual(['乙', '甲'].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ total: 1, seen: 1, wrong: 1, correct: 0, accuracy: 0 });
      expect(r.topWrong).toEqual({ id: 'q-1', stem: '题干-q-1', wrong: 2 });
    }
  });

  it('chapters 里的重复项不把同一题在同一章里记两次', () => {
    const rows = knowledgeLookup([q('q-1', { chapters: ['甲', '甲', '乙'] })], statsOf({ 'q-1': 0 }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.total === 1 && r.seen === 1)).toBe(true);
  });

  it('只有 chapter（无 chapters）时与单值口径一致', () => {
    const rows = knowledgeLookup(
      [q('q-1', { chapter: '甲' }), q('q-2', { chapters: ['甲', '丙'] })],
      statsOf({ 'q-1': 0, 'q-2': 0 }),
    );
    expect(rows.find((r) => r.knowledge === '甲')).toMatchObject({ total: 2, seen: 2 });
    expect(rows.find((r) => r.knowledge === '丙')).toMatchObject({ total: 1, seen: 1 });
  });
});

describe('knowledgeLookup · 未作答的知识点也在表里', () => {
  it('没作答记录的章节：total 有值、seen/correct/accuracy 为 0、weak=false、topWrong=null', () => {
    const rows = knowledgeLookup(
      [q('q-1', { chapter: '甲' }), q('q-2', { chapter: '乙' })],
      statsOf({ 'q-1': 1 }),
    );
    const b = rows.find((r) => r.knowledge === '乙')!;
    expect(b).toMatchObject({ total: 1, seen: 0, correct: 0, wrong: 0, accuracy: 0, weak: false, topWrong: null });
    // 「还没练」不能被说成「掌握差」
    expect(b.weak).toBe(false);
  });
});

describe('knowledgeLookup · 除零', () => {
  it('0 个作答样本不做 0/0：accuracy 是 0 而不是 NaN', () => {
    const rows = knowledgeLookup([q('q-1', { chapter: '甲' })], {});
    expect(rows[0].accuracy).toBe(0);
    expect(Number.isNaN(rows[0].accuracy)).toBe(false);
    expect(rows[0].correct).toBe(0);
  });
});

describe('knowledgeLookup · 样本不足的阈值（沿用 qbankStats 既有阈值）', () => {
  const rowsFor = (wrong: number, seen: number) => {
    const qs = Array.from({ length: seen }, (_, i) => q(`q-${i}`, { chapter: '甲' }));
    const per = Object.fromEntries(qs.map((x, i) => [x.id, i < wrong ? 2 : 0]));
    return knowledgeLookup(qs, statsOf(per))[0];
  };

  it(`样本数 = ${MASTERY_MIN_SEEN - 1} 且全错：仍不判 weak（样本不足）`, () => {
    const r = rowsFor(MASTERY_MIN_SEEN - 1, MASTERY_MIN_SEEN - 1);
    expect(r).toMatchObject({ seen: MASTERY_MIN_SEEN - 1, accuracy: 0, weak: false });
  });

  it(`样本数 = ${MASTERY_MIN_SEEN} 且正确率低于阈值：判 weak`, () => {
    const r = rowsFor(MASTERY_MIN_SEEN, MASTERY_MIN_SEEN);
    expect(r).toMatchObject({ seen: MASTERY_MIN_SEEN, accuracy: 0, weak: true });
  });

  it('正确率恰好等于阈值：不判 weak（严格小于）', () => {
    // 5 题错 2 → 0.6，恰好是 MASTERY_WEAK_ACCURACY
    const r = rowsFor(2, 5);
    expect(r.accuracy).toBeCloseTo(MASTERY_WEAK_ACCURACY, 10);
    expect(r.weak).toBe(false);
  });

  it('weak 的判定与 qbankStats 的阈值表达式逐项一致（不是另定一套阈值）', () => {
    const r = rowsFor(4, 5);
    expect(r.weak).toBe(r.seen >= MASTERY_MIN_SEEN && r.accuracy < MASTERY_WEAK_ACCURACY);
    expect(r.weak).toBe(true);
  });
});

describe('knowledgeLookup · 排序确定性', () => {
  it('有作答记录的知识点排在没作答的前面', () => {
    const rows = knowledgeLookup(
      [q('q-1', { chapter: '乙' }), q('q-2', { chapter: '甲' })],
      statsOf({ 'q-1': 0, 'q-2': 0 }),
    );
    // 两章accuracy 都是 1、seen 都是 1 → 同级，靠章节名自然序收尾
    expect(rows.map((r) => r.knowledge)).toEqual(['乙', '甲']);
  });

  it('正确率低的在前，同率样本多的在前', () => {
    const rows = knowledgeLookup(
      [
        q('a-0', { chapter: '甲' }), q('a-1', { chapter: '甲' }),
        q('b-0', { chapter: '乙' }),
        q('c-0', { chapter: '丙' }),
      ],
      // 甲：2 题错 1 → 0.5；乙：1 题错 1 → 0；丙：1 题错 0 → 1
      statsOf({ 'a-0': 0, 'a-1': 1, 'b-0': 1, 'c-0': 0 }),
    );
    expect(rows.map((r) => r.knowledge)).toEqual(['乙', '甲', '丙']);
  });

  it('前两级并列时按章节名自然序（「第2章」在「第10章」前），且与输入顺序无关', () => {
    const forward = [q('q-1', { chapter: '第10章' }), q('q-2', { chapter: '第2章' })];
    const stats = statsOf({ 'q-1': 1, 'q-2': 1 });
    const a = knowledgeLookup(forward, stats).map((r) => r.knowledge);
    const b = knowledgeLookup([...forward].reverse(), stats).map((r) => r.knowledge);
    expect(a).toEqual(['第2章', '第10章']);
    expect(b).toEqual(a);
  });

  it('完全并列（都没作答）时输入顺序打乱不影响输出顺序', () => {
    const qs = [q('q-3', { chapter: '乙' }), q('q-1', { chapter: '甲' }), q('q-2', { chapter: '丙' })];
    const a = knowledgeLookup(qs, {}).map((r) => r.knowledge);
    const b = knowledgeLookup([...qs].reverse(), {}).map((r) => r.knowledge);
    expect(a).toEqual(['乙', '丙', '甲'].sort());
    expect(b).toEqual(a);
  });

  it('两次调用（同一输入）结果逐字相同', () => {
    const qs = [q('q-1', { chapter: '甲' }), q('q-2', { chapter: '乙' })];
    const stats = statsOf({ 'q-1': 1, 'q-2': 1 });
    expect(knowledgeLookup(qs, stats)).toEqual(knowledgeLookup([...qs], stats));
  });
});

describe('knowledgeLookup · 错得最多的题', () => {
  it('取累计答错次数最大的那道，即使它的 id 更大', () => {
    const rows = knowledgeLookup(
      [q('q-a', { chapter: '甲' }), q('q-z', { chapter: '甲' })],
      statsOf({ 'q-a': 1, 'q-z': 5 }),
    );
    expect(rows[0].topWrong).toEqual({ id: 'q-z', stem: '题干-q-z', wrong: 5 });
  });

  it('答错次数并列时按题目 id 升序，与输入顺序无关', () => {
    const qs = [q('q-b', { chapter: '甲' }), q('q-a', { chapter: '甲' })];
    const stats = statsOf({ 'q-a': 2, 'q-b': 2 });
    expect(knowledgeLookup(qs, stats)[0].topWrong).toEqual({ id: 'q-a', stem: '题干-q-a', wrong: 2 });
    expect(knowledgeLookup([...qs].reverse(), stats)[0].topWrong).toEqual({ id: 'q-a', stem: '题干-q-a', wrong: 2 });
  });

  it('整章一道都没错过 → topWrong 为 null', () => {
    const rows = knowledgeLookup([q('q-1', { chapter: '甲' })], statsOf({ 'q-1': 0 }));
    expect(rows[0].topWrong).toBeNull();
  });

  it('错得最多的题只在它所属的各章里出现，不影响别的知识点', () => {
    const rows = knowledgeLookup(
      [q('q-1', { chapters: ['甲', '乙'] }), q('q-2', { chapter: '丙' })],
      statsOf({ 'q-1': 3, 'q-2': 1 }),
    );
    expect(rows.find((r) => r.knowledge === '甲')!.topWrong?.id).toBe('q-1');
    expect(rows.find((r) => r.knowledge === '乙')!.topWrong?.id).toBe('q-1');
    expect(rows.find((r) => r.knowledge === '丙')!.topWrong?.id).toBe('q-2');
  });
});

describe('knowledgeLookup · 相关笔记（复用 qbankNotes 的索引）', () => {
  it('复用 buildChapterIndex 的产物：命中给路径，未命中给 null', () => {
    const index = buildChapterIndex([
      '题库/甲源/甲/第1章 绪论.md',
      '_attachments/图.png', // 四段结构之外，不该进索引
    ]);
    const rows = knowledgeLookup(
      [q('q-1', { chapter: '甲·第1章 绪论' }), q('q-2', { chapter: '乙' })],
      statsOf({ 'q-1': 0, 'q-2': 0 }),
      index,
    );
    expect(rows.find((r) => r.knowledge === '甲·第1章 绪论')!.notePath).toBe('题库/甲源/甲/第1章 绪论.md');
    expect(rows.find((r) => r.knowledge === '乙')!.notePath).toBeNull();
  });

  it('不传索引时 notePath 一律 null（不凭空猜路径）', () => {
    const rows = knowledgeLookup([q('q-1', { chapter: '甲·第1章 绪论' })], statsOf({ 'q-1': 0 }));
    expect(rows[0].notePath).toBeNull();
  });
});
