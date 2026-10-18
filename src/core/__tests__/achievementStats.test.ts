import { beforeEach, describe, expect, it } from 'vitest';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { recordAnswer, resetQbankStatsForTests } from '../qbankStats';
import { collectLearningStats } from '../achievementStats';

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

/** 一张 ts-fsrs 卡：给 srs.loadCards() 会校验的字段。state 默认 2 = 复习态 */
const card = (reps: number, state = 2) => ({
  due: 0,
  stability: 1,
  difficulty: 3,
  state,
  reps,
  lapses: 0,
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
      masteredCards: 0,
      perfectCards: 0,
      reviewCount: 0,
      totalQuizzes: 0,
      quizAccuracy: 0,
      maxDailyMinutes: 0,
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

  it('复习：次数取所有卡片的 reps 之和；掌握态与「首次 easy」分开计', async () => {
    seedSrs({
      a: card(3), // 复习 3 次，已在复习态 → 掌握，但不是「首次通过」
      b: card(1), // 只复习 1 次就进入复习态 → 掌握 + 完美
      c: card(1, 1), // 只复习 1 次但还停在 Learning → 都算不上
      d: card(5), // 复习 5 次，掌握
    });
    const s = await collectLearningStats({ paths: [], docs: noDocs });
    expect(s.reviewCount).toBe(10); // 3+1+1+5
    expect(s.masteredCards).toBe(3); // a / b / d
    expect(s.perfectCards).toBe(1); // 只有 b
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

  it('每个字段都有真实来源，21 个成就全部可评估', async () => {
    // 塞满四类存储，确认没有字段被写死成 0
    seedDays({ [localDay(0)]: 3, [localDay(-1)]: 2, [localDay(-2)]: 1 });
    seedSrs({ a: card(3), b: card(1), c: card(2, 1) });
    seedPomo([pomo('p1', localDay(0), 25), pomo('p2', localDay(-1), 60)]);
    await recordAnswer('内科', 'q1', true);
    await recordAnswer('内科', 'q2', false);

    const docs = new Map([['n.md', '# 标题\n\n正文']]);
    const s = await collectLearningStats({ paths: [...docs.keys()], docs });

    expect(s.streakDays).toBe(3);
    expect(s.totalDays).toBe(3);
    expect(s.totalNotes).toBe(1);
    expect(s.totalCards).toBeGreaterThan(0);
    expect(s.masteredCards).toBe(2); // a / b
    expect(s.perfectCards).toBe(1); // 只有 b
    expect(s.reviewCount).toBe(6); // 3+1+2
    expect(s.totalQuizzes).toBe(2);
    expect(s.quizAccuracy).toBe(0.5);
    expect(s.maxDailyMinutes).toBe(60);

    // 没有任何字段是「恒为 0 的占位」
    expect(Object.values(s).every((v) => typeof v === 'number')).toBe(true);
    expect(Object.values(s).filter((v) => v === 0)).toHaveLength(0);
  });
});
