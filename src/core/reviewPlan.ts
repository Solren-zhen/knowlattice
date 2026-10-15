/**
 * 复习计划：考试日期 + 每日复习上限。
 *
 * 借鉴点：第三方备考工具把「考试排期」当成复习排序的主锚——
 * 「自适应规划：根据考试倒计时与备考周期自动规划最佳复习起止时间」。
 * 本项目此前只有 FSRS 的到期时间，没有任何"目标日期"概念（全库 grep 确认为 0），
 * 于是复习面板永远只是"今天到期 N 张"，没有紧迫感、也不会随考试临近自动收紧。
 *
 * 本模块只做两件事，且**默认全部关闭**：
 *   1. 记录一个目标考试日期，用来在统计面板显示「距考试 N 天」；
 *   2. 可选的每日复习上限（dailyCap）：> 0 时才截断当日队列。
 *
 * 为什么上限必须默认关闭（0 = 不限制）：既有行为是"到期卡 + 新卡全部排进队列"，
 * 见 core/srs.ts 的 dueQueue。让上限默认生效会改掉所有人现有的复习节奏，
 * 属于"顺手改了别人的学习计划"。所以这是一个 opt-in 的节流阀，不是新的默认行为。
 *
 * 存储范式跟随 core/pomodoro.ts：模块自带 load/save + 默认值清洗，
 * 单键 localStorage，不引入全局 settings 对象（本项目没有，也不该为两个字段引入）。
 */

export interface ReviewPlan {
  /** 考试日期，`YYYY-MM-DD`；空字符串 = 未设置 */
  examDate: string;
  /** 考试名称，用于显示（如「执业医师笔试」）；空 = 只显示天数 */
  examLabel: string;
  /** 每日复习上限（张）；0 = 不限制 */
  dailyCap: number;
}

const KEY = 'knowlattice-review-plan';

/** 上限的最大值：超过这个数就失去"节流"的意义，多半是误输入 */
export const MAX_DAILY_CAP = 2000;

export const DEFAULT_PLAN: ReviewPlan = { examDate: '', examLabel: '', dailyCap: 0 };

/** `YYYY-MM-DD` 且是真实存在的日期（挡掉 2026-02-31 这类） */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 类型/范围清洗：任何非法输入都退回默认值，绝不让脏数据进内存 */
export function sanitizePlan(raw: unknown): ReviewPlan {
  const o = (raw ?? {}) as Partial<ReviewPlan>;
  const examDate = typeof o.examDate === 'string' && isIsoDate(o.examDate) ? o.examDate : '';
  const examLabel = typeof o.examLabel === 'string' ? o.examLabel.slice(0, 40) : '';
  const cap = typeof o.dailyCap === 'number' && Number.isFinite(o.dailyCap) ? Math.floor(o.dailyCap) : 0;
  const dailyCap = cap > 0 && cap <= MAX_DAILY_CAP ? cap : 0;
  return { examDate, examLabel, dailyCap };
}

export function loadPlan(): ReviewPlan {
  try {
    return sanitizePlan(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_PLAN };
  }
}

export function savePlan(plan: ReviewPlan): ReviewPlan {
  const clean = sanitizePlan(plan);
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

/** 导出/恢复（随整包备份走，与 cardEdits 同一纪律） */
export function exportPlan(): ReviewPlan {
  return loadPlan();
}

export function importPlan(raw: unknown): boolean {
  const clean = sanitizePlan(raw);
  if (!clean.examDate && !clean.examLabel && !clean.dailyCap) return false;
  savePlan(clean);
  return true;
}

/**
 * 距考试的天数：正数 = 还有几天，0 = 就是今天，负数 = 已经过去。
 * 未设置日期返回 null（调用方据此不渲染这一块）。
 *
 * 按**本地日历日**取整，不用 (target - now)/86400000 —— 后者在下午 5 点算出来
 * 会把"明天"显示成 0 天（不足 24 小时向下取整），用户看到"距考试 0 天"会误判。
 */
export function daysUntilExam(examDate: string, now = new Date()): number | null {
  if (!isIsoDate(examDate)) return null;
  const [y, m, d] = examDate.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

/**
 * 按剩余天数把每日上限**收紧**——考试越近，越要保证当天能清完，
 * 否则「上限」会变成临考前永远做不完的欠账。
 *
 * 语义：上限是**天花板**（不是下限），所以这里只会让它更小，不会更大。
 *   - 未设上限（0）→ 返回 0，完全不干预；
 *   - 未设考试日期、或日期已到/已过 → 返回用户设的上限（不再收紧，临考当天不该拦人）；
 *   - 其余 → min(用户上限, ceil(待清张数 / 剩余天数))，但至少保留 1 张，
 *     否则待清数很大而天数很小时会把队列锁死（cap=0 在调用方意味着「不限制」，语义会反转）。
 */
export function effectiveDailyCap(plan: ReviewPlan, pendingCount: number, now = new Date()): number {
  const base = plan.dailyCap;
  if (!base) return 0;
  const days = daysUntilExam(plan.examDate, now);
  if (days === null || days <= 0) return base;
  const perDay = Math.ceil(Math.max(0, pendingCount) / days);
  return Math.max(1, Math.min(base, perDay));
}

/**
 * 截断当日队列（纯函数）。cap <= 0 时**原样返回同一个引用**——
 * 复习队列在 ReviewView 里进 useState，换不换引用会影响一次重渲染，默认路径上不该有代价。
 */
export function applyDailyCap<T>(queue: T[], cap: number): T[] {
  if (!cap || cap <= 0 || queue.length <= cap) return queue;
  return queue.slice(0, cap);
}
