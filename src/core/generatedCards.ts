/**
 * 由题目生成的复习卡（目前只有「错题 → 卡片」一条来源）。
 *
 * 为什么不塞进 srsCards：`buildCards` 的输入是笔记正文，卡片键是 `路径#小节`；
 * 错题卡没有笔记路径（`path: ''`），键是 `qbank:<qid>`，两者生命周期完全不同——
 * 笔记改了要重建卡，错题卡不该跟着消失。所以单独存一份，复习时再与笔记卡合并。
 */
import { defineStore } from '../storage/kv';
import type { ReviewCard } from './srsCards';

export interface GeneratedCard extends ReviewCard {
  /** 来源：错题（后续如果要接「AI 生成」，在这里加枚举） */
  source: 'mistake';
  /** 来源题目 ID（与卡片键 `qbank:<qid>` 对应） */
  questionId?: string;
  createdAt: number;
}

const KEY = 'knowlattice-generated-cards';

const isCard = (x: unknown): x is GeneratedCard => {
  const c = x as GeneratedCard;
  return Boolean(
    c
    && typeof c === 'object'
    && typeof c.key === 'string'
    && c.key.trim()
    && typeof c.body === 'string'
    && typeof c.noteTitle === 'string'
    && typeof c.heading === 'string'
    && Array.isArray(c.hints),
  );
};

const store = defineStore<GeneratedCard[]>({
  key: KEY,
  fallback: [],
  decode(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCard).map((c) => ({
      ...c,
      source: 'mistake',
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    }));
  },
});

export function loadGeneratedCards(): GeneratedCard[] {
  return store.read();
}

/** 只补不重：同键卡片已存在时保留已有那张（可能已被用户编辑或已有复习进度）。 */
export function addGeneratedCards(cards: GeneratedCard[]): number {
  const current = loadGeneratedCards();
  const seen = new Set(current.map((c) => c.key));
  const fresh = cards.filter((c) => c.key && !seen.has(c.key));
  if (fresh.length === 0) return 0;
  store.write([...current, ...fresh]);
  return fresh.length;
}

export function removeGeneratedCard(key: string): void {
  const current = loadGeneratedCards();
  const next = current.filter((c) => c.key !== key);
  if (next.length !== current.length) store.write(next);
}

export function exportGeneratedCards(): GeneratedCard[] {
  return loadGeneratedCards();
}

/** 备份恢复：按卡片键去重，本机已有卡片优先。 */
export function importGeneratedCards(incoming: unknown): { added: number; kept: number } {
  if (!Array.isArray(incoming)) return { added: 0, kept: 0 };
  const current = loadGeneratedCards();
  const seen = new Set(current.map((c) => c.key));
  const valid = incoming.filter(isCard);
  const fresh = valid.filter((c) => !seen.has(c.key));
  if (fresh.length > 0) store.write([...current, ...fresh]);
  return { added: fresh.length, kept: valid.length - fresh.length };
}
