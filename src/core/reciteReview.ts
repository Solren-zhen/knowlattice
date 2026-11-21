/**
 * 手机回传的复习事件（knowlattice.review/1）→ 桌面单词工坊的 FSRS 记录。
 *
 * 手机端每次回传的是**全部事件**，不是增量，所以这里必须按事件 id 去重：
 * 同一份 `.klrev` 重发、或同一次局域网同步重复点击，都不能让 `right/wrong`
 * 再涨一遍。去重台账单独存一个 localStorage 键，和练习记录分开，
 * 清空练习记录时也不会误删「哪些事件已经合并过」。
 *
 * 合并策略：
 * - 事件按 `at`、`id` 排序后逐条套用 `nextRecord`，与手机端重放顺序一致；
 * - 事件时间早于该词现有 `lastReview` 的，说明桌面之后已经复习过，直接跳过
 *   （标记为已处理），避免用旧状态覆盖新调度；
 * - 已处理 id 只保留最近 MAX_APPLIED_EVENTS 条；即使台账被截断，
 *   `lastReview` 这一层仍会拦住绝大多数重放。
 */
import { defineStore } from '../storage/kv';
import {
  loadRecords,
  nextRecord,
  normWord,
  RECORDS_UPDATED_EVENT,
  saveRecords,
  type WordRecord,
} from './wordDrill';

export interface RemoteReviewEvent {
  id: string;
  word: string;
  correct: boolean;
  at: number;
  device: string;
}

export interface RemoteReviewDelta {
  schema: 'knowlattice.review/1';
  device: string;
  events: RemoteReviewEvent[];
}

export interface ApplyReviewResult {
  /** 实际写入记录的事件数 */
  added: number;
  /** 已处理过、或早于本机 lastReview 而跳过的事件数 */
  skipped: number;
  /** 本次被更新到的词（去重） */
  words: string[];
}

/** 台账上限：约 50k 个 UUID ≈ 1.8 MB，仍低于 localStorage 常见 5 MB 配额。 */
export const MAX_APPLIED_EVENTS = 50_000;
const MAX_EVENTS_PER_PACK = 20_000;

const appliedStore = defineStore<string[]>({
  key: 'knowlattice-recite-review',
  fallback: [],
  decode: (raw, fallback) => {
    if (!Array.isArray(raw)) return fallback;
    return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** 失败关闭：认不出的事件直接丢弃，不让坏包污染练习记录。 */
export function parseReviewDelta(raw: unknown): RemoteReviewDelta {
  if (!isObject(raw)) throw new Error('回传内容不是复习记录。');
  if (raw.schema !== 'knowlattice.review/1') {
    throw new Error(`不支持的复习记录版本：${String(raw.schema)}`);
  }
  if (!Array.isArray(raw.events)) throw new Error('复习记录缺少 events 数组。');
  if (raw.events.length > MAX_EVENTS_PER_PACK) throw new Error('回传的复习事件过多。');

  const seen = new Set<string>();
  const events: RemoteReviewEvent[] = [];
  // 手机时钟跑快时，未来时间会把 due 推到几年后；允许 5 分钟漂移，再往后按当前时间截断。
  const maxAt = Date.now() + 5 * 60_000;
  for (const item of raw.events) {
    if (!isObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const word = typeof item.word === 'string' ? item.word.trim() : '';
    const at = Number(item.at);
    if (!id || !word || !Number.isFinite(at) || at <= 0) continue;
    if (typeof item.correct !== 'boolean' || seen.has(id)) continue;
    seen.add(id);
    events.push({
      id,
      word,
      correct: item.correct,
      at: Math.min(Math.floor(at), maxAt),
      device: typeof item.device === 'string' ? item.device : '',
    });
  }
  return {
    schema: 'knowlattice.review/1',
    device: typeof raw.device === 'string' ? raw.device : '',
    events,
  };
}

/** 把回传事件合并进单词工坊记录；返回本次真实新增与跳过数。 */
export function applyReviewDelta(raw: unknown): ApplyReviewResult {
  const delta = parseReviewDelta(raw);
  const applied = new Set(appliedStore.read());
  const records: Record<string, WordRecord> = { ...loadRecords() };
  const touched = new Set<string>();
  let added = 0;
  let skipped = 0;

  const pending = delta.events
    .filter((event) => !applied.has(event.id))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  for (const event of pending) {
    const key = normWord(event.word);
    if (!key) continue;
    applied.add(event.id);
    const current = records[key];
    if (current && event.at <= (current.lastReview || 0)) {
      skipped += 1;
      continue;
    }
    records[key] = nextRecord(current, event.word, event.correct, event.at);
    touched.add(current?.en || event.word);
    added += 1;
  }

  if (added > 0) {
    saveRecords(records);
    // 已打开的单词工坊要立刻看到新记录；否则面板显示成功、队列却还是旧的。
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(RECORDS_UPDATED_EVENT));
    }
  }
  const ids = [...applied];
  appliedStore.write(ids.length > MAX_APPLIED_EVENTS ? ids.slice(-MAX_APPLIED_EVENTS) : ids);
  return { added, skipped, words: [...touched] };
}

export function clearAppliedReviews(): void {
  appliedStore.clear();
}
