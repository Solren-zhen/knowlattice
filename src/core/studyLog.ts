/**
 * 每日学习流水（按天聚合，不记逐条明细）。
 *
 * 为什么需要它：Dashboard 之前只能把「累计答错次数」当成「本周表现」，
 * 复习/练题的时间投入与正确率根本无从计算——`learningDashboard` 需要按周筛选的记录，
 * 而 srs / qbankStats 只存最终调度状态，不存「哪一天做了什么」。
 *
 * 这里只存一天的计数（复习 / 复习答好 / 练题 / 答对 / 改正错题），
 * 体积与日期数成正比，不会像事件流那样每答一题就重写几百 KB。
 * 周报在读的时候再把这些计数展开成 learningDashboard 需要的记录数组。
 */
import { defineStore } from '../storage/kv';
import type { Rating } from './srs';
import { dayKey } from './dateKey';

export interface StudyDay {
  reviews: number;
  /** 复习中被判为「好 / 容易」的次数（用于正确率） */
  reviewGood: number;
  quizzes: number;
  quizCorrect: number;
  /** 本次答对、且这道题历史上错过（仅题库练习侧能判断） */
  fixed: number;
}

export type StudyLog = Record<string, StudyDay>;

const KEY = 'knowlattice-study-log';
/** 保留天数：一年多的学习曲线足够，再久也没有展示位 */
export const MAX_STUDY_DAYS = 400;

const EMPTY: StudyDay = { reviews: 0, reviewGood: 0, quizzes: 0, quizCorrect: 0, fixed: 0 };

const isCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const store = defineStore<StudyLog>({
  key: KEY,
  fallback: {},
  decode(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: StudyLog = {};
    for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Partial<StudyDay>;
      out[day] = {
        reviews: isCount(v.reviews),
        reviewGood: isCount(v.reviewGood),
        quizzes: isCount(v.quizzes),
        quizCorrect: isCount(v.quizCorrect),
        fixed: isCount(v.fixed),
      };
    }
    return out;
  },
});

function prune(log: StudyLog): StudyLog {
  const days = Object.keys(log).sort();
  if (days.length <= MAX_STUDY_DAYS) return log;
  const keep = new Set(days.slice(-MAX_STUDY_DAYS));
  const out: StudyLog = {};
  for (const day of days) if (keep.has(day)) out[day] = log[day];
  return out;
}

function bump(at: number, patch: Partial<StudyDay>): void {
  const log = store.read();
  const day = dayKey(at);
  const current = log[day] ?? EMPTY;
  store.write(prune({
    ...log,
    [day]: {
      reviews: current.reviews + (patch.reviews ?? 0),
      reviewGood: current.reviewGood + (patch.reviewGood ?? 0),
      quizzes: current.quizzes + (patch.quizzes ?? 0),
      quizCorrect: current.quizCorrect + (patch.quizCorrect ?? 0),
      fixed: current.fixed + (patch.fixed ?? 0),
    },
  }));
}

/** 记一次复习评分（good / easy 计为答好，与 learningDashboard 的 ≥3 口径一致）。 */
export function recordReview(rating: Rating, at = Date.now()): void {
  bump(at, { reviews: 1, reviewGood: rating === 'good' || rating === 'easy' ? 1 : 0 });
}

/** 记一次题库作答；`wasWrong` 用于「改正错题」统计。 */
export function recordQuiz(correct: boolean, wasWrong = false, at = Date.now()): void {
  bump(at, {
    quizzes: 1,
    quizCorrect: correct ? 1 : 0,
    fixed: correct && wasWrong ? 1 : 0,
  });
}

export function loadStudyLog(): StudyLog {
  return store.read();
}

/** 备份用：按天导出全部计数。 */
export function exportStudyLog(): StudyLog {
  return store.read();
}

/**
 * 恢复用：同一天按字段取较大值。
 * 取 max 而不是相加，是为了让「同一份备份重复导入」保持幂等；
 * 本机通常比旧备份进度更靠前，max 也不会把本机数据冲回去。
 */
export function importStudyLog(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const current = store.read();
  const next: StudyLog = { ...current };
  let added = 0;
  let kept = 0;
  let changed = false;
  for (const [day, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Partial<StudyDay>;
    const incomingDay: StudyDay = {
      reviews: isCount(v.reviews),
      reviewGood: isCount(v.reviewGood),
      quizzes: isCount(v.quizzes),
      quizCorrect: isCount(v.quizCorrect),
      fixed: isCount(v.fixed),
    };
    const local = current[day];
    if (!local) {
      next[day] = incomingDay;
      added += 1;
      changed = true;
      continue;
    }
    const mergedDay: StudyDay = {
      reviews: Math.max(local.reviews, incomingDay.reviews),
      reviewGood: Math.max(local.reviewGood, incomingDay.reviewGood),
      quizzes: Math.max(local.quizzes, incomingDay.quizzes),
      quizCorrect: Math.max(local.quizCorrect, incomingDay.quizCorrect),
      fixed: Math.max(local.fixed, incomingDay.fixed),
    };
    if (
      mergedDay.reviews !== local.reviews
      || mergedDay.reviewGood !== local.reviewGood
      || mergedDay.quizzes !== local.quizzes
      || mergedDay.quizCorrect !== local.quizCorrect
      || mergedDay.fixed !== local.fixed
    ) {
      next[day] = mergedDay;
      changed = true;
    }
    kept += 1;
  }
  if (changed) store.write(prune(next));
  return { added, kept };
}

/** 只取 sinceMs 之后（含当天）的记录，供周报按周筛选。 */
export function studyRecordsSince(sinceMs: number): {
  reviewRecords: Array<{ cardKey: string; rating: number; at: number }>;
  quizRecords: Array<{ qid: string; correct: boolean; at: number }>;
  fixedMistakes: number;
} {
  const log = store.read();
  const reviewRecords: Array<{ cardKey: string; rating: number; at: number }> = [];
  const quizRecords: Array<{ qid: string; correct: boolean; at: number }> = [];
  let fixedMistakes = 0;
  for (const [day, counts] of Object.entries(log)) {
    const at = new Date(`${day}T12:00:00`).getTime();
    if (!Number.isFinite(at) || at < sinceMs) continue;
    for (let i = 0; i < counts.reviews; i += 1) {
      reviewRecords.push({ cardKey: '', rating: i < counts.reviewGood ? 4 : 1, at });
    }
    for (let i = 0; i < counts.quizzes; i += 1) {
      quizRecords.push({ qid: '', correct: i < counts.quizCorrect, at });
    }
    fixedMistakes += counts.fixed;
  }
  return { reviewRecords, quizRecords, fixedMistakes };
}
