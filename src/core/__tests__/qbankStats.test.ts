// @vitest-environment node
/**
 * 逐题历史 + FSRS 排程。
 *
 * 这里有一条**存储体积**的回归断言：整个模块存在的理由是「紧凑编码能把
 * 两万道答过的题装进 localStorage」，编码一旦退回完整对象就会爆 5 MB 上限，
 * 而那种失败在开发机上永远看不到（配额只在真实用户的浏览器里撞）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bankProgress, consumeSaveFailure, dropBankStats, isDue, loadStats,
  recordAnswer, statOf,
} from '../qbankStats';

const KEY = 'knowlattice-qstats';
const BANK = '绿皮书·生理学';
const DAY = 86_400_000;
/** 固定"现在"，避免用真实时钟让断言随运行时间漂移 */
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

beforeEach(() => {
  localStorage.clear();
});

describe('qbankStats · 记录与排程', () => {
  it('答对：写进表里、reps 增加、下次到期时间被推到未来', () => {
    const rec = recordAnswer(BANK, 'q-1', true, NOW);
    expect(rec.reps).toBe(1);
    expect(rec.wrong).toBe(0);
    expect(rec.lastReview).toBe(NOW);
    expect(rec.due).toBeGreaterThan(NOW);

    const back = statOf(loadStats(), BANK, 'q-1');
    expect(back).toEqual(rec);
    expect(isDue(back!, NOW)).toBe(false);
  });

  it('答错：wrong 累加，且排期明显早于答对的题', () => {
    const rec = recordAnswer(BANK, 'q-1', false, NOW);
    expect(rec.wrong).toBe(1);
    // 新卡答错不进 Relearning（lapses 统计的是「已毕业的卡再次遗忘」），所以不断言 lapses
    expect(rec.state).not.toBe(0); // 但必须已经离开 New

    const again = recordAnswer(BANK, 'q-1', false, NOW + 1000);
    expect(again.wrong).toBe(2);
    // 错两次的到期时间必须早于「一路答对」的题——否则错题加权就白算了
    const good = recordAnswer(BANK, 'q-2', true, NOW);
    expect(again.due).toBeLessThan(good.due);
  });

  it('连续答对会把到期时间越推越远（FSRS 在真的推进，不是每次都重排）', () => {
    let t = NOW;
    let prev = recordAnswer(BANK, 'q-1', true, t);
    for (let i = 0; i < 4; i++) {
      t = prev.due;
      const next = recordAnswer(BANK, 'q-1', true, t);
      expect(next.due).toBeGreaterThan(prev.due);
      prev = next;
    }
  });

  it('题目之间互不干扰；不同题库的同名 id 互不干扰', () => {
    recordAnswer(BANK, 'q-1', false, NOW);
    recordAnswer('医考帮·生理学', 'q-1', true, NOW);
    expect(statOf(loadStats(), BANK, 'q-1')!.wrong).toBe(1);
    expect(statOf(loadStats(), '医考帮·生理学', 'q-1')!.wrong).toBe(0);
    expect(statOf(loadStats(), BANK, 'q-2')).toBeUndefined();
  });

  it('损坏的数据当作没做过，而不是让整张表读不出来', () => {
    localStorage.setItem(KEY, JSON.stringify({
      [BANK]: {
        good: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1],
        short: [1, 2],
        notArray: { a: 1 },
        hasNaN: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'x'],
      },
      notAnObject: 42,
    }));
    const stats = loadStats();
    expect(statOf(stats, BANK, 'good')).toBeDefined();
    expect(statOf(stats, BANK, 'short')).toBeUndefined();
    expect(statOf(stats, BANK, 'notArray')).toBeUndefined();
    expect(statOf(stats, BANK, 'hasNaN')).toBeUndefined();
    expect(stats.notAnObject).toBeUndefined();
  });

  it('整表是坏 JSON 时不抛，按空表处理', () => {
    localStorage.setItem(KEY, '{oops');
    expect(loadStats()).toEqual({});
    expect(() => recordAnswer(BANK, 'q-1', true, NOW)).not.toThrow();
  });

  it('没复习过的记录 lastReview 是 0（不会被当成 1970 年）', () => {
    // 直接造一条 lastReview 占位为 -1 的存储
    localStorage.setItem(KEY, JSON.stringify({ [BANK]: { x: [100, 1, 1, 0, 0, 0, 0, 0, 0, -1, 0] } }));
    expect(statOf(loadStats(), BANK, 'x')!.lastReview).toBe(0);
  });
});

describe('qbankStats · 落盘失败不静默', () => {
  it('配额爆掉时记录仍在内存里可用，并置一次失败标志', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(consumeSaveFailure()).toBe(false); // 先清干净
      const rec = recordAnswer(BANK, 'q-1', true, NOW);
      expect(rec.reps).toBe(1);
      // 本轮继续可用：内存里查得到，不能因为存不下就打断练习
      expect(statOf(loadStats(), BANK, 'q-1')!.reps).toBe(1);
      expect(consumeSaveFailure()).toBe(true);
      // 读一次就清，UI 不会反复弹提示
      expect(consumeSaveFailure()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('qbankStats · 题库级统计与清理', () => {
  it('bankProgress 数出做过/错过/待复习', () => {
    recordAnswer(BANK, 'q-1', false, NOW); // 错过，且 FSRS 会排到很近的将来
    recordAnswer(BANK, 'q-2', true, NOW);  // 对，排到未来
    const p = bankProgress(BANK, ['q-1', 'q-2', 'q-3'], NOW);
    expect(p.total).toBe(3);
    expect(p.seen).toBe(2);
    expect(p.wrong).toBe(1);
    // 答错的题按 FSRS 重排到近处：在「现在」这一刻仍未到期，但过一会儿就该复习
    expect(p.due).toBe(0);
    expect(bankProgress(BANK, ['q-1', 'q-2', 'q-3'], NOW + 2 * DAY).due).toBeGreaterThan(0);
  });

  it('dropBankStats 只清掉指定题库', () => {
    recordAnswer(BANK, 'q-1', true, NOW);
    recordAnswer('另一个库', 'q-1', true, NOW);
    dropBankStats(BANK);
    const stats = loadStats();
    expect(stats[BANK]).toBeUndefined();
    expect(statOf(stats, '另一个库', 'q-1')).toBeDefined();
  });
});

describe('qbankStats · 存储体积（设计前提的回归）', () => {
  it('紧凑编码把每题的存储压到对象形式的一半以下', () => {
    const N = 400;
    for (let i = 0; i < N; i++) recordAnswer(BANK, `q-m4x2k1-${i}`, i % 3 !== 0, NOW);
    const packed = localStorage.getItem(KEY)!;
    const perQuestion = packed.length / N;
    // 绝对上限：拦住「退回完整 ts-fsrs Card 对象」这类改动（对象形式约 181 字符/题）。
    expect(perQuestion).toBeLessThan(80);
    // 相对断言（自校准）：紧凑形式必须显著小于同一批数据的对象形式。
    // 实测约 55 : 181 ≈ 0.30；给到 0.5 仍能拦住「只加 toTuple 却忘了在 save 里调用」。
    const objects = JSON.stringify(loadStats());
    expect(packed.length).toBeLessThan(objects.length * 0.5);
  });
});
