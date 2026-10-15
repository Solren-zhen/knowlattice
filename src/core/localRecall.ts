/**
 * 本地速查：已经回答过的问题连同答案存在本地，下次同样的问题可以**直接复用、不调模型**。
 *
 * 借鉴点：第三方备考工具的助记口诀生成是「先按关键词匹配本地自定义库 → 再匹配官方内置库 →
 * 命中就直接用，匹配不到才由 AI 现场生成」，并且明确告诉用户
 * 「在这里加的口诀只存在你这台设备上」。本项目此前**没有任何**「先查本地、命中就不调模型」
 * 的短路（侦察确认：每个回合都会打到模型，已有缓存全是性能缓存而不是答案复用），
 * 于是同一个问题问第二遍仍然全价重算，且两次回答可能互相矛盾。
 *
 * 为什么**不静默复用**：缓存会过期（笔记改了、教材换了、上一轮回答本身可能不准）。
 * 静默返回旧答案会让用户以为模型又答了一遍、却看不到差异 —— 属于"看起来成功"的假象，
 * 事后最难归因。所以本模块只提供数据能力，是否复用由界面显式呈现
 * （输入框上方给「复用上次答案 / 重新生成」，由用户决定）。
 *
 * 存储：localStorage 单键，与 core/cardEdits.ts 同一套缓存纪律
 * （按原始字符串比对，外部写存储后下次读自动失效）。
 */

export interface RecallEntry {
  /** 归一化后的问题（也是存储键） */
  q: string;
  /** 用户可读的原始问题 */
  raw: string;
  /** 上次的答案（Markdown 原文） */
  a: string;
  /** 上次回答时间戳 */
  at: number;
  /** 被复用次数 */
  hits: number;
}

export type RecallMap = Record<string, RecallEntry>;

const KEY = 'knowlattice-local-recall';

/** 单条答案长度上限：再长就不适合当"速查"，且会撑大 localStorage */
const MAX_ANSWER_LEN = 20_000;
/** 最多保留多少条（LRU 淘汰，按 at 倒序保留） */
export const MAX_RECALL_ENTRIES = 300;

/**
 * 问题归一化：全角转半角（NFKC）、折叠空白、去首尾、小写。
 * 目的只是让"同一句话的排版差异"命中同一条，不做语义归一 ——
 * 语义相近但不同的问题不该复用同一份答案，那属于猜。
 */
export function normalizeQuestion(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

let cacheRaw: string | null = null;
let cache: RecallMap = {};

export function loadRecall(): RecallMap {
  let raw: string;
  try {
    raw = localStorage.getItem(KEY) ?? '{}';
  } catch {
    return cache;
  }
  if (raw === cacheRaw) return cache;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: RecallMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as Partial<RecallEntry> | null;
      if (!e || typeof e !== 'object') continue;
      if (typeof e.a !== 'string' || !e.a.trim()) continue;
      out[k] = {
        q: k,
        raw: typeof e.raw === 'string' && e.raw ? e.raw : k,
        a: e.a,
        at: typeof e.at === 'number' ? e.at : 0,
        hits: typeof e.hits === 'number' && e.hits >= 0 ? Math.floor(e.hits) : 0,
      };
    }
    cache = out;
  } catch {
    cache = {};
  }
  cacheRaw = raw;
  return cache;
}

function save(map: RecallMap): void {
  cache = map;
  cacheRaw = JSON.stringify(map);
  try {
    localStorage.setItem(KEY, cacheRaw);
  } catch {
    // 隐私模式 / 配额耗尽：写不进去也不能让上层的恢复/导入流程中途中断。
    // 内存缓存（上面的 cache / cacheRaw）已经更新，本次会话内读写口径仍然一致。
  }
}

/** 命中一条历史答案；没有则返回 null */
export function lookupRecall(question: string): RecallEntry | null {
  const q = normalizeQuestion(question);
  if (!q) return null;
  return loadRecall()[q] ?? null;
}

/**
 * 写入/覆盖一条答案。空问题或空答案不写（避免留下无意义的空记录）。
 * 超过上限时按时间淘汰最旧的，防止 localStorage 无限增长。
 */
export function saveRecall(question: string, answer: string, now = Date.now()): RecallMap {
  const q = normalizeQuestion(question);
  const a = (answer ?? '').trim();
  if (!q || !a) return loadRecall();
  const map: RecallMap = { ...loadRecall() };
  const prev = map[q];
  map[q] = {
    q,
    raw: question.trim(),
    a: a.length > MAX_ANSWER_LEN ? `${a.slice(0, MAX_ANSWER_LEN)}\n\n…（过长已截断）` : a,
    at: now,
    hits: prev?.hits ?? 0,
  };
  const keys = Object.keys(map);
  if (keys.length > MAX_RECALL_ENTRIES) {
    keys
      .sort((x, y) => map[x].at - map[y].at)
      .slice(0, keys.length - MAX_RECALL_ENTRIES)
      .forEach((k) => delete map[k]);
  }
  save(map);
  return map;
}

/** 复用一次：计数 +1（用于界面上显示"已复用 N 次"，让用户知道这份答案的可信度来源） */
export function bumpRecallHits(question: string, now = Date.now()): RecallMap {
  const q = normalizeQuestion(question);
  const map: RecallMap = { ...loadRecall() };
  if (!map[q]) return map;
  map[q] = { ...map[q], hits: map[q].hits + 1, at: map[q].at || now };
  save(map);
  return map;
}

export function removeRecall(question: string): RecallMap {
  const q = normalizeQuestion(question);
  const map: RecallMap = { ...loadRecall() };
  if (!map[q]) return map;
  delete map[q];
  save(map);
  return map;
}

export function clearRecall(): RecallMap {
  save({});
  return cache;
}

export function recallCount(): number {
  return Object.keys(loadRecall()).length;
}

export function exportRecall(): RecallMap {
  return { ...loadRecall() };
}

/** 从备份恢复（合并模式：同问题覆盖，保留较大 hits）；返回恢复条数 */
export function importRecall(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const map: RecallMap = { ...loadRecall() };
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<RecallEntry> | null;
    if (!e || typeof e !== 'object') continue;
    if (typeof e.a !== 'string' || !e.a.trim()) continue;
    const prev = map[k];
    map[k] = {
      q: k,
      raw: typeof e.raw === 'string' && e.raw ? e.raw : k,
      a: e.a,
      at: typeof e.at === 'number' ? e.at : 0,
      hits: Math.max(prev?.hits ?? 0, typeof e.hits === 'number' && e.hits >= 0 ? Math.floor(e.hits) : 0),
    };
    n++;
  }
  save(map);
  return n;
}
