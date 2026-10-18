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
 * | streakDays | `core/stats.streak()` | 连续打卡天数（今天没学则从昨天起算）—— **精确** |
 * | totalDays | `core/stats.studyDays().length` | 有学习记录的天数 —— **精确** |
 * | totalNotes | 传入的笔记路径 | `.md` 篇数 —— **精确** |
 * | totalCards | `srsStats(buildCards(...)).total` | 卡片总数（一篇笔记按小节切多张）—— **精确** |
 * | reviewCount | `core/srs.loadCards()` | 所有卡片 `reps` 之和 = 累计复习次数 —— **精确** |
 * | totalQuizzes | `core/qbankStats.loadStats()` | 有逐题记录的**不同题目数**（与 `chapterMastery` 的 `seen` 同口径）。
 * |              |          | 用「不同题目」而不是「答题次数」：反复答同一道题不该算 100 道 |
 * | quizAccuracy | 同上 | `(做过 - 错过的) / 做过`，**按题目统计**而不是按章节 ——
 * |              |          | 一道题可能同时属于多章，按章节会把同一道题重复计数 |
 * | maxDailyMinutes | `core/pomodoro.loadRecords()` | 按天汇总番茄钟分钟数后取最大值。口径是**计划时长**
 * |                 |          | 而非墙钟时间（见 pomodoro.ts 顶部注释，暂停不计入）—— 数值本身精确 |
 * | reviewAccuracy | — | **无数据源**，恒为 0。见下 |
 * | perfectCards | — | **无数据源**，恒为 0。见下 |
 * | mistakesCorrected | — | **无数据源**，恒为 0。见下 |
 *
 * ## 那三个字段为什么给 0（实测结论，别急着「补一个代理」）
 *
 * 一开始我打算用两个代理顶上，写完之后实测 ts-fsrs 的真实演进，两个都不成立：
 *
 * - **reviewAccuracy**：本想用 `1 - Σlapses / Σreps`。但实测 `lapses` **只在卡片处于
 *   Review 态（state=2）被评 Again 时才 +1**；学习态里的 Again 完全不记。一条
 *   「答错 → 普通练习答对 → 错题重练答对 → 再答错」的序列里，`lapses` 前三步一直是 0。
 *   拿它当分母算出的正确率会**系统性偏乐观**（50 次全评 Again 也可能显示 100%），
 *   而 `review-accuracy-90` 正是「≥90% 且至少 50 次」—— 偏乐观会让它轻易解锁。
 *   复习的每次评分没有落盘（`core/srs.ts` 只存调度状态，不存评分流水），所以没有别的源。
 * - **perfectCards**（成就原文「一次通过且评分 5」）：没有评分流水。而且这个应用的评分档位是
 *   ts-fsrs 的 **1–4**（Again/Hard/Good/Easy），**根本没有 5 分** —— 成就定义本身与应用的
 *   评分刻度对不上，不只是缺数据。
 * - **mistakesCorrected**：本想用 `lapses > 0 && wrong === 0`（曾经错过、现已消灭）。
 *   实测：错题重练答对时 `wrong` 被**减到 0**（见 `qbankStats.recordAnswer` 的 relearn 分支），
 *   而 `lapses` 仍是 0 —— **痕迹被抹掉了**，无法区分「从没错过」和「错过又改好了」。
 *   要记录它必须给 QStat 增加一个只增不减的计数器，而 QStat 是定长数组存储
 *   （`T` 字段表 + `LEN = 11`，改它要同时改 toTuple/fromTuple 并处理旧数据），
 *   那是存储格式变更，不是本次该顺手做的事。
 *
 * 所以这三个字段一律给 0，并在界面上**显式标注「未记录」**（见 `UNSOURCED_ACHIEVEMENT_IDS`），
 * 而不是画一根永远走不完的进度条。将来补上记录口径时，改这里 + 从那个集合里删掉即可。
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

/**
 * 依赖「没有数据源」的那三个字段的成就 id。
 *
 * 界面据此把它们标成「未记录」而不是给进度条 —— 否则用户会看到一根永远停在 0 的条，
 * 或者更糟：一个靠偏乐观口径轻易解锁的成就。将来补上口径时从这里删掉对应 id。
 */
export const UNSOURCED_ACHIEVEMENT_IDS: ReadonlySet<string> = new Set([
  'review-accuracy-90', // 复习正确率：没有评分流水
  'perfect-cards-50', // 完美卡片：没有评分流水，且「评分 5」在本应用不存在
  'mistakes-corrected-50', // 改正错题：wrong 减到 0 后痕迹被抹掉
]);

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

  // ---- 复习（SRS 卡片）：只有「复习过几次」是可得的 ----
  const cards = loadCards();
  let reviewCount = 0;
  for (const card of Object.values(cards)) {
    reviewCount += card.reps ?? 0;
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
    reviewCount,
    totalQuizzes: attempted,
    quizAccuracy,
    maxDailyMinutes,
    // 以下三个没有数据源，恒为 0；理由见文件头。界面会把它们标成「未记录」。
    reviewAccuracy: 0,
    perfectCards: 0,
    mistakesCorrected: 0,
  };
}
