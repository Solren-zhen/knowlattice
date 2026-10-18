import { beforeEach, describe, expect, it } from 'vitest';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { recordAnswer, resetQbankStatsForTests } from '../qbankStats';
import { collectLearningStats, UNSOURCED_ACHIEVEMENT_IDS } from '../achievementStats';

/**
 * 成就统计的来源汇总：每个字段都要能从对应的存储里读出来，口径与 achievementStats 顶部
 * 那张表一一对应。
 *
 * 逐题记录走**真实 API**（recordAnswer），不直接塞 IndexedDB —— 那样会绕开
 * wrong / lapses 的更新语义（普通练习答对不减 wrong，错题重练才减），
 * 测的就不是真实口径了。
 *
 * 隔离：localStorage 由内存垫片承载（clear 即可）；逐题记录在 IndexedDB 里，
 * 必须用 resetQbankStorageForTests 清 —— localStorage.clear() 清不掉它，
 * 会让上一个用例的数据漏进下一个（这一点踩过一次）。
 */

const DAYS_KEY = 'knowlattice-days';
const SRS_KEY = 'knowlattice-srs';
const POMO_KEY = 'knowlattice-pomodoros';

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
});

/** 本地时区的日期键（与 core/stats 的 localDate 同口径） */
function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一张 ts-fsrs 卡：给 srs.loadCards() 会校验的字段，加上统计要用的 reps / lapses */
const card = (reps: number, lapses: number) => ({
  due: 0,
  stability: 1,
  difficulty: 3,
  state: 2,
  reps,
  lapses,
});

const seedDays = (m: Record<string, number>) => localStorage.setItem(DAYS_KEY, JSON.stringify(m));
const seedSrs = (m: Record<string, unknown>) => localStorage.setItem(SRS_KEY, JSON.stringify(m));
const seedPomo = (list: unknown[]) => localStorage.setItem(POMO_KEY, JSON.stringify(list));
const pomo = (id: string, day: string, minutes: number) => ({
  id,
  day,
  endedAt: Date.parse(`${day}T10:00:00Z`),
  minutes,
});

const noDocs = new Map<string, string>();

describe('collectLearningStats', () => {
  it('全部为空时返回全零，不抛', async () => {
    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s).toEqual({
      streakDays: 0,
      totalDays: 0,
      totalNotes: 0,
      totalCards: 0,
      reviewCount: 0,
      totalQuizzes: 0,
      quizAccuracy: 0,
      maxDailyMinutes: 0,
      reviewAccuracy: 0,
      perfectCards: 0,
      mistakesCorrected: 0,
    });
  });

  it('打卡：连续天数取连续段，总天数取有记录的天数', async () => {
    // 今天 + 昨天有记录 → 连续 2 天；再往前隔一天 → 不连；更早还有一天 → 总天数 3
    seedDays({ [localDay(0)]: 2, [localDay(-1)]: 1, [localDay(-3)]: 5 });
    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.streakDays).toBe(2);
    expect(s.totalDays).toBe(3);
  });

  it('笔记：只计 .md，卡片数按小节切', async () => {
    const docs = new Map<string, string>([
      ['notes/心衰.md', '# 定义\n\n心力衰竭的定义。'],
      ['notes/图片.png', 'x'], // 非 .md，不计
    ]);
    const s = await collectLearningStats({ paths: [...docs.keys()], docs });
    expect(s.totalNotes).toBe(1);
    expect(s.totalCards).toBeGreaterThan(0);
  });

  it('复习：次数取所有卡片的 reps 之和', async () => {
    seedSrs({ a: card(3, 1), b: card(1, 0), c: card(1, 1), d: card(5, 0) });
    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.reviewCount).toBe(10); // 3+1+1+5
  });

  it('答题：做题数按「不同题目」计，正确率按题目而非章节', async () => {
    await recordAnswer('内科', 'q1', true);
    await recordAnswer('内科', 'q2', false);
    await recordAnswer('内科', 'q2', false); // 同一道题答两次，仍只算一道
    await recordAnswer('外科', 'q3', true);

    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.totalQuizzes).toBe(3); // q1 / q2 / q3
    expect(s.quizAccuracy).toBeCloseTo(2 / 3, 6); // 只有 q2 错过
  });

  it('答题正确率把「错题重练改好的」算回正确：与应用的错题语义一致', async () => {
    await recordAnswer('内科', 'q1', false); // wrong=1
    await recordAnswer('内科', 'q1', true, Date.now(), true); // 重练答对 → wrong=0

    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.totalQuizzes).toBe(1);
    expect(s.quizAccuracy).toBe(1); // wrong 已归零 → 这一题不再算「错过」
  });

  it('专注：单日最长时长取按天汇总后的最大值', async () => {
    seedPomo([
      pomo('p1', localDay(0), 25),
      pomo('p2', localDay(0), 25),
      pomo('p3', localDay(-1), 60),
    ]);
    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.maxDailyMinutes).toBe(60); // 昨天 60 > 今天 50
  });

  it('三个没有数据源的字段恒为 0，且被列进 UNSOURCED_ACHIEVEMENT_IDS', async () => {
    // 即便把存储塞满，这三个字段也不该凭代理口径「猜」出数字来。
    // 详见 achievementStats 文件头：lapses 只在 Review 态评 Again 时才加，
    // wrong 被错题重练减到 0 后痕迹即消失，评分流水根本没有落盘。
    seedSrs({ a: card(3, 1), b: card(1, 0) });
    seedPomo([pomo('p1', localDay(0), 25)]);
    await recordAnswer('内科', 'q1', false);
    await recordAnswer('内科', 'q1', true, Date.now(), true); // 错题重练答对

    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.reviewAccuracy).toBe(0);
    expect(s.perfectCards).toBe(0);
    expect(s.mistakesCorrected).toBe(0);
    expect([...UNSOURCED_ACHIEVEMENT_IDS].sort()).toEqual([
      'mistakes-corrected-50',
      'perfect-cards-50',
      'review-accuracy-90',
    ]);
  });
});
