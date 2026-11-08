/**
 * 断点续做：记住「练到哪一道」，下次打开题库练习时能接着练。
 *
 * 为什么存题目 id 列表而不是存下标：题库再次导入会走增量合并（core/qbankMerge），
 * 题目顺序会变、也可能被删；存下标会在恢复后指到另一道题上——「继续上次」变成
 * 「从另一道题开始」是最难被发现的那种错。存 id 列表，恢复时按 id 找回原题、
 * 按原顺序排，找不到的题直接跳过（题库被删了一半也还能续上剩下的）。
 */
import type { ComposeRules } from './qbankCompose';
import { asRecord } from './record';

export interface QuizCursor {
  /** 题库名（与 QuizBank.name 同一口径，恢复时按它找库） */
  bank: string;
  /** 本轮题目的 id，按作答顺序 */
  qids: string[];
  /** 下一道要做的题的下标 */
  idx: number;
  /** 组卷规则；null = 整库洗牌（「全部」入口） */
  rules: ComposeRules | null;
  /**
   * 每题的对错（与 qids 对齐，null = 还没答）。
   * 只记位置不记答案，等于做了一半关掉再打开，分数与已答记录全丢——那还是「进度消失」。
   */
  results?: (boolean | null)[];
  /** 当前这道题已选的选项下标（还没提交时才有意义） */
  picked?: number[];
  /** 最后更新时间戳（ms） */
  at: number;
}

const KEY = 'knowlattice-quiz-cursor';

/** 超过这个时长就不提示续做了：隔了两周再弹「继续上次」，用户多半已经忘了当时在练什么 */
const STALE_MS = 14 * 24 * 3600 * 1000;

/**
 * 读出游标。**任何一处不符合形状就整条丢弃**：半个游标（有 id 列表没下标）会让恢复
 * 逻辑拿到 NaN 下标，表现成「续做后停在第一题」——不如干脆当作没有。
 */
export function loadCursor(now = Date.now()): QuizCursor | null {
  let raw: unknown;
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    raw = JSON.parse(text);
  } catch {
    // 存储被禁用或内容被手改坏：当作没有游标，不影响正常练习
    return null;
  }
  const o = asRecord(raw);
  if (!o) return null;
  const qids = Array.isArray(o.qids) ? o.qids.filter((x): x is string => typeof x === 'string') : null;
  if (typeof o.bank !== 'string' || !qids || qids.length === 0) return null;
  if (typeof o.idx !== 'number' || !Number.isFinite(o.idx) || o.idx < 0) return null;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  if (now - at > STALE_MS) return null;
  // 已经做完的轮次不该提示续做（idx 越界时上层也无题可给）
  if (o.idx >= qids.length) return null;
  // 对错表长度不符（旧版本游标或手改过）就整块丢掉，别让恢复后的分数对不上题号
  const rawResults = Array.isArray(o.results) ? o.results : [];
  const results = rawResults.length === qids.length
    ? rawResults.map((x) => (x === true ? true : x === false ? false : null))
    : undefined;
  const picked = Array.isArray(o.picked)
    ? o.picked.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map((x) => Math.floor(x))
    : undefined;
  return { bank: o.bank, qids, idx: Math.floor(o.idx), rules: (o.rules as ComposeRules | null) ?? null, results, picked, at };
}

/** 写游标。存储写失败（配额满 / 无痕模式）只当没记住，不打断正在进行的练习 */
export function saveCursor(c: QuizCursor): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

/** 一轮练完（或用户结束本轮）时清掉，免得下次又提示已经做完的那一轮 */
export function clearCursor(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 存储不可用时本来也没有游标可清 */
  }
}

/**
 * 把游标还原成本轮题目：按 id 找回原题、保持原顺序，找不到的跳过。
 * 返回 null 表示这一轮已经没题可续（题库被删光或题全被替换）。
 */
export function resumeQuestions<T extends { id: string }>(
  cursor: QuizCursor,
  pool: T[],
): { questions: T[]; idx: number; results: (boolean | null)[] } | null {
  const byId = new Map(pool.map((q) => [q.id, q]));
  const questions: T[] = [];
  const results: (boolean | null)[] = [];
  /** 原下标 → 新下标：跳过缺失题后，续做位置要跟着往前挪，否则会跳题或倒退 */
  let newIdx = 0;
  let seen = 0;
  for (const [oldAt, id] of cursor.qids.entries()) {
    const q = byId.get(id);
    if (!q) continue;
    if (seen < cursor.idx) newIdx += 1;
    questions.push(q);
    // 对错表跟着题目一起搬：跳过的题不占位，否则恢复后第 2 题的分数会显示成第 3 题的
    results.push(cursor.results?.[oldAt] ?? null);
    seen += 1;
  }
  if (questions.length === 0) return null;
  return { questions, idx: Math.min(newIdx, questions.length - 1), results };
}
