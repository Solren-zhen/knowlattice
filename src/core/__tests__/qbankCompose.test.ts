// @vitest-environment node
/**
 * 自动组题：规则过滤 + 加权随机。
 *
 * 加权随机是**概率**行为，最容易写出「跑一次看着对」的假测试。所以这里：
 *   · 用注入的固定 `rnd` 把随机性去掉，断言权重序（可复现）；
 *   · 另用真随机跑几百轮，断言「错题被抽中的频率显著更高」——这是行为断言，
 *     不是实现断言，换算法也能过。
 */
import { describe, expect, it } from 'vitest';
import type { QuizBank, QuizQuestion } from '../qbank';
import {
  DEFAULT_RULES, chapterCompare, chapterCounts, composeQuestions,
  filterPool, sortByChapter, weightOf, type ComposeRules,
} from '../qbankCompose';
import type { QStat, StatsMap } from '../qbankStats';

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);
const DAY = 86_400_000;
const BANK = '绿皮书·生理学';

function q(id: string, chapter: string, type: 'choice' | 'recall' = 'choice'): QuizQuestion {
  return { id, type, stem: `题干 ${id}`, options: type === 'choice' ? ['A', 'B'] : [], answer: 0, answerText: 'A', chapter };
}

const bank: QuizBank = {
  name: BANK,
  importedAt: 0,
  questions: [
    q('a', '生理学·第6章 消化和吸收'),
    q('b', '生理学·第6章 消化和吸收'),
    q('c', '生理学·第10章 神经系统的功能'),
    q('d', '生理学·第2章 细胞的基本功能', 'recall'),
  ],
};

/** 造一条逐题记录 */
function stat(over: Partial<QStat> = {}): QStat {
  return {
    due: NOW - 5 * DAY, stability: 1, difficulty: 5, elapsed: 0, scheduled: 1,
    steps: 0, reps: 1, lapses: 0, state: 2, lastReview: NOW - 5 * DAY, wrong: 0, ...over,
  };
}

const statsWith = (per: Record<string, QStat>): StatsMap => ({ [BANK]: per });
const rules = (over: Partial<ComposeRules> = {}): ComposeRules => ({ ...DEFAULT_RULES, ...over });

describe('qbankCompose · 权重', () => {
  it('没做过 = 1：既不被压也不被过度抬高', () => {
    expect(weightOf(undefined, NOW)).toBe(1);
  });

  it('错得越多权重越高', () => {
    const once = weightOf(stat({ wrong: 1 }), NOW);
    const thrice = weightOf(stat({ wrong: 3 }), NOW);
    expect(once).toBeGreaterThan(weightOf(stat({ wrong: 0 }), NOW));
    expect(thrice).toBeGreaterThan(once);
  });

  it('到期抬权、未到期压权，但都不清零', () => {
    const overdue = weightOf(stat({ due: NOW - 10 * DAY, lastReview: NOW - 10 * DAY }), NOW);
    const fresh = weightOf(stat({ due: NOW + 10 * DAY, lastReview: NOW }), NOW);
    expect(overdue).toBeGreaterThan(fresh);
    expect(fresh).toBeGreaterThan(0);
  });

  it('逾期越久权重越高，但 30 天封顶（不会让一道陈年错题吃掉整轮）', () => {
    const d30 = weightOf(stat({ due: NOW - 30 * DAY, lastReview: NOW - 30 * DAY }), NOW);
    const d300 = weightOf(stat({ due: NOW - 300 * DAY, lastReview: NOW - 300 * DAY }), NOW);
    expect(d300).toBe(d30);
  });

  it('有地板：权重再低也不会变成 0（否则那题永远抽不到）', () => {
    const w = weightOf(stat({ wrong: 0, due: NOW + 999 * DAY, lastReview: NOW }), NOW);
    expect(w).toBeGreaterThanOrEqual(0.02);
  });
});

describe('qbankCompose · 过滤', () => {
  it('scope=all 全要；new 只要没做过的', () => {
    const stats = statsWith({ a: stat() });
    expect(filterPool(bank.questions, rules(), stats, BANK, NOW).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterPool(bank.questions, rules({ scope: 'new' }), stats, BANK, NOW).map((x) => x.id)).toEqual(['b', 'c', 'd']);
  });

  it('scope=wrong 只要错过的；scope=due 只要到期了的', () => {
    const stats = statsWith({
      a: stat({ wrong: 2, due: NOW + 5 * DAY }),   // 错过但还没到期
      b: stat({ wrong: 0, due: NOW - DAY }),       // 没记过错但已到期
    });
    expect(filterPool(bank.questions, rules({ scope: 'wrong' }), stats, BANK, NOW).map((x) => x.id)).toEqual(['a']);
    expect(filterPool(bank.questions, rules({ scope: 'due' }), stats, BANK, NOW).map((x) => x.id)).toEqual(['b']);
  });

  it('章节与题型是多选，两个条件是与关系', () => {
    const only6 = filterPool(bank.questions, rules({ chapters: ['生理学·第6章 消化和吸收'] }), {}, BANK, NOW);
    expect(only6.map((x) => x.id)).toEqual(['a', 'b']);

    const recall = filterPool(bank.questions, rules({ types: ['recall'] }), {}, BANK, NOW);
    expect(recall.map((x) => x.id)).toEqual(['d']);

    const both = filterPool(
      bank.questions,
      rules({ chapters: ['生理学·第6章 消化和吸收'], types: ['recall'] }),
      {}, BANK, NOW,
    );
    expect(both).toEqual([]);
  });

  it('空章节数组 = 全部章节（不是"一章都不要"）', () => {
    expect(filterPool(bank.questions, rules({ chapters: [] }), {}, BANK, NOW)).toHaveLength(4);
  });
});

describe('qbankCompose · 抽样', () => {
  it('注入固定 rnd 时按权重降序取（可复现，不靠概率）', () => {
    const stats = statsWith({
      a: stat({ wrong: 5 }),
      b: stat({ wrong: 1 }),
      c: stat({ wrong: 0 }),
      // d 没做过 → 权重 1
    });
    // rnd 恒为 0.5 时 key = 0.5^(1/w) 随 w 单调递增 → 顺序就是权重序
    const picked = composeQuestions(bank, rules({ count: 4 }), stats, NOW, () => 0.5);
    // d 从没做过 → 权重 1；c 虽已到期（×1.5）但刚做过 5 天（×0.58）→ 0.875，反而低于 d。
    // 这正是设计意图：没做过的新题不该被老题挤掉。
    expect(picked.map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('题量被尊重；题库不够时给多少算多少，不报错', () => {
    expect(composeQuestions(bank, rules({ count: 2 }), {}, NOW)).toHaveLength(2);
    expect(composeQuestions(bank, rules({ count: 99 }), {}, NOW)).toHaveLength(4);
    expect(composeQuestions(bank, rules({ count: 0 }), {}, NOW)).toHaveLength(4);
  });

  it('结果里没有重复题', () => {
    const picked = composeQuestions(bank, rules({ count: 4 }), {}, NOW);
    expect(new Set(picked.map((x) => x.id)).size).toBe(4);
  });

  it('order=chapter 时按章节自然序（第6章 在 第10章 前面）', () => {
    const picked = composeQuestions(bank, rules({ count: 4, order: 'chapter' }), {}, NOW);
    expect(picked.map((x) => x.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('错题被抽中的频率显著更高（行为断言，换算法也能过）', () => {
    const stats = statsWith({
      a: stat({ wrong: 4, due: NOW - 10 * DAY, lastReview: NOW - 10 * DAY }),
    });
    let hit = 0;
    const rounds = 400;
    for (let i = 0; i < rounds; i++) {
      if (composeQuestions(bank, rules({ count: 1 }), stats, NOW)[0].id === 'a') hit++;
    }
    // 理论命中率约 w_a/(w_a+3) ≈ 0.85；400 次里低于 250 次说明加权没生效
    expect(hit).toBeGreaterThan(250);
  });
});

describe('qbankCompose · 章节自然序', () => {
  it('数字按数值比，不按字符比', () => {
    expect(chapterCompare('生理学·第6章 消化', '生理学·第10章 神经')).toBeLessThan(0);
    expect(chapterCompare('第2章', '第2章')).toBe(0);
    expect(chapterCompare('第10章', '第9章')).toBeGreaterThan(0);
  });

  it('前缀不同时按前缀比；短的一方在前', () => {
    expect(chapterCompare('内科学·第1章', '生理学·第1章')).toBeLessThan(0);
    expect(chapterCompare('生理学', '生理学·第1章')).toBeLessThan(0);
  });

  it('chapterCounts 给出每章题数且已排序', () => {
    expect(chapterCounts(bank.questions)).toEqual([
      { chapter: '生理学·第2章 细胞的基本功能', count: 1 },
      { chapter: '生理学·第6章 消化和吸收', count: 2 },
      { chapter: '生理学·第10章 神经系统的功能', count: 1 },
    ]);
  });

  it('sortByChapter 不改动入参', () => {
    const input = [...bank.questions];
    sortByChapter(input);
    expect(input.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
