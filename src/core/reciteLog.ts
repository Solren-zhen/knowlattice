/**
 * 背诵留痕：每结束一轮「背诵」，记一条「哪篇 / 共几条挖空 / 揭开几条 / 用了多久」。
 *
 * 为什么需要它：背诵模式此前只改渲染（遮住、揭开），背完什么都不留 ——
 * 用户第二天既看不到「昨天背过这篇」，也判断不出自己是不是越来越快。
 * 这里只记事实，不碰 FSRS 调度：评分应该由复习面板里的显式操作产生，
 * 让「点了 8 次揭晓」去改调度，等于用猜测污染用户的复习节奏。
 *
 * 存储沿用 `storage/kv` 的 defineStore：坏 JSON、隐私模式、字段漂移都在这一层收敛，
 * 不在这里重复写 try/catch。
 */
import { defineStore } from '../storage/kv';

export interface ReciteSession {
  /** 笔记路径（vault 相对路径） */
  path: string;
  /** 本轮该篇的挖空总数 */
  total: number;
  /** 本轮被揭开过的条数（同一去重：同一条反复点只算一次） */
  revealed: number;
  /** 本轮时长（毫秒） */
  ms: number;
  /** 结束时间戳 */
  at: number;
}

/** 只保留最近这么多轮，防止长期使用把 localStorage 撑爆 */
export const MAX_RECITE_SESSIONS = 300;

/** 一次会话最长计入 6 小时：开着页面去吃饭不该被算成「背了 9 小时」 */
export const MAX_RECITE_MS = 6 * 3600_000;

export function sanitizeReciteLog(raw: unknown, fallback: ReciteSession[] = []): ReciteSession[] {
  if (!Array.isArray(raw)) return fallback;
  const out: ReciteSession[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const s = v as Partial<ReciteSession>;
    if (typeof s.path !== 'string' || !s.path) continue;
    const total = Number(s.total);
    const revealed = Number(s.revealed);
    const ms = Number(s.ms);
    const at = Number(s.at);
    if (![total, revealed, ms, at].every(Number.isFinite)) continue;
    out.push({
      path: s.path,
      total: Math.max(0, Math.floor(total)),
      revealed: Math.max(0, Math.floor(revealed)),
      ms: Math.max(0, Math.min(MAX_RECITE_MS, Math.floor(ms))),
      at: Math.floor(at),
    });
    if (out.length >= MAX_RECITE_SESSIONS) break;
  }
  return out;
}

const store = defineStore<ReciteSession[]>({
  key: 'knowlattice-recite-log',
  fallback: [],
  decode: (raw, fallback) => sanitizeReciteLog(raw, fallback),
});

/** 全部记录（新的在前） */
export function reciteLog(): ReciteSession[] {
  return store.read();
}

/** 记一轮；返回写入后的列表（新的在前，已截断） */
export function recordRecite(session: ReciteSession): ReciteSession[] {
  const clean = sanitizeReciteLog([session])[0];
  if (!clean) return store.read();
  const next = [clean, ...store.read()].slice(0, MAX_RECITE_SESSIONS);
  store.write(next);
  return next;
}

/** 某篇笔记最近一次背诵；没有则 null */
export function lastReciteOf(path: string): ReciteSession | null {
  if (!path) return null;
  return store.read().find((s) => s.path === path) ?? null;
}

/** 某篇笔记累计背过几轮 */
export function reciteCountOf(path: string): number {
  if (!path) return 0;
  return store.read().filter((s) => s.path === path).length;
}

export function clearReciteLog(): void {
  store.clear();
}
