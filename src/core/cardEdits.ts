/**
 * M6++ · 卡片自定义：改写正/背面、删除卡片——都**独立于笔记内容之外**。
 *
 * 为什么单独存：复习卡是从笔记正文切出来的派生数据（core/srsCards.ts）。如果「改一张卡」
 * 直接改笔记，就等于让复习顺手改掉原始笔记——这是两件事。所以覆盖值按**卡键**存
 * localStorage：笔记正文怎么改都不影响你的自定义；删掉覆盖就回到笔记原文。
 *
 * 与调度状态（core/srs.ts）分开存：调度记的是「学到什么程度」，这里记的是「这张卡长什么样」。
 * 两者都随整包备份走（vault.ts 的 cardEdits 字段，v4 起），换设备不丢。
 *
 * 已知边界：卡键 = `<路径>#<小节标题>`，所以**改笔记里的小节标题**等于换了一张卡，
 * 原自定义会变成孤儿（仍留在存储里，不会被清掉）。正文随便改，键不变。
 */
import type { ReviewCard } from './srsCards';

export interface CardEdit {
  /** 自定义正面（问题）；空 = 用笔记原文 */
  front?: string;
  /** 自定义背面（答案）；空 = 用笔记原文 */
  back?: string;
  /** 已删除：不再进复习队列（笔记本身不动） */
  deleted?: boolean;
  updatedAt: number;
}

export type CardEditMap = Record<string, CardEdit>;

const KEY = 'knowlattice-card-edits';

/**
 * 模块级缓存：复习界面每次渲染都会读。缓存**按 localStorage 原始字符串**比对，
 * 而不是「第一次读到就永远用它」——外部直接写存储（另一个标签页、备份导入、
 * 测试里 clear）时，下一次读会自己失效重解析，不会读到脏缓存。
 */
let cacheRaw: string | null = null;
let cache: CardEditMap = {};

export function loadCardEdits(): CardEditMap {
  let raw: string;
  try {
    raw = localStorage.getItem(KEY) ?? '{}';
  } catch {
    return cache;
  }
  if (raw === cacheRaw) return cache;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: CardEditMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as Partial<CardEdit> | null;
      if (!e || typeof e !== 'object') continue;
      const front = typeof e.front === 'string' ? e.front : undefined;
      const back = typeof e.back === 'string' ? e.back : undefined;
      const deleted = e.deleted === true ? true : undefined;
      if (!front && !back && !deleted) continue;
      out[k] = { ...(front ? { front } : {}), ...(back ? { back } : {}), ...(deleted ? { deleted } : {}), updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 };
    }
    cache = out;
  } catch {
    cache = {};
  }
  cacheRaw = raw;
  return cache;
}

function save(map: CardEditMap) {
  cache = map;
  cacheRaw = JSON.stringify(map);
  localStorage.setItem(KEY, cacheRaw);
}

/**
 * 写入一张卡的自定义正/背面。空字符串表示「这一面回到笔记原文」；
 * 两面都空且没被删除时，整条记录删掉（不留空壳）。
 *
 * 一律返回**新对象**：视图把它放进 React state，原地改再返回同一引用会被判定为
 * 「没变化」而不重渲染——存储对了、界面不动，是最难查的一类假成功。
 */
export function saveCardEdit(key: string, patch: { front?: string; back?: string }, now = Date.now()): CardEditMap {
  const prev = loadCardEdits()[key];
  const front = (patch.front ?? '').trim();
  const back = (patch.back ?? '').trim();
  const deleted = prev?.deleted;
  const map: CardEditMap = { ...loadCardEdits() };
  if (!front && !back && !deleted) delete map[key];
  else map[key] = { ...(front ? { front } : {}), ...(back ? { back } : {}), ...(deleted ? { deleted } : {}), updatedAt: now };
  save(map);
  return map;
}

/** 删除卡片：不进复习队列，但笔记与调度状态都留着（恢复即回到原样） */
export function deleteCard(key: string, now = Date.now()): CardEditMap {
  const prev = loadCardEdits()[key];
  const map: CardEditMap = { ...loadCardEdits() };
  map[key] = { ...(prev?.front ? { front: prev.front } : {}), ...(prev?.back ? { back: prev.back } : {}), deleted: true, updatedAt: now };
  save(map);
  return map;
}

/** 恢复被删的卡片；没有自定义正/背面时整条记录清掉 */
export function restoreCard(key: string): CardEditMap {
  const prev = loadCardEdits()[key];
  if (!prev) return loadCardEdits();
  const map: CardEditMap = { ...loadCardEdits() };
  if (!prev.front && !prev.back) delete map[key];
  else map[key] = { front: prev.front, back: prev.back, updatedAt: prev.updatedAt } as CardEdit;
  save(map);
  return map;
}

/** 导出全部自定义（随整包备份走） */
export function exportCardEdits(): CardEditMap {
  return { ...loadCardEdits() };
}

/** 从备份恢复（合并模式：同键覆盖）；返回恢复条数 */
export function importCardEdits(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const map: CardEditMap = { ...loadCardEdits() };
  let n = 0;
  for (const [k, raw] of Object.entries(state as Record<string, unknown>)) {
    const e = raw as Partial<CardEdit> | null;
    if (!e || typeof e !== 'object') continue;
    const front = typeof e.front === 'string' && e.front.trim() ? e.front : undefined;
    const back = typeof e.back === 'string' && e.back.trim() ? e.back : undefined;
    const deleted = e.deleted === true ? true : undefined;
    if (!front && !back && !deleted) continue;
    map[k] = { ...(front ? { front } : {}), ...(back ? { back } : {}), ...(deleted ? { deleted } : {}), updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 };
    n++;
  }
  save(map);
  return n;
}

/**
 * 把自定义套到建好的卡上（纯函数）：改写正/背面，并剔除已删除的卡。
 * 正/背面为空时保持笔记原文——「清空输入框」就等于「回到原文」，不需要额外按钮。
 */
export function applyCardEdits(cards: ReviewCard[], edits: CardEditMap): ReviewCard[] {
  const out: ReviewCard[] = [];
  for (const c of cards) {
    const e = edits[c.key];
    if (e?.deleted) continue;
    if (!e) {
      out.push(c);
      continue;
    }
    out.push({
      ...c,
      front: e.front?.trim() ? e.front : undefined,
      back: e.back?.trim() ? e.back : undefined,
    });
  }
  return out;
}

/** 已删除的卡键（供「已删卡片」列表恢复用） */
export function deletedKeys(edits: CardEditMap): string[] {
  return Object.entries(edits)
    .filter(([, e]) => e.deleted)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([k]) => k);
}
