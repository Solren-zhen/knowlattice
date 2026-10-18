/**
 * 成就系统的统计来源（把散在各处的真实数据汇总成 LearningStats）
 *
 * 为什么单独一个模块：`achievementSystem.ts` 只定义「什么条件解锁什么成就」，
 * 它需要一份 `LearningStats`。这些数字散在四个存储里（打卡 / SRS / 逐题记录 / 番茄钟），
 * 汇总口径必须集中写在一处，否则每个调用点都会各算一遍、各差一点。
 *
 * ## 每个字段的来源与口径（逐个实测过，不是照接口名推的）
 *
 * | 字段 | 来源 | 口径 |
 * |---|---|---|
 * | streakDays | `core/stats.streak()` | 连续打卡天数（今天没学则从昨天起算） |
 * | totalDays | `core/stats.studyDays().length` | 有学习记录的天数 |
 * | totalNotes | 传入的笔记路径 | `.md` 篇数 |
 * | totalCards | `srsStats(buildCards(...)).total` | 卡片总数（一篇笔记按小节切多张） |
 * | masteredCards | `core/srs.loadCards()` | `state === 2` 的卡片数（ts-fsrs 的「复习态」） |
 * | perfectCards | 同上 | `reps === 1 && state === 2`：第一次复习就进入复习态 |
 * | reviewCount | 同上 | 所有卡片 `reps` 之和 = 累计复习次数 |
 * | totalQuizzes | `core/qbankStats.loadStats()` | 有逐题记录的**不同题目数**（与 `chapterMastery` 的 `seen` 同口径）。
 * |              |          | 用「不同题目」而不是「答题次数」：反复答同一道题不该算 100 道 |
 * | quizAccuracy | 同上 | `(做过 - 错过的) / 做过`，**按题目统计**而不是按章节 ——
 * |              |          | 一道题可能同时属于多章，按章节会把同一道题重复计数 |
 * | maxDailyMinutes | `core/pomodoro.loadRecords()` | 按天汇总番茄钟分钟数后取最大值。口径是**计划时长**
 * |                 |          | 而非墙钟时间（见 pomodoro.ts 顶部注释，暂停不计入）；数值本身精确 |
 *
 * ## 为什么 `perfectCards` 用「首次评 easy」这个口径
 *
 * 实测 ts-fsrs 的毕业行为（`applyReview`，默认参数）：
 *   首次 **again / hard / good** → `state = 1`（Learning），`reps = 1`
 *   首次 **easy**               → `state = 2`（Review）， `reps = 1`
 * 所以 `reps === 1 && state === 2` 精确等价于「第一次复习就评了『容易』」，
 * 也就是「一次通过」。旧定义写的是「评分 5」—— 本应用的评分档位是 1–4，根本没有 5 分。
 *
 * ## 历史：曾有 4 个成就永远解不开
 *
 * 原先的「记忆精准」（复习正确率 ≥90%）、「完美主义者」（一次通过且评分 5）、
 * 「知错能改」（改正 50 个错题）、「周末战士」都没有数据源：
 * - 复习的每次评分**没有落盘**（`core/srs.ts` 只存调度状态，不存评分流水），
 *   所以算不出复习正确率；`lapses` 也不行 —— 它只在 Review 态评 Again 时才 +1；
 * - 「评分 5」在本应用 1–4 的刻度里不存在；
 * - 错题重练答对时 `wrong` 被**减到 0**，痕迹被抹掉，无法区分「从没错过」和「错过又改好」；
 * - 「周末战士」在 `evaluateAchievement` 里是写死的 `unlocked: false`。
 * 这 4 个已改成用现有数据可测的口径（见 achievementSystem 的成就定义），
 * 所以本模块不再需要「无数据源」的标记。
 */

import type { LearningStats } from './achievementSystem';
import { streak, studyDays } from './stats';
import { loadCards, srsStats } from './srs';
import { buildCards } from './srsCards';
import { initializeStats, loadStats } from './qbankStats';
import { loadRecords } from './pomodoro';

export interface StatsInput {
  /** 笔记路径（`.md` 才计入） */
  paths: string[];
  /** 路径 → 笔记正文（切卡片要用） */
  docs: Map<string, string>;
}

/** ts-fsrs 的 State.Review：卡片已从学习队列毕业，进入长期复习 */
const SRS_STATE_REVIEW = 2;

/**
 * 汇总一份成就系统用的学习统计。
 *
 * **异步的原因**：逐题记录（QStat）存在 IndexedDB，`loadStats()` 返回的是模块级缓存，
 * 只有 `initializeStats()` 跑完之后才有内容。同步调用会静默拿到空表 ——
 * 于是「做题数」永远是 0，而界面看不出哪里错了。所以这里必须 await 它。
 *
 * 代价：学习统计面板打开时 `initializeStats()` 会跑两次（面板自己那处 + 这里）。
 * 它没有提前返回，所以是两次真实读取。表很小、面板本来就是每次打开都读一次，
 * 这点重复换来的是「成就模块自包含、任何地方都能调」。
 */
export async function collectLearningStats({ paths, docs }: StatsInput): Promise<LearningStats> {
  const mdPaths = paths.filter((p) => p.endsWith('.md'));

  // 先把逐题记录的缓存填好，再同步取用（其余来源本身就是同步的 localStorage）
  await initializeStats();

  // ---- 复习（SRS 卡片）----
  const cards = loadCards();
  let reviewCount = 0;
  let masteredCards = 0;
  let perfectCards = 0;
  for (const card of Object.values(cards)) {
    const reps = card.reps ?? 0;
    reviewCount += reps;
    if (card.state === SRS_STATE_REVIEW) {
      masteredCards++;
      // 只复习过一次就进入复习态 = 首次评了「容易」
      if (reps === 1) perfectCards++;
    }
  }

  // ---- 答题（逐题记录）----
  const stats = loadStats();
  let attempted = 0;
  let wrongQuestions = 0;
  for (const bank of Object.values(stats)) {
    for (const stat of Object.values(bank)) {
      attempted++;
      if (stat.wrong > 0) wrongQuestions++;
    }
  }
  const quizAccuracy = attempted > 0 ? (attempted - wrongQuestions) / attempted : 0;

  // ---- 专注（番茄钟）----
  const byDay = new Map<string, number>();
  for (const r of loadRecords()) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.minutes);
  }
  const maxDailyMinutes = byDay.size > 0 ? Math.max(...byDay.values()) : 0;

  return {
    streakDays: streak(),
    totalDays: studyDays().length,
    totalNotes: mdPaths.length,
    totalCards: srsStats(buildCards(mdPaths, docs)).total,
    masteredCards,
    perfectCards,
    reviewCount,
    totalQuizzes: attempted,
    quizAccuracy,
    maxDailyMinutes,
  };
}
