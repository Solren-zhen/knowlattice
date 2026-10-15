// @vitest-environment node
/**
 * 学习报告的单测：全部用**纯合成占位数据**（甲/乙/丙、题目 N），不含任何医学内容。
 *
 * 重点覆盖两类容易出事的地方：
 *   1. 数据不足时**绝不编造数字**（空数据、样本不足阈值边界、空值格式化）；
 *   2. 口径与既有聚合**逐字一致**（多章节各计一次、多选全对才算对、按题正确率），
 *      所以这里会直接把 qbankStats.chapterMastery 的结果拿来对比，而不是手写期望值。
 */
import { describe, expect, it } from 'vitest';
import { State, type Card } from 'ts-fsrs';
import { chapterMastery, type QStat } from '../qbankStats';
import { chapterHeat } from '../mistakes';
import { DEFAULT_PLAN } from '../reviewPlan';
import type { QuizBank, QuizQuestion } from '../qbank';
import type { ReviewCard } from '../srsCards';
import {
  EMPTY, REPEAT_WRONG_MIN, buildStudyReport, fmtCount, fmtDateTime, fmtDay, fmtPct, rangeOfPreset,
  type StudyReport, type StudyReportInput,
} from '../studyReport';

const NOW = new Date(2026, 0, 15, 9, 0, 0).getTime();
const DAY = 86_400_000;

function qOf(id: string, extra: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id,
    type: 'choice',
    stem: `题目 ${id}`,
    options: ['甲', '乙', '丙', '丁'],
    answer: 0,
    answerText: '甲',
    ...extra,
  };
}

function bankOf(name: string, questions: QuizQuestion[]): QuizBank {
  return { name, importedAt: 0, questions };
}

/** 逐题记录：只写报告真正会读的字段，其余给稳定的占位值 */
function stat(wrong: number, over: Partial<QStat> = {}): QStat {
  return {
    due: NOW,
    stability: 1,
    difficulty: 5,
    elapsed: 0,
    scheduled: 1,
    steps: 0,
    reps: 1,
    lapses: wrong,
    state: State.Review,
    lastReview: NOW,
    wrong,
    ...over,
  };
}

function cardOf(key: string): ReviewCard {
  return { key, path: `${key}.md`, noteTitle: `笔记 ${key}`, heading: '小节', body: '正文', hints: [] };
}

function cardState(wrong: number, over: Partial<Card> = {}): Card {
  return {
    due: new Date(NOW + DAY),
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: wrong,
    state: State.Review,
    last_review: new Date(NOW),
    ...over,
  };
}

/** 最小可用输入：空数据；各用例只覆盖自己关心的字段 */
function input(over: Partial<StudyReportInput> = {}): StudyReportInput {
  return {
    banks: [],
    stats: {},
    cards: [],
    schedules: {},
    plan: { ...DEFAULT_PLAN },
    mistakes: {},
    now: NOW,
    ...over,
  };
}

function body(r: StudyReport, heading: string): string {
  const s = r.sections.find((x) => x.heading === heading);
  if (!s) throw new Error(`报告缺少小节：${heading}`);
  return s.body;
}

describe('studyReport · 数据不足时绝不编造数字', () => {
  it('空数据：不崩、明说不足、正文里没有 NaN / undefined / 0%', () => {
    const r = buildStudyReport(input());

    expect(r.title).toBe('学习报告');
    expect(r.sufficient).toBe(false);
    expect(r.sections.map((s) => s.heading)).toEqual([
      '概览', '题目练习', '薄弱章节', '错题分布', '复习卡', '下一步建议', '口径说明',
    ]);

    expect(r.markdown).not.toMatch(/NaN|undefined|Infinity/);
    // 「还没有作答」不能写成 0%：那是把「没练」说成「掌握差」
    expect(r.markdown).not.toMatch(/正确率 ?0\.0%/);
    expect(r.data.quiz.accuracy).toBeNull();
    expect(r.data.quiz.multiAccuracy).toBeNull();
    expect(r.data.cards.reviewedInRange).toBeNull();
    expect(r.data.mistakes.failedInRange).toBeNull();

    expect(body(r, '概览')).toContain(`距考试：${EMPTY}（未设置考试日期）`);
    expect(body(r, '题目练习')).toContain('还没有导入题库');
    expect(body(r, '薄弱章节')).toContain('还没有章节掌握度数据');
    expect(body(r, '错题分布')).toContain('还没有累计答错记录');
    expect(body(r, '复习卡')).toContain('还没有笔记');
    expect(body(r, '下一步建议')).toContain('数据不足');
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(r.highlights.join('|')).not.toMatch(/NaN|undefined/);
  });

  it('每个 section 的标题与正文都能在 Markdown 里逐字找到（单一来源）', () => {
    const r = buildStudyReport(input({ banks: [bankOf('甲库', [qOf('q1', { chapter: '甲章' })])], stats: { 甲库: { q1: stat(0) } } }));
    for (const s of r.sections) {
      expect(r.markdown).toContain(`## ${s.heading}`);
      expect(r.markdown).toContain(s.body);
    }
  });

  it('有题库但一题未答：正确率写「—」，不写 0%', () => {
    const r = buildStudyReport(input({ banks: [bankOf('甲库', [qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' })])] }));
    expect(r.data.quiz.questions).toBe(2);
    expect(r.data.quiz.seen).toBe(0);
    expect(r.data.quiz.accuracy).toBeNull();
    expect(body(r, '题目练习')).toContain('还没有作答记录');
    expect(body(r, '题目练习')).toContain(`正确率无从计算（不写 0%）`);
    expect(r.markdown).not.toMatch(/正确率 ?0\.0%/);
  });

  it('样本不足阈值边界：2 题全错 → 不达 3 题阈值，只报样本数、不下结论', () => {
    const bank = bankOf('甲库', [qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' })]);
    const r = buildStudyReport(input({ banks: [bank], stats: { 甲库: { q1: stat(1), q2: stat(1) } } }));

    expect(r.data.chapters.weak).toEqual([]);
    expect(r.data.chapters.insufficient).toEqual([{ bank: '甲库', chapter: '甲章', seen: 2 }]);
    expect(body(r, '薄弱章节')).toContain('样本不足，不下结论');
    expect(body(r, '薄弱章节')).toContain('只有 2 题样本');
    // 建议里绝不能出现「整体正确率低于 60%」这种越界结论
    expect(body(r, '下一步建议')).not.toContain('整体按题正确率');
    expect(body(r, '题目练习')).toContain('样本不足：只有 2 题作答记录');
  });

  it('样本刚好到阈值（3 题）才标薄弱，且正确率与 chapterMastery 完全一致', () => {
    const bank = bankOf('甲库', [
      qOf('q1', { chapter: '甲章' }),
      qOf('q2', { chapter: '甲章' }),
      qOf('q3', { chapter: '甲章' }),
    ]);
    const stats = { 甲库: { q1: stat(1), q2: stat(1), q3: stat(0) } };
    const r = buildStudyReport(input({ banks: [bank], stats }));

    const expected = chapterMastery(bank, stats).filter((m) => m.weak);
    expect(r.data.chapters.weak).toHaveLength(expected.length);
    expect(r.data.chapters.weak[0]).toMatchObject({ bank: '甲库', chapter: '甲章', seen: 3, wrong: 2 });
    expect(r.data.chapters.weak[0].accuracy).toBeCloseTo(expected[0].accuracy, 12);
    expect(body(r, '薄弱章节')).toContain('正确率 33.3%');
    expect(body(r, '下一步建议')).toContain('建议优先复习');
  });

  it('正确率恰好等于薄弱阈值（60%）不算薄弱：比较是严格小于', () => {
    const bank = bankOf('甲库', ['a', 'b', 'c', 'd', 'e'].map((id) => qOf(id, { chapter: '甲章' })));
    // 5 题里 2 题答错过 → 正确率 0.6，刚好卡在阈值上
    const stats = { 甲库: { a: stat(1), b: stat(1), c: stat(0), d: stat(0), e: stat(0) } };
    const r = buildStudyReport(input({ banks: [bank], stats }));

    expect(r.data.quiz.accuracy).toBeCloseTo(0.6, 12);
    expect(r.data.chapters.weak).toEqual([]);
    expect(r.data.chapters.insufficient).toEqual([]);
  });
});

describe('studyReport · 口径与既有聚合一致', () => {
  it('多章节题在每个章节各计一次（与 qbankStats.chapterMastery 同口径）', () => {
    const bank = bankOf('甲库', [
      qOf('q1', { chapters: ['甲章', '乙章'] }),
      qOf('q2', { chapters: ['甲章', '乙章'] }),
      qOf('q3', { chapters: ['甲章', '乙章'] }),
    ]);
    const stats = { 甲库: { q1: stat(1), q2: stat(1), q3: stat(1) } };
    const r = buildStudyReport(input({ banks: [bank], stats }));

    // 一题多章节：每章各记一次，所以 3 题在 2 章里产生 6 个样本
    expect(r.data.chapters.weak.map((w) => w.chapter).sort()).toEqual(['乙章', '甲章']);
    expect(r.data.chapters.weak.map((w) => w.seen)).toEqual([3, 3]);
    const expected = chapterMastery(bank, stats).filter((m) => m.weak).map((m) => ({ chapter: m.chapter, seen: m.seen, wrong: m.wrong }));
    expect(r.data.chapters.weak.map((w) => ({ chapter: w.chapter, seen: w.seen, wrong: w.wrong })))
      .toEqual(expect.arrayContaining(expected));
  });

  it('同一题只算一次：反复做错同一题不会把题数或章节样本翻倍', () => {
    const bank = bankOf('甲库', [qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' }), qOf('q3', { chapter: '甲章' })]);
    // q1 错了 9 次、q2 错了 1 次：章节样本仍是 3 题、错题仍是 2 道（不按次数翻倍）
    const r = buildStudyReport(input({ banks: [bank], stats: { 甲库: { q1: stat(9), q2: stat(1), q3: stat(0) } } }));

    expect(r.data.quiz.seen).toBe(3);
    expect(r.data.quiz.wrong).toBe(2);
    expect(r.data.quiz.accuracy).toBeCloseTo(1 / 3, 12);
    expect(r.data.repeatWrong).toHaveLength(1);
    expect(r.data.chapters.weak[0]).toMatchObject({ chapter: '甲章', seen: 3, wrong: 2 });
  });

  it('选择题正确率按题统计（答错过即算错题），多选单独统计且全对才算对', () => {
    const bank = bankOf('甲库', [
      qOf('q1', { answers: [0, 2] }), // 多选：没全对 → wrong>0
      qOf('q2', { answers: [1, 3] }), // 多选：全对 → wrong=0
      qOf('q3'), // 单选
      qOf('q4'), // 从未作答
    ]);
    const stats = { 甲库: { q1: stat(1), q2: stat(0), q3: stat(0) } };
    const r = buildStudyReport(input({ banks: [bank], stats }));

    expect(r.data.quiz.questions).toBe(4);
    expect(r.data.quiz.seen).toBe(3);
    expect(r.data.quiz.wrong).toBe(1);
    expect(r.data.quiz.accuracy).toBeCloseTo(2 / 3, 12);

    expect(r.data.quiz.multiTotal).toBe(2);
    expect(r.data.quiz.multiSeen).toBe(2);
    expect(r.data.quiz.multiWrong).toBe(1);
    expect(r.data.quiz.multiAccuracy).toBeCloseTo(0.5, 12);
    expect(body(r, '题目练习')).toContain('共 2 题，已作答 2 题，正确率 50.0%（答错过 1 题）');
  });

  it('没有多选题时如实说没有，不把 0 写成 0%', () => {
    const r = buildStudyReport(input({ banks: [bankOf('甲库', [qOf('q1')])], stats: { 甲库: { q1: stat(0) } } }));
    expect(r.data.quiz.multiTotal).toBe(0);
    expect(r.data.quiz.multiAccuracy).toBeNull();
    expect(body(r, '题目练习')).toContain('题库里没有多选题');
  });

  it('「重复错同一题」复用 QStat.wrong，并沿用错题本的 ≥2 次档位', () => {
    const bank = bankOf('甲库', [qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' })]);
    const r = buildStudyReport(input({
      banks: [bank],
      stats: { 甲库: { q1: stat(REPEAT_WRONG_MIN), q2: stat(1) } },
    }));

    expect(r.data.repeatWrong).toHaveLength(1);
    expect(r.data.repeatWrong[0]).toMatchObject({ bank: '甲库', qid: 'q1', wrong: 2 });
    expect(body(r, '错题分布')).toContain(`重复错过 ≥${REPEAT_WRONG_MIN} 次的题：1 道`);
    expect(body(r, '下一步建议')).toContain(`累计答错 ≥${REPEAT_WRONG_MIN} 次`);
  });

  it('错题本按章节分布，与 mistakes.chapterHeat 同源', () => {
    const mistakes = {
      '甲.md': { path: '甲.md', chapter: '甲章', title: '甲笔记', count: 3, lastFailedAt: NOW - DAY, reason: 'knowledge' as const },
      '乙.md': { path: '乙.md', chapter: '甲章', title: '乙笔记', count: 1, lastFailedAt: NOW },
      '丙.md': { path: '丙.md', chapter: '乙章', title: '丙笔记', count: 2, lastFailedAt: NOW },
    };
    const r = buildStudyReport(input({
      mistakes,
      mistakeReasons: [
        { reason: 'knowledge', count: 1, unlabeled: 2 },
        { reason: 'confusion', count: 0, unlabeled: 2 },
        { reason: 'careless', count: 0, unlabeled: 2 },
        { reason: 'reasoning', count: 0, unlabeled: 2 },
      ],
    }));

    expect(r.data.mistakes.chapters).toEqual(chapterHeat(mistakes));
    expect(r.data.mistakes.fails).toBe(6);
    expect(body(r, '错题分布')).toContain('错题本：3 处，累计失败 6 次');
    expect(body(r, '错题分布')).toContain('知识没记住 1；未标注 2 条');
    // 最需要回看的错题按累计次数排序
    expect(r.data.mistakes.top[0]).toMatchObject({ title: '甲笔记', count: 3 });
  });

  it('复习卡：已排程 / 今日到期 / 已掌握（State.Review）/ 新卡四个数字各就各位', () => {
    const cards = [cardOf('甲'), cardOf('乙'), cardOf('丙'), cardOf('丁')];
    const schedules = {
      甲: cardState(0, { state: State.Review, due: new Date(NOW - DAY) }), // 到期
      乙: cardState(0, { state: State.Learning }), // 学习阶段，未掌握
      丙: cardState(0, { state: State.Review, due: new Date(NOW + 10 * DAY) }),
      // 丁 没有调度 → 新卡
    };
    const r = buildStudyReport(input({ cards, schedules }));

    expect(r.data.cards).toMatchObject({ total: 4, learned: 3, dueNow: 1, mastered: 2, newCards: 1 });
    expect(body(r, '复习卡')).toContain('共 4 张（已进入调度 3 张，新卡 1 张）');
    expect(body(r, '复习卡')).toContain('今日到期：1 张');
    expect(body(r, '复习卡')).toContain('已掌握（FSRS 进入复习阶段 State.Review）：2 张');
    expect(body(r, '下一步建议')).toContain('今天有 1 张卡到期');
  });

  it('复习计划：距考试天数走 daysUntilExam（本地日历日），并按既有函数算收紧后的上限', () => {
    const r = buildStudyReport(input({
      cards: [cardOf('甲'), cardOf('乙')],
      plan: { examDate: '2026-01-20', examLabel: '甲考试', dailyCap: 8 },
      now: NOW,
    }));

    // 2026-01-15 → 2026-01-20 共 5 天
    expect(r.data.daysUntilExam).toBe(5);
    expect(body(r, '概览')).toContain('还有 5 天（甲考试 · 2026-01-20）');
    expect(r.highlights).toContain('距考试 5 天');
    // 2 张新卡 / 5 天 = 1 张/天，上限 8 收紧为 1
    expect(body(r, '下一步建议')).toContain('还有 2 张新卡未进入调度');
    expect(body(r, '下一步建议')).toContain('今天实际收紧为 1 张');
  });

  it('考试当天与考试已过：说法与既有面板一致，不再按天数摊分', () => {
    const today = buildStudyReport(input({ plan: { examDate: '2026-01-15', examLabel: '', dailyCap: 0 } }));
    expect(today.data.daysUntilExam).toBe(0);
    expect(today.highlights).toContain('考试就是今天');

    const past = buildStudyReport(input({ plan: { examDate: '2026-01-10', examLabel: '', dailyCap: 0 } }));
    expect(past.data.daysUntilExam).toBe(-5);
    expect(past.highlights).toContain('考试已过 5 天');
    expect(body(past, '下一步建议')).not.toContain('平摊');
  });

  it('时间范围只作用于带时间戳的记录；题目练习永远是累计值', () => {
    const bank = bankOf('甲库', [qOf('q1', { chapter: '甲章' })]);
    const cards = [cardOf('甲'), cardOf('乙')];
    const schedules = {
      甲: cardState(0, { last_review: new Date(NOW - 2 * DAY) }), // 范围内
      乙: cardState(0, { last_review: new Date(NOW - 40 * DAY) }), // 范围外
    };
    const mistakes = {
      '甲.md': { path: '甲.md', chapter: '甲章', title: '甲笔记', count: 1, lastFailedAt: NOW - DAY },
      '乙.md': { path: '乙.md', chapter: '乙章', title: '乙笔记', count: 1, lastFailedAt: NOW - 40 * DAY },
    };
    const r = buildStudyReport(input({
      banks: [bank],
      stats: { 甲库: { q1: stat(1, { lastReview: NOW }) } },
      cards,
      schedules,
      mistakes,
      range: { from: NOW - 7 * DAY, to: NOW },
    }));

    expect(r.data.range).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(r.data.cards.reviewedInRange).toBe(1);
    expect(r.data.mistakes.failedInRange).toBe(1);
    // 累计口径不受范围影响
    expect(r.data.cards.learned).toBe(2);
    expect(r.data.quiz.seen).toBe(1);
    expect(body(r, '题目练习')).toContain('本节是**累计口径**');
    expect(body(r, '口径说明')).toContain('只作用于带时间戳的记录');
    expect(body(r, '概览')).not.toContain('（按累计口径）');
  });

  it('不传时间范围时，范围类字段一律为 null 且显示「—」', () => {
    const r = buildStudyReport(input({ cards: [cardOf('甲')], schedules: { 甲: cardState(0) } }));
    expect(r.data.range).toBeNull();
    expect(r.data.cards.reviewedInRange).toBeNull();
    expect(body(r, '概览')).toContain(`时间范围：${EMPTY}（按累计口径）`);
    expect(body(r, '复习卡')).not.toContain('时间范围内复习过的卡');
  });

  it('把握度校准：没有样本时明说没有；有样本时沿用 3 个百分点的死区', () => {
    const empty = buildStudyReport(input({
      calibration: { n: 0, correct: 0, buckets: [], overconfidence: 0 },
    }));
    expect(body(empty, '复习卡')).toContain('把握度校准：还没有样本');

    // 平均自信 0.8、实际答对 0.6 → 高估 20.0 个百分点
    const over = buildStudyReport(input({
      calibration: { n: 10, correct: 6, buckets: [], overconfidence: 0.2 },
    }));
    expect(over.data.calibration).toEqual({ n: 10, accuracy: 0.6, meanConfidence: 0.8 });
    expect(body(over, '复习卡')).toContain('平均自信 80.0%、实际答对 60.0% —— 高估 20.0 个百分点');

    // 差 2 个百分点 → 落在死区内
    const flat = buildStudyReport(input({
      calibration: { n: 10, correct: 6, buckets: [], overconfidence: 0.02 },
    }));
    expect(body(flat, '复习卡')).toContain('校准得不错');
  });

  it('所有百分比都只保留 1 位小数（格式统一）', () => {
    const r = buildStudyReport(input({
      banks: [bankOf('甲库', [qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' }), qOf('q3', { chapter: '甲章' })])],
      stats: { 甲库: { q1: stat(1), q2: stat(1), q3: stat(1) } },
      cards: [cardOf('甲')],
      schedules: { 甲: cardState(0, { due: new Date(NOW - DAY) }) },
    }));
    const pcts = r.markdown.match(/[\d.]+%/g) ?? [];
    expect(pcts.length).toBeGreaterThan(0);
    for (const p of pcts) expect(p).toMatch(/^\d+\.\d%$/);
  });

  it('纯函数：同一份输入两次调用输出逐字相同', () => {
    const args = input({
      banks: [bankOf('甲库', [qOf('q1', { chapters: ['甲章', '乙章'] })])],
      stats: { 甲库: { q1: stat(2) } },
      cards: [cardOf('甲')],
      schedules: { 甲: cardState(0) },
    });
    expect(buildStudyReport(args).markdown).toBe(buildStudyReport(args).markdown);
  });
});

describe('studyReport · 格式化', () => {
  it('fmtPct：空值给「—」，比例保留 1 位小数', () => {
    expect(fmtPct(null)).toBe(EMPTY);
    expect(fmtPct(undefined)).toBe(EMPTY);
    expect(fmtPct(Number.NaN)).toBe(EMPTY);
    expect(fmtPct(0)).toBe('0.0%');
    expect(fmtPct(1)).toBe('100.0%');
    expect(fmtPct(1 / 3)).toBe('33.3%');
    expect(fmtPct(2 / 3)).toBe('66.7%');
  });

  it('fmtCount：空值给「—」，0 是真实值照实写', () => {
    expect(fmtCount(null)).toBe(EMPTY);
    expect(fmtCount(undefined)).toBe(EMPTY);
    expect(fmtCount(Number.NaN)).toBe(EMPTY);
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(12)).toBe('12');
  });

  it('fmtDay / fmtDateTime：0 与非法值给「—」，其余按本地时间格式化', () => {
    expect(fmtDay(0)).toBe(EMPTY);
    expect(fmtDay(null)).toBe(EMPTY);
    expect(fmtDay(undefined)).toBe(EMPTY);
    expect(fmtDay(Number.NaN)).toBe(EMPTY);
    expect(fmtDay(new Date(2026, 0, 15, 23, 30).getTime())).toBe('2026-01-15');

    expect(fmtDateTime(0)).toBe(EMPTY);
    expect(fmtDateTime(Number.NaN)).toBe(EMPTY);
    expect(fmtDateTime(new Date(2026, 0, 5, 9, 5).getTime())).toBe('2026-01-05 09:05');
  });
});

describe('studyReport · rangeOfPreset（时间范围档位的边界）', () => {
  it('「全部」返回 undefined：报告与加时间范围之前逐字一致（默认档的硬要求）', () => {
    const args = input({
      banks: [bankOf('甲库', [
        qOf('q1', { chapter: '甲章' }), qOf('q2', { chapter: '甲章' }), qOf('q3', { chapter: '甲章' }),
      ])],
      stats: { 甲库: { q1: stat(1), q2: stat(1), q3: stat(0) } },
      cards: [cardOf('甲'), cardOf('乙')],
      schedules: { 甲: cardState(0), 乙: cardState(0, { last_review: new Date(NOW - 40 * DAY) }) },
      mistakes: { '甲.md': { path: '甲.md', chapter: '甲章', title: '甲笔记', count: 2, lastFailedAt: NOW - DAY } },
    });

    expect(rangeOfPreset('all', NOW)).toBeUndefined();
    // range 为 undefined 与「根本不传 range」等价（buildStudyReport 只判 input.range !== undefined）
    const plain = buildStudyReport(args);
    const all = buildStudyReport({ ...args, range: rangeOfPreset('all', NOW) });
    expect(all.markdown).toBe(plain.markdown);
    expect(all.highlights).toEqual(plain.highlights);
    expect(all.data.range).toBeNull();
    expect(all.data.cards.reviewedInRange).toBeNull();
    expect(all.data.mistakes.failedInRange).toBeNull();
    expect(body(all, '概览')).toContain(`时间范围：${EMPTY}（按累计口径）`);
  });

  it('近 7 天 / 近 30 天：from 是含当天的本地日历日 00:00，to 取「现在」', () => {
    // NOW = 2026-01-15 09:00（本地）→ 近 7 天 = 今天 + 前 6 天 = 01-09 00:00 起
    expect(rangeOfPreset('7d', NOW)).toEqual({ from: new Date(2026, 0, 9).getTime(), to: NOW });
    // 近 30 天 = 今天 + 前 29 天 = 2025-12-17 00:00 起
    expect(rangeOfPreset('30d', NOW)).toEqual({ from: new Date(2025, 11, 17).getTime(), to: NOW });
    // Date 与毫秒两种入参等价（与 buildStudyReport 的 now 同一套写法）
    expect(rangeOfPreset('7d', new Date(NOW))).toEqual(rangeOfPreset('7d', NOW));
  });

  it('跨月 / 跨年按本地日历日回推，不用 86400000 整除', () => {
    // 2026-03-01 → 近 7 天从 2026-02-23 起（2026 年 2 月只有 28 天）
    expect(rangeOfPreset('7d', new Date(2026, 2, 1, 8, 0).getTime())!.from).toBe(new Date(2026, 1, 23).getTime());
    // 2026-01-01 → 近 30 天跨回上一年 2025-12-03
    expect(rangeOfPreset('30d', new Date(2026, 0, 1, 8, 0).getTime())!.from).toBe(new Date(2025, 11, 3).getTime());
  });

  it('now 非法时退回累计口径：绝不给出 NaN 窗口（NaN 比较恒为 false，会把范围内计数静默算成 0）', () => {
    expect(rangeOfPreset('7d', Number.NaN)).toBeUndefined();
    expect(rangeOfPreset('30d', new Date(Number.NaN))).toBeUndefined();

    const r = buildStudyReport(input({
      cards: [cardOf('甲')],
      schedules: { 甲: cardState(0) },
      range: rangeOfPreset('7d', Number.NaN),
    }));
    expect(r.data.range).toBeNull();
    expect(r.data.cards.reviewedInRange).toBeNull();
    expect(r.markdown).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('范围只切带时间戳的统计：累计值不变，落在边界上的记录算「范围内」', () => {
    const from = new Date(2026, 0, 9).getTime(); // 近 7 天的 from（含）
    const cards = [cardOf('甲'), cardOf('乙'), cardOf('丙')];
    const schedules = {
      甲: cardState(0, { last_review: new Date(from) }), // 边界当天 00:00 整 → 含
      乙: cardState(0, { last_review: new Date(from - 1) }), // 边界前 1 毫秒 → 不含
      丙: cardState(0, { last_review: undefined }), // 从未复习过 → 不计入范围内
    };
    const mistakes = {
      '甲.md': { path: '甲.md', chapter: '甲章', title: '甲笔记', count: 1, lastFailedAt: NOW },
      '乙.md': { path: '乙.md', chapter: '乙章', title: '乙笔记', count: 1, lastFailedAt: from - 1 },
      // 未来时间戳（时钟偏差 / 手改过记录）：to 取「现在」，所以它落在范围外，
      // 也不会让范围内计数变成负数（下面的 1 已经把这三条都夹住了）
      '丙.md': { path: '丙.md', chapter: '丙章', title: '丙笔记', count: 1, lastFailedAt: NOW + DAY },
    };
    const args = input({ cards, schedules, mistakes });
    const ranged = buildStudyReport({ ...args, range: rangeOfPreset('7d', NOW) });
    const base = buildStudyReport(args);

    expect(ranged.data.cards.reviewedInRange).toBe(1);
    expect(ranged.data.mistakes.failedInRange).toBe(1);
    // 累计口径的数字一个都不能被范围改动
    expect(ranged.data.cards).toMatchObject({
      total: base.data.cards.total,
      learned: base.data.cards.learned,
      dueNow: base.data.cards.dueNow,
      mastered: base.data.cards.mastered,
      newCards: base.data.cards.newCards,
    });
    expect(ranged.data.mistakes.total).toBe(base.data.mistakes.total);
    expect(ranged.data.mistakes.fails).toBe(base.data.mistakes.fails);
    // 范围内计数只可能是 0..总数：范围再窄也不会算成负数或 NaN
    expect(ranged.data.cards.reviewedInRange!).toBeGreaterThanOrEqual(0);
    expect(ranged.data.cards.reviewedInRange!).toBeLessThanOrEqual(base.data.cards.total);
    expect(ranged.markdown).not.toMatch(/NaN|undefined|Infinity/);
    expect(body(ranged, '复习卡')).toContain('时间范围内复习过的卡：1 张');
    expect(body(ranged, '错题分布')).toContain('时间范围内失败过的错题：1 处');
  });
});
