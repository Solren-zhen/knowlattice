/**
 * 生词本：一个词一条记录，调度直接复用 srs.ts（ts-fsrs）。
 *
 * 为什么不新写一套复习算法：srs.ts 的调度键是字符串（笔记卡是 `<path>#<小节>`），
 * 生词卡用 `vocab:<词>` 前缀即可共用同一个调度表，两种卡互不干扰
 * （ReviewView 只把笔记卡交给 dueQueue，生词卡只进本模块的队列）。
 *
 * 存的位置与它服务的对象一致：词表是用户自己的一条条记录，不是笔记文件，所以放 localStorage；
 * 释义、来源都可后补——先收词、后整理，是这个功能能被用起来的前提。
 */
import { applyReview, dueQueue, loadCards, type Rating } from './srs';
import type { ReviewCard } from './srsCards';

export const VOCAB_KEY = 'knowlattice-vocab';
/** 一条词最长 80 字：超长的多半是整段误选，收进来只会污染列表 */
const MAX_TERM = 80;

export interface VocabEntry {
  term: string;
  def: string;
  /** 来源：笔记路径或题库名，可空 */
  src?: string;
  addedAt: number;
}

type Store = Record<string, VocabEntry>;

/** 调度键：大小写不敏感，'EGFR' 与 'egfr' 是同一个词 */
export function vocabCardKey(term: string): string {
  return `vocab:${term.trim().toLowerCase()}`;
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(VOCAB_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<VocabEntry> | null;
      if (e && typeof e.term === 'string' && e.term.trim()) {
        out[k] = { term: e.term, def: typeof e.def === 'string' ? e.def : '', src: e.src, addedAt: Number(e.addedAt) || 0 };
      }
    }
    return out;
  } catch {
    // 存储坏掉时当作空表：宁可丢一份词表，也不能让整个生词本打不开
    return {};
  }
}

function saveStore(store: Store): boolean {
  try {
    localStorage.setItem(VOCAB_KEY, JSON.stringify(store));
    return true;
  } catch {
    // 配额满时写入失败：调用方据此提示，不能假装成功（否则用户以为词收进去了）
    return false;
  }
}

/** 全部词条，最近加入的在前 */
export function loadVocab(): VocabEntry[] {
  return Object.values(loadStore()).sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * 备份用：整表导出（键 = `vocab:<小写词>`）。
 *
 * 生词本是用户一个个攒出来的记录，和错题/待办同一性质——不随备份走，
 * 换设备或清一次缓存就全没了。所以必须并进 vault 的整包备份。
 */
export function exportVocabState(): Record<string, VocabEntry> {
  return loadStore();
}

/**
 * 恢复用：**只补不覆盖**。
 * 已经存在的词保留本机释义（用户可能在这台机器上改得更准），只补缺的键。
 */
export function importVocabState(raw: unknown): { added: number; kept: number } {
  if (!raw || typeof raw !== 'object') return { added: 0, kept: 0 };
  const store = loadStore();
  let added = 0;
  let kept = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<VocabEntry> | null;
    if (!e || typeof e.term !== 'string' || !e.term.trim()) continue;
    if (store[k]) { kept += 1; continue; }
    store[k] = {
      term: e.term.trim().slice(0, MAX_TERM),
      def: typeof e.def === 'string' ? e.def : '',
      src: typeof e.src === 'string' ? e.src : undefined,
      addedAt: Number(e.addedAt) || Date.now(),
    };
    added += 1;
  }
  if (added) saveStore(store);
  return { added, kept };
}

/** 收一个词。已存在时只补释义/来源，不覆盖用户已经写好的释义。 */
export function addVocab(term: string, def = '', src?: string): { added: boolean; total: number; ok: boolean } {
  const t = term.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM);
  const store = loadStore();
  const total = Object.keys(store).length;
  if (!t) return { added: false, total, ok: false };
  const key = vocabCardKey(t);
  const prev = store[key];
  if (prev) {
    const next: VocabEntry = {
      ...prev,
      def: def.trim() ? def.trim() : prev.def,
      src: src ?? prev.src,
    };
    const ok = saveStore({ ...store, [key]: next });
    return { added: false, total, ok };
  }
  const ok = saveStore({ ...store, [key]: { term: t, def: def.trim(), src, addedAt: Date.now() } });
  return { added: ok, total: total + (ok ? 1 : 0), ok };
}

export function removeVocab(term: string): void {
  const store = loadStore();
  delete store[vocabCardKey(term)];
  saveStore(store);
}

/**
 * 从一段选中文本里批量收词：按行拆，一行一个词条。
 * 行内的中英对照（`hepatomegaly 肝肿大`、`hepatomegaly——肝肿大`）拆成 term + def 更好用；
 * 拆不出来时整行当词条，释义留空——留给用户自己补，比猜错强。
 */
export function collectFromText(text: string, src?: string): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').trim();
    if (!raw) continue;
    // 先按「明显分隔符」拆（破折号/冒号/制表/两个以上空格）。
    // 没有明显分隔符时，再按「英文词 + 单个空格 + 含中文的解释」拆——
    // 中文用户手打的多半是 `hepatomegaly 肝肿大` 这种单个空格。
    // 左侧用贪婪匹配：`portal vein 门静脉` 要整串当词条，不能拆成 portal / vein 门静脉。
    const m = raw.match(/^(.{1,60}?)\s*(?:——|--|—|：|:|\t|\s{2,})\s*(.{1,80})$/)
      ?? raw.match(/^([A-Za-z][\w\s\-'’./()]{0,59})\s+(.*[\u4e00-\u9fa5].*)$/);
    const term = (m ? m[1] : raw).trim();
    const def = m ? m[2].trim() : '';
    const r = addVocab(term, def, src);
    if (r.ok && (r.added || term)) added += r.added ? 1 : 0;
    if (!r.ok) skipped += 1;
  }
  return { added, skipped };
}

/** 生词卡 → 复习卡的桥：srs 只认 {key, body} 这几项，其余字段给空值即可 */
export function toReviewCard(e: VocabEntry): ReviewCard {
  return {
    key: vocabCardKey(e.term),
    path: '',
    noteTitle: '生词本',
    heading: '',
    body: e.def || '（还没写释义）',
    hints: [],
  };
}

/** 今日要复习的生词：到期优先（按到期时间升序），其余按加入顺序当新词 */
export function vocabDueQueue(entries: VocabEntry[], now = Date.now()): VocabEntry[] {
  const byKey = new Map(entries.map((e) => [vocabCardKey(e.term), e]));
  const cards = dueQueue(entries.map(toReviewCard), now);
  const out: VocabEntry[] = [];
  for (const c of cards) {
    const e = byKey.get(c.key);
    if (e) out.push(e);
  }
  return out;
}

/** 评一档，返回下一次到期时间（毫秒） */
export function rateVocab(e: VocabEntry, rating: Rating, now = Date.now()): number {
  const card = applyReview(toReviewCard(e), rating, now);
  return new Date(card.due).getTime();
}

/** 统计：总数 / 已进入调度（复习过至少一次）/ 现在到期 */
export function vocabStats(entries: VocabEntry[], now = Date.now()): { total: number; learned: number; dueNow: number } {
  const cards = loadCards();
  let learned = 0;
  let dueNow = 0;
  for (const e of entries) {
    const c = cards[vocabCardKey(e.term)];
    if (!c) continue;
    learned += 1;
    if (new Date(c.due).getTime() <= now) dueNow += 1;
  }
  return { total: entries.length, learned, dueNow };
}
