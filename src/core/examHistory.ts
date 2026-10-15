/**
 * 模拟考试成绩历史（localStorage）。
 *
 * 只存「考完的结果」，不存整卷题目：报告页复看时靠结果里的 perChapter / wrongIds
 * 就能还原出该讲什么；把几十道题的全文再存一份会让历史表迅速膨胀（每次考试都复制一遍题库）。
 *
 * 范式跟随 `core/stats.ts` / `core/mistakes.ts`：单键 localStorage、模块自带 load/save、
 * 读入时做清洗（旧备份可能带脏数据），并支持导出/恢复以接入整包备份。
 */
import type { ExamResult } from './exam';

const KEY = 'knowlattice-exam-history';

/** 历史上限：只保留最近这么多场，避免长期使用后无限增长。 */
export const EXAM_HISTORY_CAP = 100;

function isResult(raw: unknown): raw is ExamResult {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<ExamResult>;
  return (
    typeof r.id === 'string' &&
    typeof r.bankName === 'string' &&
    typeof r.score === 'number' &&
    typeof r.total === 'number' &&
    typeof r.correct === 'number' &&
    typeof r.finishedAt === 'number' &&
    Array.isArray(r.perChapter) &&
    Array.isArray(r.wrongIds)
  );
}

/** 读全部历史，按完成时间倒序（最近的在最前）。 */
export function loadExamHistory(): ExamResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isResult)
    .map((r) => ({
      ...r,
      usedMs: typeof r.usedMs === 'number' ? r.usedMs : 0,
      timeLimitMs: typeof r.timeLimitMs === 'number' ? r.timeLimitMs : 0,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : r.finishedAt,
    }))
    .sort((a, b) => b.finishedAt - a.finishedAt);
}

function persist(list: ExamResult[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, EXAM_HISTORY_CAP)));
  } catch {
    /* 存不进去（隐私模式/配额）不该影响刚考完的成绩展示 */
  }
}

/** 追加一场成绩，返回更新后的历史（调用方可直接 setState）。 */
export function saveExamResult(result: ExamResult): ExamResult[] {
  const next = [result, ...loadExamHistory().filter((r) => r.id !== result.id)].slice(0, EXAM_HISTORY_CAP);
  persist(next);
  return next;
}

/** 删除一场成绩（误考/练手想清掉时用）。 */
export function removeExamResult(id: string): ExamResult[] {
  const next = loadExamHistory().filter((r) => r.id !== id);
  persist(next);
  return next;
}

export function clearExamHistory(): ExamResult[] {
  persist([]);
  return [];
}

/** 某题库的历史（成绩页画「历史对比」用）。 */
export function historyForBank(bankName: string, history = loadExamHistory()): ExamResult[] {
  return history.filter((r) => r.bankName === bankName);
}

/** 整包备份：导出全部历史；恢复时按 id 去重合并（重复导入同一份备份不会翻倍）。 */
export function exportExamHistory(): ExamResult[] {
  return loadExamHistory();
}

export function importExamHistory(state: unknown): number {
  if (!Array.isArray(state)) return 0;
  const existing = loadExamHistory();
  const seen = new Set(existing.map((r) => r.id));
  let added = 0;
  for (const raw of state) {
    if (!isResult(raw) || seen.has(raw.id)) continue;
    existing.push(raw);
    seen.add(raw.id);
    added += 1;
  }
  persist(existing.sort((a, b) => b.finishedAt - a.finishedAt));
  return added;
}
