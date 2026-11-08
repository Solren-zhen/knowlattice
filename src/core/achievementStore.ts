/**
 * 成就的持久化与同步。
 *
 * `achievementSystem.ts` 是纯函数层（给统计、返回结果，不碰存储）；
 * 这里负责把它接到 localStorage 上，并算出界面要用的汇总。
 *
 * 存储策略：整份 `Achievement[]` 存 JSON。看起来比「只存 id → 时间」占地方，
 * 但换来两件事：类型上不需要 cast，以及 `checkAchievements` 需要的
 * `unlocked` / `unlockedAt` 两个字段都在。**名称与描述不会因此变旧** ——
 * `checkAchievements` 每次都从 `defineAchievements()` 取新定义，只把
 * `unlocked` / `unlockedAt` 从旧记录里搬过来，所以改文案不需要数据迁移。
 */

import {
  checkAchievements,
  getAchievementSummary,
  getNearbyAchievements,
  type Achievement,
  type LearningStats,
} from './achievementSystem';

const KEY = 'knowlattice-achievements';

/** 读出上次落盘的成就（没有或损坏时返回空数组 = 一切从零开始检查） */
export function loadAchievements(): Achievement[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // 只保留长得像成就的记录；字段不全的丢掉，宁可重算
    return raw.filter(
      (a): a is Achievement =>
        !!a && typeof a === 'object' && typeof (a as Achievement).id === 'string',
    );
  } catch {
    return [];
  }
}

function saveAchievements(list: Achievement[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 配额满 / 隐私模式：成就不落盘也不该让界面崩，下次打开重算即可
  }
}

export interface AchievementState {
  /** 全部成就（含未解锁的，带 progress） */
  achievements: Achievement[];
  /** 本次新解锁的（已落盘，重复调用同一份 stats 第二次就是空） */
  newlyUnlocked: Achievement[];
  /** 汇总：已解锁数 / 总数 / 各等级分布 / 最近解锁 */
  summary: ReturnType<typeof getAchievementSummary>;
  /** 接近解锁的（进度 ≥ 80%），用于「再练一点就到手」的提示 */
  nearby: Achievement[];
}

/**
 * 用当前统计评估成就，并把新解锁的写回存储。
 *
 * 幂等：同一份 stats 连调两次，第二次 `newlyUnlocked` 为空 —— 第一次已经落盘，
 * 第二次会被当作「之前就解锁了」。所以调用点不需要自己去重。
 */
export function syncAchievements(stats: LearningStats): AchievementState {
  const result = checkAchievements(stats, loadAchievements());
  saveAchievements(result.achievements);
  return {
    achievements: result.achievements,
    newlyUnlocked: result.newlyUnlocked,
    summary: getAchievementSummary(result.achievements),
    nearby: getNearbyAchievements(result.achievements),
  };
}

/** 清空成就进度（调试 / 备份导入用） */
export function resetAchievements() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 同上：清不掉也不该抛
  }
}

/** 备份用：只导出已解锁状态（未解锁项可由统计重算）。 */
export function exportAchievements(): Achievement[] {
  return loadAchievements();
}

/** 恢复用：按 id 合并，本机已有记录优先（旧备份不覆盖新解锁时间）。 */
export function importAchievements(incoming: unknown): { added: number; kept: number } {
  if (!Array.isArray(incoming)) return { added: 0, kept: 0 };
  const current = loadAchievements();
  const seen = new Set(current.map((a) => a.id));
  const valid = incoming.filter(
    (a): a is Achievement =>
      !!a && typeof a === 'object' && typeof (a as Achievement).id === 'string',
  );
  const fresh = valid.filter((a) => !seen.has(a.id));
  if (fresh.length > 0) saveAchievements([...current, ...fresh]);
  return { added: fresh.length, kept: valid.length - fresh.length };
}
