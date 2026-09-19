/**
 * M6 · 间隔复习（SRS）：改用 ts-fsrs（MIT，FSRS 算法）。
 * 调度状态存 localStorage（轻量、无需后端）；笔记内容本身仍在 vault。
 * 对外保持旧 API 形状（applyReview/dueQueue/srsStats/export/import），
 * 底层 Card 为 ts-fsrs 类型（含 stability/difficulty/state 等）。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating as FSRSRating, type Card } from 'ts-fsrs';

export type Rating = 'again' | 'hard' | 'good' | 'easy';

const f = fsrs(generatorParameters());

const KEY = 'knowlattice-srs';

/** 模块级缓存：复习界面每次渲染都会读卡（stats/当前卡），避免反复 JSON.parse 整个库 */
let cache: Record<string, Card> | null = null;

export function loadCards(): Record<string, Card> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, Card> = {};
    for (const [k, v] of Object.entries(raw)) {
      const c = v as Partial<Card> | null;
      // 仅接受 ts-fsrs 格式的卡；旧版 SM-2 数据自动丢弃，下次按新卡处理
      if (
        c &&
        typeof c.due !== 'undefined' &&
        typeof c.reps === 'number' &&
        typeof c.stability === 'number' &&
        typeof c.difficulty === 'number' &&
        typeof c.state === 'number'
      ) {
        out[k] = c as Card;
      }
    }
    cache = out;
    return out;
  } catch {
    cache = {};
    return cache;
  }
}

function save(cards: Record<string, Card>) {
  cache = cards;
  localStorage.setItem(KEY, JSON.stringify(cards));
}

const RATE_MAP: Record<Rating, FSRSRating> = {
  again: FSRSRating.Again,
  hard: FSRSRating.Hard,
  good: FSRSRating.Good,
  easy: FSRSRating.Easy,
};

const dueMs = (c: Card) => new Date(c.due).getTime();

/** 给定卡片按 rating 提交，写入调度状态并返回新卡 */
export function applyReview(path: string, rating: Rating, now = Date.now()): Card {
  const cards = loadCards();
  const cur = cards[path] ?? createEmptyCard(now);
  const next = f.next(cur, new Date(now), RATE_MAP[rating] as never).card;
  cards[path] = next;
  save(cards);
  return next;
}

/** 今日到期队列：due <= 现在 的卡片优先，其余按创建顺序补齐为新卡 */
export function dueQueue(paths: string[], now = Date.now()): string[] {
  const cards = loadCards();
  const due: string[] = [];
  const newOnes: string[] = [];
  for (const p of paths) {
    const c = cards[p];
    if (!c) newOnes.push(p);
    else if (dueMs(c) <= now) due.push(p);
  }
  due.sort((a, b) => dueMs(cards[a]) - dueMs(cards[b]));
  return [...due, ...newOnes];
}

/** 统计信息 */
export function srsStats(paths: string[], now = Date.now()) {
  const cards = loadCards();
  let learned = 0;
  let dueNow = 0;
  for (const p of paths) {
    const c = cards[p];
    if (!c) continue;
    learned++;
    if (dueMs(c) <= now) dueNow++;
  }
  return { total: paths.length, learned, dueNow };
}

/** 导出全部调度状态（随备份文件保存） */
export function exportSrsState(): Record<string, Card> {
  return loadCards();
}

/** 导出复习调度状态为 JSON 字符串（供「导出复习数据」按钮下载） */
export function exportSrsJson(): string {
  return JSON.stringify(loadCards());
}

/** 从 .json 文本导入复习调度：支持整包备份（自动取 .srs 字段）或单独的复习状态对象；返回恢复条数 */
export function importSrsFromJson(text: string): number {
  const data = JSON.parse(text) as unknown;
  const state = data && typeof data === 'object' && (data as { srs?: unknown }).srs
    ? (data as { srs: unknown }).srs
    : data;
  return importSrsState(state);
}

/** 从备份恢复调度状态（合并模式）；返回恢复条数，格式无效抛错 */
export function importSrsState(state: unknown): number {
  if (!state || typeof state !== 'object') throw new Error('备份中的复习数据格式无效');
  const cards = loadCards();
  let n = 0;
  for (const [path, raw] of Object.entries(state as Record<string, unknown>)) {
    const v = raw as Partial<Card> | null;
    // ts-fsrs 的 due 是 Date，JSON 序列化后为字符串（可为时间戳 number 或 ISO 字符串），两种都接受
    if (!v || (typeof v.due !== 'number' && typeof v.due !== 'string') || typeof v.reps !== 'number' || v.state === undefined) continue;
    cards[path] = v as Card;
    n++;
  }
  save(cards);
  return n;
}
