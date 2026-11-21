/**
 * 实测难度校准（P0-1）：「FSRS 估的难度」与「真实作答的正确率」并排算一次。
 *
 * 为什么需要：`qbankTags.difficultyBand` 读的是 `QStat.difficulty` —— FSRS 自己算的 1~10
 * 估计值，初值来自第一次作答的评分，前几次基本等于猜。而用户在组卷弹窗按「困难」筛题时，
 * 真正想要的是「我总做错的那批」。两者背离时，筛出来的恰好是他最熟的题 —— 「专项练弱项」
 * 于是变成「再爽一遍」。
 *
 * 口径与 `qbankTags.accuracyOf` 逐字一致：`max(0, reps - wrong) / reps`。
 * 样本不足（< MIN_ATTEMPTS_FOR_CALIBRATION）不下结论：一次做错不等于这题难。
 *
 * 刻意不做 IRT/CAT：标定一套题目难度参数要几千次真实作答，这里只是把已有数据换个读法，
 * 不引入需要学习的新参数。
 */
import type { QuizBank, QuizQuestion } from './qbank';
import { statOf, type QStat } from './qbankStats';
import { difficultyBand, type DifficultyBand } from './qbankTags';

/** 少于这么多次作答，实测正确率没有说服力（与 qbankTags 的 TAG_MIN_REPS 独立：那个管标签，这个管结论） */
export const MIN_ATTEMPTS_FOR_CALIBRATION = 3;
/** 自适应练习想稳住的正确率；与 FSRS 的期望记忆保持率（0.9，管「多久后忘」）是两件事 */
export const DEFAULT_TARGET_ACCURACY = 0.7;
/** 实测分档：≥85% 简单，<55% 困难（与 FSRS 分档共用同一类型，界面才能并排显示） */
export const EMPIRICAL_EASY_MIN = 0.85;
export const EMPIRICAL_HARD_MAX = 0.55;
/** 没做过时的先验正确率：比目标略低，新题有机会被抽到，又不至于把有把握的题全挤掉 */
export const UNSEEN_PRIOR = 0.5;

export type CalibStatus = 'ok' | 'tooHard' | 'tooEasy' | 'unrated';

/** 标称难度三档 ↔ 题库里的 1/2/3（作者的写法），与 DifficultyBand 是同一件事的两种表示 */
export const LEVEL_OF_BAND: Record<Exclude<DifficultyBand, 'unknown'>, 1 | 2 | 3> = { easy: 1, medium: 2, hard: 3 };
/** 1/2/3 → 难度档；没标 → unknown（未标注的题不参与校准） */
export function bandOfLevel(level: 1 | 2 | 3 | undefined): DifficultyBand {
  if (level === 1) return 'easy';
  if (level === 2) return 'medium';
  if (level === 3) return 'hard';
  return 'unknown';
}
/** 难度档 → 建议写回的 1/2/3；unknown 没有建议 */
export function levelOfBand(band: DifficultyBand): 1 | 2 | 3 | null {
  return band === 'unknown' ? null : LEVEL_OF_BAND[band];
}

export interface QuestionCalib {
  id: string;
  /** 所属题库名（采纳建议时要按名字找回那一道题） */
  bank?: string;
  /** 题干（面板上要能认出是哪道题，而不是只给一串 id） */
  stem?: string;
  chapter: string;
  attempts: number;
  wrong: number;
  /** 实测正确率；没作答过为 null */
  rate: number | null;
  /** 标称难度档：作者标了就用作者的，没标才退回 FSRS 的估计 */
  nominal: DifficultyBand;
  /** 这道题的标称难度是不是作者写的（false = 拿 FSRS 估计当的标称，结论只能算参考） */
  declared: boolean;
  /** 实测难度档 */
  empirical: DifficultyBand;
  /** 建议写回的标称难度（= 实测档）；未评估为 null */
  suggested: 1 | 2 | 3 | null;
  status: CalibStatus;
}

export interface CalibSummary {
  /** 有作答记录的题数（不含从未做过的） */
  total: number;
  /** 其中样本够、能下结论的题数 */
  rated: number;
  ok: number;
  /** 实测比标称难：按「简单」筛会漏掉它们 */
  tooHard: number;
  /** 实测比标称容易：按「困难」筛会白筛出来 */
  tooEasy: number;
  /** 做过但次数不够 */
  unrated: number;
  /** 其中标称难度是作者写过的题数；0 = 全部拿 FSRS 估计当标称，结论只能算参考 */
  declared: number;
}

const RANK: Record<DifficultyBand, number> = { easy: 0, medium: 1, hard: 2, unknown: -1 };

export function attemptsOf(stat: QStat | undefined): number {
  return stat ? Math.max(0, stat.reps) : 0;
}

/** 实测正确率；一次都没做过返回 null（不能返回 0，那会把「没练过」说成「全错」） */
export function empiricalAccuracy(stat: QStat | undefined): number | null {
  const reps = attemptsOf(stat);
  if (reps <= 0) return null;
  return Math.max(0, reps - (stat?.wrong ?? 0)) / reps;
}

export function empiricalBand(rate: number | null): DifficultyBand {
  if (rate === null) return 'unknown';
  if (rate >= EMPIRICAL_EASY_MIN) return 'easy';
  if (rate < EMPIRICAL_HARD_MAX) return 'hard';
  return 'medium';
}

/**
 * 标称与实测并排；样本不够时 status 记 unrated（界面只说「还没做够」，不给建议）。
 * `declared` 是作者标的 1/2/3：有就用它，没有才退回 FSRS 估计——
 * 拿模型估计校准模型估计是自证，只能当参考，所以还得单独告诉调用方这是哪一种。
 */
export function calibrateQuestion(
  id: string, stat: QStat | undefined, chapter = '', declared?: 1 | 2 | 3,
): QuestionCalib {
  const attempts = attemptsOf(stat);
  const rate = empiricalAccuracy(stat);
  const nominal = declared ? bandOfLevel(declared) : difficultyBand(stat);
  const empirical = empiricalBand(rate);
  let status: CalibStatus = 'unrated';
  if (attempts >= MIN_ATTEMPTS_FOR_CALIBRATION && rate !== null && nominal !== 'unknown') {
    const dr = RANK[empirical] - RANK[nominal];
    status = dr > 0 ? 'tooHard' : dr < 0 ? 'tooEasy' : 'ok';
  }
  return {
    id, chapter, attempts, wrong: stat?.wrong ?? 0, rate,
    nominal, declared: Boolean(declared), empirical, suggested: levelOfBand(empirical), status,
  };
}

/**
 * 采纳建议：只改这一道题的 `difficulty` 一个字段，其余（题干、选项、统计、批注）原样返回。
 * 返回新 bank（不改入参）：让调用方决定什么时候落库，失败也能丢掉这个副本。
 */
export function withDifficulty(bank: QuizBank, id: string, level: 1 | 2 | 3): QuizBank {
  return {
    ...bank,
    questions: bank.questions.map((q: QuizQuestion) => (q.id === id ? { ...q, difficulty: level } : q)),
  };
}

export function calibrateBank(bank: QuizBank, stats: Record<string, Record<string, QStat>>): QuestionCalib[] {
  return bank.questions.map((q) => ({
    ...calibrateQuestion(q.id, statOf(stats, bank.name, q.id), q.chapter ?? '', q.difficulty),
    bank: bank.name,
    stem: q.stem,
  }));
}

export function summarizeCalib(rows: QuestionCalib[]): CalibSummary {
  const s: CalibSummary = { total: 0, rated: 0, ok: 0, tooHard: 0, tooEasy: 0, unrated: 0, declared: 0 };
  for (const r of rows) {
    if (r.attempts <= 0) continue;
    s.total += 1;
    if (r.declared) s.declared += 1;
    if (r.status === 'unrated') { s.unrated += 1; continue; }
    s.rated += 1;
    if (r.status === 'ok') s.ok += 1;
    else if (r.status === 'tooHard') s.tooHard += 1;
    else s.tooEasy += 1;
  }
  return s;
}

/** 一句话结论（Dashboard 用）；没样本返回空串，调用方据此不渲染 */
export function calibSentence(s: CalibSummary): string {
  if (s.rated <= 0) return '';
  if (s.tooHard === 0 && s.tooEasy === 0) return `${s.rated} 题作答够数，标称难度与实测一致`;
  const parts: string[] = [];
  if (s.tooHard > 0) parts.push(`${s.tooHard} 题实测比标称难`);
  if (s.tooEasy > 0) parts.push(`${s.tooEasy} 题比标称容易`);
  return `${s.rated} 题作答够数，${parts.join('，')}`;
}

/** 实测比标称难的题，正确率最低的在前（最该补的最前面）；供面板列出具体章节 */
export function hardestFirst(rows: QuestionCalib[], limit = 3): QuestionCalib[] {
  return rows
    .filter((r) => r.status === 'tooHard')
    .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.attempts - a.attempts)
    .slice(0, Math.max(0, limit));
}

/**
 * 自适应预测正确率：样本够就用实测，样本少则向先验收缩（n/(n+k) 的贝叶斯式收缩）。
 * 一次做对就按 100% 算会把一整轮题都设成一星难度；收缩让「只做过一次」近似「还不知道」。
 */
export function predictedAccuracy(stat: QStat | undefined): number {
  const reps = attemptsOf(stat);
  const rate = empiricalAccuracy(stat);
  if (rate === null) return UNSEEN_PRIOR;
  const n = Math.min(reps, MIN_ATTEMPTS_FOR_CALIBRATION);
  return (n * rate + (MIN_ATTEMPTS_FOR_CALIBRATION - n) * UNSEEN_PRIOR) / MIN_ATTEMPTS_FOR_CALIBRATION;
}

/** 离目标正确率多远（0 = 正合适）；自适应抽题按这个值分桶 */
export function targetDistance(stat: QStat | undefined, target = DEFAULT_TARGET_ACCURACY): number {
  return Math.abs(predictedAccuracy(stat) - target);
}
