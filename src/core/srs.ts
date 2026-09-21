/**
 * M6 · 间隔复习（SRS）：改用 ts-fsrs（MIT，FSRS 算法）。
 * 调度状态存 localStorage（轻量、无需后端）；笔记内容本身仍在 vault。
 * 对外保持旧 API 形状（applyReview/dueQueue/srsStats/export/import），
 * 底层 Card 为 ts-fsrs 类型（含 stability/difficulty/state 等）。
 *
 * M6+ · 粒度改成「按小节」：调度键不再是笔记路径，而是 core/srsCards.ts 建出来的卡键
 * （`<path>#<小节标题>`）。旧数据是「一篇一卡」的 `<path>` 键，两种键在同一张表里共存：
 * 没有小节的笔记仍用 `<path>`（同键，零迁移）；有小节的笔记由首张卡继承旧调度
 * （见 scheduleOf / applyReview），不会因为改粒度而把进度清零。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating as FSRSRating, type Card } from 'ts-fsrs';
import type { ReviewCard } from './srsCards';

export type Rating = 'again' | 'hard' | 'good' | 'easy';

const f = fsrs(generatorParameters());

const KEY = 'knowlattice-srs';

/**
 * 模块级缓存：复习界面每次渲染都会读卡（stats/当前卡），避免反复 JSON.parse 整个库。
 * 缓存**按 localStorage 原始字符串**比对：外部直接写存储（另一个标签页、备份导入、
 * 测试里 clear）时下一次读会自己失效重解析，不会拿着旧调度算出错的复习队列。
 */
let cacheRaw: string | null = null;
let cache: Record<string, Card> = {};

export function loadCards(): Record<string, Card> {
  let rawStr: string;
  try {
    rawStr = localStorage.getItem(KEY) ?? '{}';
  } catch {
    return cache;
  }
  if (rawStr === cacheRaw) return cache;
  try {
    const raw = JSON.parse(rawStr) as Record<string, unknown>;
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
  } catch {
    cache = {};
  }
  cacheRaw = rawStr;
  return cache;
}

function save(cards: Record<string, Card>) {
  cache = cards;
  cacheRaw = JSON.stringify(cards);
  localStorage.setItem(KEY, cacheRaw);
}

const RATE_MAP: Record<Rating, FSRSRating> = {
  again: FSRSRating.Again,
  hard: FSRSRating.Hard,
  good: FSRSRating.Good,
  easy: FSRSRating.Easy,
};

const dueMs = (c: Card) => new Date(c.due).getTime();

/**
 * 一张卡当前的调度状态：自己的键优先；还没有就继承该篇旧的「整篇卡」调度（迁移期）。
 * 这是「改粒度不丢进度」的关键——旧表里 `path` 那条记录仍然算数，直到这张卡被首次评分。
 */
export function scheduleOf(schedules: Record<string, Card>, card: ReviewCard): Card | undefined {
  return schedules[card.key] ?? (card.legacyKey ? schedules[card.legacyKey] : undefined);
}

/** 给定卡片按 rating 提交，写入调度状态并返回新卡 */
export function applyReview(card: ReviewCard, rating: Rating, now = Date.now()): Card {
  const cards = loadCards();
  // 显式标注：createEmptyCard 是泛型（R = Card），在 ?? 右侧会被推成 Card | undefined
  const cur: Card = scheduleOf(cards, card) ?? createEmptyCard(now);
  const next = f.next(cur, new Date(now), RATE_MAP[rating] as never).card;
  cards[card.key] = next;
  // 旧「整篇卡」的调度已经落到这张卡上 → 删掉旧键，避免下次再继承一遍（迁移只发生一次）
  if (card.legacyKey && card.legacyKey !== card.key) delete cards[card.legacyKey];
  save(cards);
  return next;
}

/** 今日到期队列：due <= 现在 的卡片优先（按到期时间升序），其余按笔记顺序补齐为新卡 */
export function dueQueue(cardsIn: ReviewCard[], now = Date.now()): ReviewCard[] {
  const cards = loadCards();
  const due: ReviewCard[] = [];
  const newOnes: ReviewCard[] = [];
  for (const c of cardsIn) {
    const s = scheduleOf(cards, c);
    if (!s) newOnes.push(c);
    else if (dueMs(s) <= now) due.push(c);
  }
  due.sort((a, b) => dueMs(scheduleOf(cards, a)!) - dueMs(scheduleOf(cards, b)!));
  return [...due, ...newOnes];
}

/** 统计信息：total/learned/dueNow 都是**卡片**数（一篇笔记可能贡献多张） */
export function srsStats(cardsIn: ReviewCard[], now = Date.now()) {
  const cards = loadCards();
  let learned = 0;
  let dueNow = 0;
  for (const c of cardsIn) {
    const s = scheduleOf(cards, c);
    if (!s) continue;
    learned++;
    if (dueMs(s) <= now) dueNow++;
  }
  return { total: cardsIn.length, learned, dueNow };
}

/**
 * 某篇笔记的复习概况（左侧状态行用）：已排程几张 / 共几张 / 最紧的那张卡。
 * 一篇笔记切成多张后，「这篇什么时候该复习」= 它所有小节卡里最早到期的那个。
 */
export function noteStatus(cardsIn: ReviewCard[], path: string, now = Date.now()) {
  const schedules = loadCards();
  const mine = cardsIn.filter((c) => c.path === path);
  let learned = 0;
  let soonest: Card | null = null;
  for (const c of mine) {
    const s = scheduleOf(schedules, c);
    if (!s) continue;
    learned++;
    if (!soonest || dueMs(s) < dueMs(soonest)) soonest = s;
  }
  return { total: mine.length, learned, dueNow: soonest ? dueMs(soonest) <= now : false, card: soonest };
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
