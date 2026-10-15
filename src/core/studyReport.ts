/**
 * P3 · 学习报告：把「这段时间学得怎么样」汇成一份**能带走**的报告（结构化数据 + Markdown）。
 *
 * 为什么是纯函数：同一份报告要被三条路径复用 —— 界面面板、导出/整包备份、以及将来的图表。
 *   一旦这里自己读 localStorage / IndexedDB，测试就得再搭一套存储垫片，
 *   而且「导出别人备份里的学习报告」会拿到**当前浏览器**的数据（错得最隐蔽的一类）。
 *   所以数据一律由调用方传入（见 StudyReportInput），本模块只做聚合与表述，不产生任何副作用。
 *
 * 为什么强调复用既有聚合：正确率、薄弱章节、到期卡、错题分布的口径在 core/qbankStats.ts、
 *   core/srs.ts、core/reviewPlan.ts、core/mistakes.ts 里已经各自定死（热力图、统计面板、
 *   AI 学习摘要在用同一套）。报告若另立一套（例如改成按「作答次数」算正确率），
 *   就会出现「报告说 40%、热力图说 60%」这种互相矛盾的数据，用户只会两个都不信。
 *   因此下面每个数字都来自既有函数或既有字段，并在注释里注明出处。
 *
 * 关于「数据不足」：本项目最忌讳的失败形态是编造数字。凡样本不够的地方，
 *   本模块一律输出 `—`（见 fmtPct/fmtCount）并**明写**「样本不足，不下结论」；
 *   绝不把 seen=0 的章节写成 0% —— 那等于把「还没练」说成「掌握差」。
 *
 * 时间范围（range）的适用范围必须说清：逐题记录（QStat）只保留**累计答错次数**与
 *   **最近一次作答时间**，没有逐次作答日志，所以按范围去切「这段时间做了多少题」只能靠猜。
 *   本模块因此只让 range 作用于真正带时间戳的字段（复习卡的最近复习时间、错题的最近失败时间），
 *   并在报告里明说「题目练习一节是累计值」。
 */
import { State as FsrsState, type Card } from 'ts-fsrs';
import { isMultiSelect, type QuizBank } from './qbank';
import {
  MASTERY_MIN_SEEN, MASTERY_WEAK_ACCURACY, bankProgress, chapterMastery, statOf, type StatsMap,
} from './qbankStats';
import { scheduleOf } from './srs';
import type { ReviewCard } from './srsCards';
import { daysUntilExam, effectiveDailyCap, type ReviewPlan } from './reviewPlan';
import { MISTAKE_REASON_LABELS, chapterHeat, type MistakeMap, type MistakeReason } from './mistakes';
import type { CalibSummary } from './qbankCalib';

/**
 * 「重复错同一题」的阈值：≥2 次才算重复。
 * 复用错题本面板已有的档位（core/mistakes 的错题本用 1 / 2 / 3 / 5 次过滤，
 * 其中 ≥2 才叫「反复错」，1 次只是「错过」）。不新造档位。
 */
export const REPEAT_WRONG_MIN = 2;

/** 空值的统一写法：宁可写「—」也不让 NaN / undefined / 编造的 0% 出现在报告里 */
export const EMPTY = '—';

/** 时间范围（epoch 毫秒，含两端）。只作用于带时间戳的记录，语义见文件头注释。 */
export interface StudyReportRange {
  from?: number;
  to?: number;
}
/**
 * 报告时间范围的三个档位。「全部」= 不传 range 的累计口径，也就是加时间范围之前的行为，
 * 所以它是默认档。写成字面量联合类型是为了让面板与 Workspace 共用同一组取值，
 * 避免两边各写一份字符串（把 '7d' 写成 '7' 只会静默退化成累计口径，最难发现）。
 */
export type StudyReportRangePreset = 'all' | '7d' | '30d';

/**
 * 档位 → 具体的时间范围（**纯函数**：除入参 now 外不读时钟，边界因此能被测试钉死）。
 *
 * 语义（与 StudyReportRange 一致，只作用于带时间戳的字段）：
 *   - 'all' → undefined：**完全不传 range**，于是 buildStudyReport 走累计口径，
 *     输出与加时间范围之前逐字一致（这是本项目的硬要求）；
 *   - '7d' / '30d' → `{ from: 近 N 个本地日历日的 00:00（含当天）, to: 现在 }`。
 *     「近 N 天」= 今天 + 前 N-1 个日历日，所以用 Date(y, m, d-(N-1)) 按**本地日历**回推，
 *     而不是 now - N*86400000：后者在夏令时切换那天会多算/少算一小时，
 *     也可能把边界落到前一天。日历日口径与 core/reviewPlan.daysUntilExam 是同一套。
 *     to 取「现在」而不是「今天 23:59:59」：时间戳不可能晚于现在，
 *     取一个未来时刻只会让判断多包含一段不可能存在的时间，没有意义。
 *   - now 非法（NaN / 坏 Date）→ 返回 undefined：宁可退回累计口径，
 *     也不给出一个 NaN 窗口 —— NaN 参与比较恒为 false，会把「范围内复习过 3 张」静默算成 0，
 *     比抛错更难发现。
 */
export function rangeOfPreset(
  preset: StudyReportRangePreset,
  now: number | Date = Date.now(),
): StudyReportRange | undefined {
  if (preset === 'all') return undefined;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) return undefined;
  const days = preset === '7d' ? 7 : 30;
  const d = new Date(nowMs);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
  return { from, to: nowMs };
}

export interface StudyReportInput {
  /** 已导入的题库（题目内容，用来给出题干与多选题口径） */
  banks: QuizBank[];
  /** 逐题记录（core/qbankStats.StatsMap）：正确率与「重复错同一题」的唯一来源 */
  stats: StatsMap;
  /** 复习卡（core/srsCards.ReviewCard，由调用方 buildCards 得到） */
  cards: ReviewCard[];
  /** 复习调度（core/srs.loadCards() 的返回值）。传进来而不是内部读，见文件头注释 */
  schedules: Record<string, Card>;
  /** 复习计划（考试日期 / 名称 / 每日上限） */
  plan: ReviewPlan;
  /** 错题本（core/mistakes.MistakeMap） */
  mistakes: MistakeMap;
  /** 可选时间范围；不传 = 累计口径 */
  range?: StudyReportRange;
  /**
   * 可选：把握度校准汇总（core/qbankCalib.calibrationSummary() 的返回值）。
   * 该函数读 localStorage，为保持本模块纯粹，由调用方取值后传入；不传则报告不含校准一节。
   */
  calibration?: CalibSummary;
  /** 可选：错因分布（core/mistakes.reasonCounts() 的返回值），同上由调用方取值 */
  mistakeReasons?: Array<{ reason: MistakeReason; count: number; unlabeled: number }>;
  /** 「现在」：影响到期判断、距考试天数（按本地日历日）与生成时间。测试要能钉住它 */
  now?: number | Date;
  /** 薄弱章节最多列几条（默认 5） */
  topChapters?: number;
  /** 报告标题，默认「学习报告」 */
  title?: string;
}

export interface StudyReportSection {
  heading: string;
  /** Markdown 片段（与 markdown 字段里的内容完全一致，单一来源） */
  body: string;
}

/** 结构化数字：供将来做图或做断言，与 Markdown 里的数字同源（同一批变量） */
export interface StudyReportData {
  generatedAt: number;
  range: { from: number | null; to: number | null } | null;
  daysUntilExam: number | null;
  examLabel: string;
  quiz: {
    banks: number;
    questions: number;
    seen: number;
    wrong: number;
    due: number;
    /** 按题正确率 = (seen - wrong) / seen；seen=0 时为 null（不可计算，不写 0%） */
    accuracy: number | null;
    multiTotal: number;
    multiSeen: number;
    multiWrong: number;
    multiAccuracy: number | null;
  };
  chapters: {
    weak: Array<{ bank: string; chapter: string; seen: number; wrong: number; accuracy: number }>;
    /** 有作答但没到阈值（< MASTERY_MIN_SEEN）的章节：只报事实，不下结论 */
    insufficient: Array<{ bank: string; chapter: string; seen: number }>;
  };
  repeatWrong: Array<{ bank: string; qid: string; stem: string; wrong: number }>;
  mistakes: {
    total: number;
    fails: number;
    failedInRange: number | null;
    chapters: Array<{ chapter: string; count: number }>;
    top: Array<{ title: string; chapter: string; count: number; lastFailedAt: number; reason: MistakeReason | null }>;
    reasons: Array<{ reason: MistakeReason; count: number; unlabeled: number }> | null;
  };
  cards: {
    total: number;
    learned: number;
    dueNow: number;
    /** 已进入 FSRS 的复习阶段（ts-fsrs State.Review）的卡数 */
    mastered: number;
    newCards: number;
    reviewedInRange: number | null;
  };
  calibration: { n: number; accuracy: number | null; meanConfidence: number | null } | null;
}

export interface StudyReport {
  title: string;
  /** 可直接复制/下载的 Markdown 全文 */
  markdown: string;
  sections: StudyReportSection[];
  /** 关键事实（一句话一条），用于面板顶部的摘要行 */
  highlights: string[];
  /** 数据是否足以支撑结论（不足时报告里已明说；调用方也可据此显示空状态） */
  sufficient: boolean;
  data: StudyReportData;
}

// ---------- 格式化（统一出口，避免同一份报告里出现两种百分比写法） ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 比例 → 百分比，统一保留 1 位小数；不可计算（null/NaN）输出「—」 */
export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${(value * 100).toFixed(1)}%`;
}

/** 计数：不可计算（null/NaN）输出「—」；0 是真实值，照实写 0 */
export function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return String(Math.round(value));
}

/** 时间戳 → 本地日历日 `YYYY-MM-DD`；0/缺失/NaN 输出「—」 */
export function fmtDay(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return EMPTY;
  return localDay(new Date(ms));
}

/** 时间戳 → 本地 `YYYY-MM-DD HH:mm`；0/缺失/NaN 输出「—」 */
export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return EMPTY;
  const d = new Date(ms);
  return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 题干/标题截断：报告要一眼能看，长题干只留开头 */
function shorten(text: string, max = 40): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 题目没写章节时既有的分组是空串（见 chapterMastery）；报告里不能留空白标签 */
function chapterLabel(chapter: string): string {
  return chapter || '未标注章节';
}

/** 按题正确率：与 qbankStats.chapterMastery 完全同一算式；seen=0 时返回 null 而不是 0 */
function accuracyOf(seen: number, wrong: number): number | null {
  return seen > 0 ? (seen - wrong) / seen : null;
}

function inRange(at: number, range: StudyReportRange): boolean {
  if (!at) return false;
  if (range.from !== undefined && at < range.from) return false;
  if (range.to !== undefined && at > range.to) return false;
  return true;
}

/** 报告主体：纯函数，调用两次同一份输入得到逐字相同的输出 */
export function buildStudyReport(input: StudyReportInput): StudyReport {
  const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
  const nowDate = new Date(nowMs);
  const topN = Math.max(1, Math.floor(input.topChapters ?? 5));
  const title = input.title?.trim() || '学习报告';

  const hasRange = input.range !== undefined && (input.range.from !== undefined || input.range.to !== undefined);
  const range = hasRange ? input.range! : undefined;

  // ---------- 题目练习（累计口径；逐题记录里没有逐次作答日志，见文件头） ----------
  // 全部走 bankProgress：它把「做过几道 / 错了几道 / 今天该复习几道」定死在一个地方，
  // 与题库列表面板、AI 的 get_quiz_progress 用的是同一个函数。
  let questions = 0;
  let seen = 0;
  let wrong = 0;
  let due = 0;
  let multiTotal = 0;
  let multiSeen = 0;
  let multiWrong = 0;
  const repeatWrong: StudyReportData['repeatWrong'] = [];
  for (const bank of input.banks) {
    const p = bankProgress(bank.name, bank.questions.map((q) => q.id), input.stats, nowMs);
    questions += p.total;
    seen += p.seen;
    wrong += p.wrong;
    due += p.due;
    for (const q of bank.questions) {
      if (!isMultiSelect(q)) continue;
      multiTotal++;
      const s = statOf(input.stats, bank.name, q.id);
      if (!s) continue;
      multiSeen++;
      // 多选题「全对才算对」是既有判分口径（QuizView 用 qbank.isCorrectPick 判定后才
      // 调 recordAnswer），所以这里 s.wrong 本身就等于「没全对过」——不必另算一遍选项集合。
      if (s.wrong > 0) multiWrong++;
    }
  }
  // 「重复错同一题」看的是逐题记录里的累计答错次数（QStat.wrong，qbankStats 的既有字段）
  for (const bank of input.banks) {
    for (const q of bank.questions) {
      const s = statOf(input.stats, bank.name, q.id);
      if (s && s.wrong >= REPEAT_WRONG_MIN) repeatWrong.push({ bank: bank.name, qid: q.id, stem: q.stem, wrong: s.wrong });
    }
  }
  repeatWrong.sort((a, b) => b.wrong - a.wrong || a.stem.localeCompare(b.stem));
  const accuracy = accuracyOf(seen, wrong);
  const multiAccuracy = accuracyOf(multiSeen, multiWrong);

  // ---------- 薄弱章节（沿用 chapterMastery 的聚合与阈值，绝不另定一套） ----------
  const weak: StudyReportData['chapters']['weak'] = [];
  const insufficient: StudyReportData['chapters']['insufficient'] = [];
  for (const bank of input.banks) {
    for (const m of chapterMastery(bank, input.stats)) {
      if (m.weak) weak.push({ bank: bank.name, chapter: m.chapter, seen: m.seen, wrong: m.wrong, accuracy: m.accuracy });
      else if (m.seen > 0 && m.seen < MASTERY_MIN_SEEN) insufficient.push({ bank: bank.name, chapter: m.chapter, seen: m.seen });
    }
  }
  weak.sort((a, b) => a.accuracy - b.accuracy || b.seen - a.seen || a.chapter.localeCompare(b.chapter));
  const weakTop = weak.slice(0, topN);

  // ---------- 复习卡（口径与 core/srs.srsStats 一致：只统计「有排程」的卡） ----------
  let learned = 0;
  let dueNow = 0;
  let mastered = 0;
  let reviewedInRange = 0;
  for (const card of input.cards) {
    // scheduleOf 是 srs.ts 的既有函数：它会处理「旧整篇卡调度继承」，自己写一遍必然漂移
    const s = scheduleOf(input.schedules, card);
    if (!s) continue;
    learned++;
    if (new Date(s.due).getTime() <= nowMs) dueNow++;
    // 「已掌握」取 ts-fsrs 既有阶段：State.Review = 已从学习/重学阶段毕业
    if (s.state === FsrsState.Review) mastered++;
    const at = s.last_review ? new Date(s.last_review).getTime() : 0;
    if (range && inRange(at, range)) reviewedInRange++;
  }
  const newCards = input.cards.length - learned;

  // ---------- 错题本（笔记线，与「逐题记录」是两条线，报告里分别写清） ----------
  const records = Object.values(input.mistakes);
  const fails = records.reduce((a, r) => a + r.count, 0);
  const heat = chapterHeat(input.mistakes).slice(0, topN);
  const topMistakes = [...records]
    .sort((a, b) => b.count - a.count || b.lastFailedAt - a.lastFailedAt)
    .slice(0, topN)
    .map((r) => ({ title: r.title, chapter: r.chapter, count: r.count, lastFailedAt: r.lastFailedAt, reason: r.reason ?? null }));
  const failedInRange = range ? records.filter((r) => inRange(r.lastFailedAt, range)).length : null;

  // ---------- 校准（可选；3 个百分点的死区沿用 Dashboard / aiLearning 的既有判定） ----------
  const cal = input.calibration;
  const calAccuracy = cal && cal.n > 0 ? cal.correct / cal.n : null;
  // CalibSummary.overconfidence = 平均自信 − 实际正确率，所以加回来就是平均自信
  const calMean = cal && cal.n > 0 && calAccuracy !== null ? cal.overconfidence + calAccuracy : null;
  const calibration = cal ? { n: cal.n, accuracy: calAccuracy, meanConfidence: calMean } : null;

  const days = daysUntilExam(input.plan.examDate, nowDate);
  const rangeText = range
    ? `${range.from !== undefined ? fmtDay(range.from) : '不限'} ~ ${range.to !== undefined ? fmtDay(range.to) : '不限'}`
    : EMPTY;

  const data: StudyReportData = {
    generatedAt: nowMs,
    range: range ? { from: range.from ?? null, to: range.to ?? null } : null,
    daysUntilExam: days,
    examLabel: input.plan.examLabel,
    quiz: { banks: input.banks.length, questions, seen, wrong, due, accuracy, multiTotal, multiSeen, multiWrong, multiAccuracy },
    chapters: { weak: weakTop, insufficient },
    repeatWrong: repeatWrong.slice(0, topN),
    mistakes: { total: records.length, fails, failedInRange, chapters: heat, top: topMistakes, reasons: input.mistakeReasons ?? null },
    cards: { total: input.cards.length, learned, dueNow, mastered, newCards, reviewedInRange: range ? reviewedInRange : null },
    calibration,
  };

  const highlights: string[] = [];
  const sections: StudyReportSection[] = [];

  // ---------- 1. 概览 ----------
  {
    // 距考试的说法沿用 Dashboard 的既有文案（考试已过 / 就是今天 / 还有 N 天），
    // 避免同一个数字在两处出现两种表述
    const examSuffix = `${input.plan.examLabel ? `${input.plan.examLabel} · ` : ''}${input.plan.examDate}`;
    const examLine = days === null
      ? `- 距考试：${EMPTY}（未设置考试日期）`
      : days > 0
        ? `- 距考试：还有 ${days} 天（${examSuffix}）`
        : days === 0
          ? `- 距考试：考试就是今天（${examSuffix}）`
          : `- 距考试：考试已过 ${-days} 天（${examSuffix}）`;
    const lines = [
      `- 生成时间：${fmtDateTime(nowMs)}`,
      `- 时间范围：${rangeText}${range ? '' : '（按累计口径）'}`,
      examLine,
      `- 数据范围：题库 ${fmtCount(input.banks.length)} 个 / 题目 ${fmtCount(questions)} 道；复习卡 ${fmtCount(input.cards.length)} 张；错题本 ${fmtCount(records.length)} 条`,
    ];
    if (input.plan.examDate && days !== null) {
      highlights.push(days > 0 ? `距考试 ${days} 天` : days === 0 ? '考试就是今天' : `考试已过 ${-days} 天`);
    } else {
      highlights.push(`距考试：${EMPTY}（未设置考试日期）`);
    }
    sections.push({ heading: '概览', body: lines.join('\n') });
  }

  // ---------- 2. 题目练习 ----------
  {
    const lines: string[] = [];
    if (questions === 0) {
      lines.push('还没有导入题库，题目练习部分无数据。');
      highlights.push('题目练习：还没有导入题库');
    } else if (seen === 0) {
      // 关键：这里绝不能写 0% —— 没有作答记录时正确率不可计算
      lines.push(`题库里有 ${fmtCount(questions)} 道题，但还没有作答记录，正确率无从计算（不写 0%）。`);
      highlights.push(`题目练习：${fmtCount(questions)} 道题都还没作答，正确率 ${EMPTY}`);
    } else {
      lines.push(`- 答题量：已作答 ${fmtCount(seen)} / ${fmtCount(questions)} 题（还有 ${fmtCount(questions - seen)} 题没做过）`);
      lines.push(`- 按题正确率：${fmtPct(accuracy)}（${fmtCount(seen)} 题样本，其中答错过 ${fmtCount(wrong)} 题）`);
      lines.push(`- 今日待复习题：${fmtCount(due)} 题`);
      if (seen < MASTERY_MIN_SEEN) {
        lines.push(`- 样本不足：只有 ${fmtCount(seen)} 题作答记录（低于既有阈值 ${MASTERY_MIN_SEEN} 题），正确率仅供参考，不下结论。`);
      }
      highlights.push(`按题正确率 ${fmtPct(accuracy)}（${fmtCount(seen)} 题样本${seen < MASTERY_MIN_SEEN ? '，样本不足以下结论' : ''}）`);
    }
    if (multiTotal === 0) {
      lines.push('- 多选题（X 型，全对才算对）：题库里没有多选题。');
    } else if (multiSeen === 0) {
      lines.push(`- 多选题（X 型，全对才算对）：共 ${fmtCount(multiTotal)} 题，都还没作答，正确率 ${EMPTY}。`);
    } else {
      lines.push(
        `- 多选题（X 型，全对才算对）：共 ${fmtCount(multiTotal)} 题，已作答 ${fmtCount(multiSeen)} 题，`
        + `正确率 ${fmtPct(multiAccuracy)}（答错过 ${fmtCount(multiWrong)} 题）`
      );
    }
    if (range) lines.push('- 说明：本节是**累计口径**（逐题记录没有逐次作答日志，按时间范围切分只会得到编造的数字）。');
    sections.push({ heading: '题目练习', body: lines.join('\n') });
  }

  // ---------- 3. 薄弱章节 ----------
  {
    const lines: string[] = [];
    if (weakTop.length) {
      lines.push(`判定沿用既有阈值：样本 ≥ ${MASTERY_MIN_SEEN} 题且按题正确率 < ${fmtPct(MASTERY_WEAK_ACCURACY)} 才算薄弱（与章节掌握度热力图同一套）。`);
      for (const w of weakTop) {
        lines.push(`- ${chapterLabel(w.chapter)}（${w.bank}）：正确率 ${fmtPct(w.accuracy)}，样本 ${fmtCount(w.seen)} 题（答错过 ${fmtCount(w.wrong)} 题）`);
      }
      const head = weakTop[0];
      lines.push('', `共 ${fmtCount(weak.length)} 个章节达标薄弱，上表列前 ${fmtCount(weakTop.length)} 个。`);
      highlights.push(`最薄弱：${chapterLabel(head.chapter)} 正确率 ${fmtPct(head.accuracy)}（${fmtCount(head.seen)} 题样本）`);
    } else if (insufficient.length) {
      lines.push(
        `没有达到结论阈值的章节：${fmtCount(insufficient.length)} 个章节有作答但样本不足（少于 ${MASTERY_MIN_SEEN} 题），`
        + '样本不足，不下结论。'
      );
      for (const m of insufficient.slice(0, topN)) {
        lines.push(`- ${chapterLabel(m.chapter)}（${m.bank}）：只有 ${fmtCount(m.seen)} 题样本`);
      }
      highlights.push(`薄弱章节：样本不足（${fmtCount(insufficient.length)} 个章节少于 ${MASTERY_MIN_SEEN} 题），不下结论`);
    } else {
      lines.push('还没有章节掌握度数据：没有任何题被作答过，所以没有薄弱章节可列。');
      highlights.push('薄弱章节：还没有作答数据');
    }
    sections.push({ heading: '薄弱章节', body: lines.join('\n') });
  }

  // ---------- 4. 错题分布 ----------
  {
    const lines: string[] = [];
    if (records.length === 0 && repeatWrong.length === 0) {
      lines.push('还没有累计答错记录（错题本为空，逐题记录里也没有答错的题）。');
      highlights.push('错题：还没有答错记录');
    } else {
      if (records.length) {
        lines.push(`- 错题本：${fmtCount(records.length)} 处，累计失败 ${fmtCount(fails)} 次，分布在 ${fmtCount(heat.length)} 个章节`);
        for (const h of heat) lines.push(`  - ${chapterLabel(h.chapter)}：${fmtCount(h.count)} 次`);
        if (range) lines.push(`- 时间范围内失败过的错题：${fmtCount(failedInRange)} 处（按「最近一次失败时间」计）`);
      } else {
        lines.push(`- 错题本：${EMPTY}（复习时点「忘了」才会收录）；时间范围内失败过的错题：${range ? fmtCount(failedInRange) : EMPTY}`);
      }
      if (input.mistakeReasons) {
        const labeled = input.mistakeReasons.reduce((a, r) => a + r.count, 0);
        const unlabeled = input.mistakeReasons[0]?.unlabeled ?? 0;
        lines.push(
          labeled
            ? `- 错因分布（按条计数，与错题本同源）：${input.mistakeReasons.filter((r) => r.count > 0).map((r) => `${MISTAKE_REASON_LABELS[r.reason]} ${r.count}`).join('、')}${unlabeled ? `；未标注 ${unlabeled} 条` : ''}`
            : `- 错因分布：${fmtCount(records.length)} 条错题都还没标注错因。`
        );
      }
      if (repeatWrong.length) {
        lines.push(`- 重复错过 ≥${REPEAT_WRONG_MIN} 次的题：${fmtCount(repeatWrong.length)} 道`);
        for (const r of data.repeatWrong) lines.push(`  - ${shorten(r.stem)}（${r.bank}，错 ${fmtCount(r.wrong)} 次）`);
        highlights.push(`有 ${fmtCount(repeatWrong.length)} 道题累计答错 ≥${REPEAT_WRONG_MIN} 次`);
      } else {
        lines.push(`- 重复错过 ≥${REPEAT_WRONG_MIN} 次的题：${EMPTY}（逐题记录里没有反复错的题）`);
      }
      if (topMistakes.length) {
        lines.push('- 重复错过的笔记：');
        for (const r of topMistakes) {
          const reason = r.reason ? `（${MISTAKE_REASON_LABELS[r.reason]}）` : '';
          lines.push(`  - 「${r.title}」${r.chapter ? ` · ${r.chapter}` : ''} 错 ${fmtCount(r.count)} 次${reason}，最近 ${fmtDay(r.lastFailedAt)}`);
        }
      }
    }
    sections.push({ heading: '错题分布', body: lines.join('\n') });
  }

  // ---------- 5. 复习卡 ----------
  {
    const lines: string[] = [];
    if (input.cards.length === 0) {
      lines.push('知识库里还没有笔记，没有复习卡可统计。');
      highlights.push('复习卡：还没有卡片');
    } else {
      lines.push(`- 卡片：共 ${fmtCount(input.cards.length)} 张（已进入调度 ${fmtCount(learned)} 张，新卡 ${fmtCount(newCards)} 张）`);
      lines.push(`- 今日到期：${fmtCount(dueNow)} 张`);
      lines.push(`- 已掌握（FSRS 进入复习阶段 State.Review）：${fmtCount(mastered)} 张`);
      if (range) lines.push(`- 时间范围内复习过的卡：${fmtCount(reviewedInRange)} 张（按「最近一次复习时间」计）`);
      highlights.push(`复习卡：今日到期 ${fmtCount(dueNow)} 张 / 已排程 ${fmtCount(learned)} 张 / 已掌握 ${fmtCount(mastered)} 张`);
    }
    if (calibration) {
      if (calibration.n === 0) {
        // 与 Dashboard / aiLearning 同一说法：没有样本就如实说没有，不让任何人推断水平
        lines.push('- 把握度校准：还没有样本（在题库作答前选一个把握程度就会开始记录）。');
      } else {
        const diff = (calibration.meanConfidence ?? 0) - (calibration.accuracy ?? 0);
        const verdict = Math.abs(diff) < 0.03
          ? '校准得不错'
          : diff > 0 ? `高估 ${(diff * 100).toFixed(1)} 个百分点` : `低估 ${(-diff * 100).toFixed(1)} 个百分点`;
        lines.push(
          `- 把握度校准：${fmtCount(calibration.n)} 次作答报了把握度，平均自信 ${fmtPct(calibration.meanConfidence)}、`
          + `实际答对 ${fmtPct(calibration.accuracy)} —— ${verdict}。`
        );
      }
    }
    sections.push({ heading: '复习卡', body: lines.join('\n') });
  }

  // ---------- 6. 下一步建议（每条都必须由上面的数字推出） ----------
  {
    const tips: string[] = [];
    if (weakTop.length) {
      const w = weakTop[0];
      tips.push(
        `「${chapterLabel(w.chapter)}」按题正确率 ${fmtPct(w.accuracy)}（样本 ${fmtCount(w.seen)} 题）低于既有阈值 ${fmtPct(MASTERY_WEAK_ACCURACY)}，`
        + `且样本已达 ${MASTERY_MIN_SEEN} 题阈值，建议优先复习${weak.length > 1 ? `（同样达标的还有 ${fmtCount(weak.length - 1)} 个章节）` : ''}。`
      );
    }
    if (repeatWrong.length) {
      const r = repeatWrong[0];
      tips.push(
        `有 ${fmtCount(repeatWrong.length)} 道题累计答错 ≥${REPEAT_WRONG_MIN} 次，最多的是「${shorten(r.stem)}」（${r.bank}，错 ${fmtCount(r.wrong)} 次）：`
        + '这是重复错同一题，建议先看解析再重做，而不是继续刷新题。'
      );
    }
    if (accuracy !== null && seen >= MASTERY_MIN_SEEN && accuracy < MASTERY_WEAK_ACCURACY) {
      tips.push(`整体按题正确率 ${fmtPct(accuracy)}（${fmtCount(seen)} 题样本）低于 ${fmtPct(MASTERY_WEAK_ACCURACY)}，先把答错过的 ${fmtCount(wrong)} 道题过一遍，再扩新题量。`);
    }
    if (dueNow > 0) {
      tips.push(`今天有 ${fmtCount(dueNow)} 张卡到期（已排程 ${fmtCount(learned)} 张中的 ${fmtPct(learned ? dueNow / learned : null)}），按既有顺序先清到期再学新卡。`);
    } else if (newCards > 0) {
      tips.push(`今天没有到期的复习卡，还有 ${fmtCount(newCards)} 张新卡未进入调度，可以开始学新卡。`);
    }
    if (days !== null && days > 0 && newCards > 0) {
      tips.push(`距考试还有 ${days} 天，${fmtCount(newCards)} 张新卡平摊下来每天约 ${fmtCount(Math.ceil(newCards / days))} 张（只是按现有数据除算，不是建议上限）。`);
    }
    if (days !== null && days > 0 && input.plan.dailyCap > 0 && dueNow + newCards > 0) {
      // effectiveDailyCap 是 reviewPlan 的既有函数：上限是天花板，考试越近收得越紧
      tips.push(`每日上限设为 ${fmtCount(input.plan.dailyCap)} 张，按剩余 ${days} 天与待清 ${fmtCount(dueNow + newCards)} 张，今天实际收紧为 ${fmtCount(effectiveDailyCap(input.plan, dueNow + newCards, nowDate))} 张。`);
    }
    const noData = questions === 0 && input.cards.length === 0 && records.length === 0 && repeatWrong.length === 0;
    const body = tips.length
      ? tips.map((t) => `- ${t}`).join('\n')
      : noData
        ? `数据不足：还没有题库与复习卡，也给不出任何有依据的建议（不写与数据无关的套话）。`
        : `按现有数据没有需要优先处理的项：没有达阈值的薄弱章节、没有重复答错的题、也没有到期的复习卡。`;
    if (tips.length) highlights.push(`下一步：${shorten(tips[0], 60)}`);
    sections.push({ heading: '下一步建议', body });
  }

  // ---------- 7. 口径说明（把「为什么不这样算」写在报告里，避免数字被误读） ----------
  {
    const lines = [
      `- 正确率按**题**统计（一道题错过一次即算错题），与章节掌握度热力图、题库进度行同口径；多选题按「全对才算对」判分。`,
      `- 章节薄弱阈值沿用既有口径：样本 ≥ ${MASTERY_MIN_SEEN} 题且正确率 < ${fmtPct(MASTERY_WEAK_ACCURACY)}；样本不足的章节只报样本数，不给结论。`,
      `- 逐题记录只有**累计答错次数**与**最近一次作答时间**，没有逐次作答日志，所以「题目练习」是累计值。`,
    ];
    if (range) {
      lines.push(`- 时间范围（${rangeText}）只作用于带时间戳的记录：复习卡的最近一次复习时间、错题本的最近一次失败时间。`);
    }
    lines.push('- 同一份数据在统计面板、错题本与 AI 学习摘要里读到的数字与本报告一致（都走同一批聚合函数）。');
    sections.push({ heading: '口径说明', body: lines.join('\n') });
  }

  const markdown = [
    `# ${title}`,
    '',
    ...sections.flatMap((s) => [`## ${s.heading}`, '', s.body, '']),
  ].join('\n').replace(/\n+$/, '\n');

  const sufficient = seen >= MASTERY_MIN_SEEN || learned > 0 || records.length > 0;
  return { title, markdown, sections, highlights, sufficient, data };
}
