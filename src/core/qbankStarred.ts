/**
 * 收藏 / 重点题：用户手动标星的「这题我得再看」。
 *
 * 为什么与逐题统计（core/qbankStats）分开存：
 *   qbankStats 的每一项都是「作答过」的副产物（FSRS 排程 + 错题计数），
 *   而收藏是**用户主动**的动作，和「做没做过」正交——一道从没做过的新题
 *   也应该能被标成重点。把它塞进 QStat 会逼出「没答过也得先造一条 FSRS 记录」
 *   这种假数据，还会随「清空题库记录」被一起抹掉。
 *
 * 存储：与题库同一个 IndexedDB（storage/qbank 的 stars 仓库），keyPath = (bank, qid)。
 *   只存「被标了」这一事实，不存值；模块级加一层运行时缓存，挂载时异步刷新，
 *   与 qbankStats 的 cache 是同一套读法（组题时不必 await 存储）。
 *   值恒为 true，StarMap 用 Record<bank, Record<qid, true>>。
 */
import {
  getAllStars, putStar, removeBankStars, removeStar, replaceStars, type StoredStar,
} from '../storage/qbank';

/** 题库名 → qid → true */
export type StarMap = Record<string, Record<string, true>>;

let cache: StarMap = {};
let initialized = false;

export async function initializeStars(): Promise<StarMap> {
  const out: StarMap = {};
  for (const { bank, qid } of await getAllStars()) {
    (out[bank] ??= {})[qid] = true;
  }
  cache = out;
  initialized = true;
  return cache;
}

export function loadStars(): StarMap {
  return cache;
}

export function resetStarsForTests(): void {
  cache = {};
  initialized = false;
}

export function isStarred(stars: StarMap, bank: string, qid: string): boolean {
  return stars[bank]?.[qid] === true;
}

/** 某题库被收藏的题数（题库列表上显示「收藏 N」） */
export function starCount(stars: StarMap, bank: string): number {
  return Object.keys(stars[bank] ?? {}).length;
}

/**
 * 切换某题的收藏状态，返回切换后的状态（true = 现在已收藏）。
 * 内存先行、存储后写：即使落盘失败（配额/权限），本轮界面仍能反映点击结果。
 */
export async function toggleStar(bank: string, qid: string): Promise<boolean> {
  const stars = initialized ? cache : await initializeStars();
  const on = !isStarred(stars, bank, qid);
  const per = { ...(stars[bank] ?? {}) };
  if (on) per[qid] = true;
  else delete per[qid];
  cache = { ...stars, [bank]: per };
  try {
    if (on) await putStar({ bank, qid });
    else await removeStar(bank, qid);
  } catch {
    // 写失败只影响持久化；下次 initializeStars 会以存储为准重新加载。
  }
  return on;
}

/** 幂等地把某题设为收藏 / 取消收藏（已是目标状态就不动存储）。 */
export async function setStar(bank: string, qid: string, on: boolean): Promise<void> {
  const stars = initialized ? cache : await initializeStars();
  if (isStarred(stars, bank, qid) === on) return;
  await toggleStar(bank, qid);
}

/** 清空某个题库的收藏（题库删掉时一并清，别留孤儿数据占配额）。 */
export async function dropBankStars(bank: string, persist = true): Promise<void> {
  if (!initialized) await initializeStars();
  if (persist) await removeBankStars(bank);
  const next = { ...cache };
  delete next[bank];
  cache = next;
}

export async function exportStars(): Promise<StarMap> {
  return initialized ? cache : initializeStars();
}

/** 从备份恢复（只增不减：备份里标了的题在本地也标上，本地已标的保留）。 */
export async function importStars(state: unknown): Promise<void> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  if (!initialized) await initializeStars();
  const merged: StarMap = { ...cache };
  for (const [bank, questions] of Object.entries(state as Record<string, unknown>)) {
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) continue;
    const per: Record<string, true> = { ...(merged[bank] ?? {}) };
    for (const qid of Object.keys(questions as Record<string, unknown>)) per[qid] = true;
    merged[bank] = per;
  }
  const packed: StoredStar[] = Object.entries(merged).flatMap(([bank, per]) =>
    Object.keys(per).map((qid) => ({ bank, qid })),
  );
  await replaceStars(packed);
  cache = merged;
  initialized = true;
}
