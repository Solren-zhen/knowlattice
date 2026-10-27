/**
 * M7 · 错题本：复习时点「忘了」自动收录的错题记录（localStorage 轻量存储）。
 * - 按笔记路径聚合，同名路径累加失败次数
 * - chapterHeat 按章节聚合 → 薄弱点热力图
 * - 记录可手动清除；删掉笔记不影响已有记录，点击直达时由上层容错
 *
 * M7+ · 归档门控：错题不是「答对一次就消掉」，而是按阶段推进（0 刚错 → 1 → 2 → 3 已归档），
 * 每阶段隔 1/3/7 天再考，且**同一自然日内连对只推进一格**（防短期记忆刷过），
 * 到期未考会随逾期天数进入更靠前的池。见 advanceMistake/lapseMistake/dueMistakes/mistakePools。
 */
import { parseFrontmatterCached } from './parser';

/**
 * 固定错因分类：把「又错了」拆成可归因的四类。
 * 用固定枚举而不是自由文本，是为了能聚合（错因分布）与对比（哪类错因在下降）——
 * 自由文本十个人会写出十种写法，聚合出来等于没有。
 */
export type MistakeReason = 'knowledge' | 'confusion' | 'careless' | 'reasoning';

export const MISTAKE_REASONS: MistakeReason[] = ['knowledge', 'confusion', 'careless', 'reasoning'];

export const MISTAKE_REASON_LABELS: Record<MistakeReason, string> = {
  knowledge: '知识没记住',
  confusion: '概念混淆',
  careless: '审题偏差',
  reasoning: '临床推理跳步',
};

export interface MistakeRecord {
  path: string;
  chapter: string;
  title: string;
  /** 累计失败次数 */
  count: number;
  /** 最近一次失败时间戳 (ms) */
  lastFailedAt: number;
  /**
   * 手工标注的错因。**可选**：旧数据（本字段引入前的 localStorage / 备份）没有它，
   * 读出来就是 undefined，不需要任何迁移；视图按「未标注」展示。
   */
  reason?: MistakeReason;
  /**
   * 归档门控的四个字段，同样**全部可选**：旧数据没有它们，按 stage 0 / 立即到期处理，
   * 不需要迁移脚本（与 reason 同一策略）。
   */
  /** 已通过的门控阶段 0..3；3 = 已归档（不再进复习队列） */
  stage?: number;
  /** 下次该考的绝对时间戳 (ms)；到期后才会出现在 dueMistakes */
  dueAt?: number;
  /** 最近一次推进阶段的时刻：同日再对不推进，只认第一次 */
  lastAdvanceAt?: number;
  /** 从更高阶段掉回 0 的次数（答错/忘了） */
  lapses?: number;
}

export type MistakeMap = Record<string, MistakeRecord>;

// ── 归档门控的常量 ────────────────────────────────────────────────
/** 最高阶段：到达即归档（不再出现在复习队列里，但记录保留，供热力图与统计使用） */
export const MAX_STAGE = 3;
/** 各阶段的展示名。索引 = stage，3 = 已归档 */
export const MISTAKE_STAGE_LABELS: Record<number, string> = {
  0: '刚错',
  1: '一次过',
  2: '两次过',
  3: '已归档',
};
/**
 * 通过第 i 阶段后隔几天再考。三个间隔对应 stage 0→1→2 之后：
 * 错完当天记下 → 隔天考一次 → 隔 3 天 → 隔 7 天 → 归档。
 * 间隔刻意递增：刚错的题高频碰面，快掌握的题拉长到一周，避免把时间花在已经会的题上。
 */
export const STAGE_INTERVAL_DAYS: readonly number[] = [1, 3, 7, 21];
/** 每日各池的复习配额：防止错题堆积后「一次清空」变成刷题表演 */
export const DAILY_QUOTA = { overdue: 10, critical: 5, core: 15, review: 25 } as const;

const DAY_MS = 86_400_000;

const KEY = 'knowlattice-mistakes';

/** 模块级缓存：避免渲染期反复 JSON.parse 整个错题表 */
let cache: MistakeMap | null = null;

/**
 * 读取错题表。**每次返回浅拷贝**：返回 cache 本身会让 `setState(clearMistake(...))` 拿到
 * 同一个引用，React 的 Object.is 比较直接 bail out —— 记录确实删了，但行还在、计数不变，
 * 用户以为按钮坏了。浅拷贝不重新 JSON.parse，成本可忽略。
 */
export function loadMistakes(): MistakeMap {
  return { ...ensureCache() };
}

/** 单条查询：渲染体内用（编辑器每键渲染一次），不做整表浅拷贝 */
export function getMistake(path: string): MistakeRecord | null {
  return ensureCache()[path] ?? null;
}

/** 惰性建缓存：JSON.parse 只做一次，之后 loadMistakes/getMistake 都走内存 */
function ensureCache(): MistakeMap {
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as MistakeMap;
    } catch {
      cache = {};
    }
  }
  return cache;
}

function save(mistakes: MistakeMap) {
  cache = mistakes;
  localStorage.setItem(KEY, JSON.stringify(mistakes));
}

/**
 * 记录一次复习失败。content 为笔记原文，用于提取章节与标题；
 * 返回更新后的完整错题表（调用方可直接 setState）。
 */
export function recordMistake(path: string, content: string): MistakeMap {
  const { title, meta } = parseFrontmatterCached(path, content);
  const mistakes = loadMistakes();
  const prev = mistakes[path];
  const now = Date.now();
  mistakes[path] = {
    path,
    chapter: meta.chapter || '未分类',
    title: title || path.replace(/\.md$/, '').split('/').pop()!,
    count: (prev?.count ?? 0) + 1,
    lastFailedAt: now,
    // 同一篇再次失败不能丢掉已标注的错因：错因是用户对「为什么错」的判断，
    // 与失败次数无关；丢了就得每次重标，标注也就没人用了。
    ...(prev?.reason ? { reason: prev.reason } : {}),
    // 门控回落：又错了就从 0 阶段重新爬，且**立刻**到期（今天之内还要再考一次，
    // 不能因为「今天已经推过一格」就把它推到明天）。lastAdvanceAt 清零，
    // 让当天晚些时候的答对仍可算作本轮第一次推进。
    stage: 0,
    dueAt: now,
    lastAdvanceAt: 0,
    lapses: (prev?.lapses ?? 0) + (prev ? 1 : 0),
  };
  save(mistakes);
  return mistakes;
}

/**
 * 标注 / 取消一条错题的错因（null = 取消标记）。
 * path 不在错题本里时原样返回：标注是「对已有错题的补充」，不该凭空造出一条记录。
 * 返回更新后的错题表，调用方可直接 setState（同 recordMistake 的约定）。
 */
export function setMistakeReason(path: string, reason: MistakeReason | null): MistakeMap {
  const mistakes = loadMistakes();
  const cur = mistakes[path];
  if (!cur) return mistakes;
  if (reason !== null && !MISTAKE_REASONS.includes(reason)) return mistakes;
  const next: MistakeRecord = { ...cur };
  if (reason) next.reason = reason;
  else delete next.reason;
  mistakes[path] = next;
  save(mistakes);
  return mistakes;
}

/**
 * 错因分布：四档各一条。`unlabeled` 是全表未标注条数，每行都带——
 * 分布条要同时画四档占比与「未标注」切片，随行带上就不必再查一次全表。
 * 计数单位是**错题条数**（一条错题一票），不是失败次数：一条错题只有一个错因。
 */
export function reasonCounts(): Array<{ reason: MistakeReason; count: number; unlabeled: number }> {
  // 四档固定字符串键 → 静态查表用 Record（不是 Map）：无需插入/删除，也不看顺序
  const tally: Record<MistakeReason, number> = { knowledge: 0, confusion: 0, careless: 0, reasoning: 0 };
  let unlabeled = 0;
  for (const r of Object.values(loadMistakes())) {
    // 兼容历史脏数据：备份里可能带一个不在枚举内的字符串，按未标注处理而不是崩掉
    if (r.reason && MISTAKE_REASONS.includes(r.reason)) {
      tally[r.reason]++;
    } else {
      unlabeled++;
    }
  }
  return MISTAKE_REASONS.map((reason) => ({ reason, count: tally[reason], unlabeled }));
}

/** 清除一条错题记录（如已经掌握），返回更新后的错题表 */
export function clearMistake(path: string): MistakeMap {
  const mistakes = loadMistakes();
  delete mistakes[path];
  save(mistakes);
  return mistakes;
}

/** 章节 → 失败总次数（薄弱点热力图数据，按次数降序） */
export function chapterHeat(mistakes: MistakeMap): Array<{ chapter: string; count: number }> {
  const agg = new Map<string, number>();
  for (const r of Object.values(mistakes)) {
    agg.set(r.chapter, (agg.get(r.chapter) ?? 0) + r.count);
  }
  return [...agg.entries()]
    .map(([chapter, count]) => ({ chapter, count }))
    .sort((a, b) => b.count - a.count);
}

/** 从备份恢复错题记录（合并模式）；返回恢复条数 */
export function importMistakes(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const mistakes = loadMistakes();
  let n = 0;
  for (const [key, raw] of Object.entries(state as Record<string, unknown>)) {
    const r = raw as Partial<MistakeRecord>;
    if (!r || typeof r.path !== 'string' || typeof r.count !== 'number') continue;
    // 备份是整体导入（vault.ts 直接搬 mistakes 对象），错因字段必须在这里保住：
    // 校验时把不在枚举里的脏值降级为「未标注」，而不是原样写回污染缓存
    const reason = r.reason && MISTAKE_REASONS.includes(r.reason) ? r.reason : undefined;
    const stage = typeof r.stage === 'number' && r.stage >= 0 && r.stage <= MAX_STAGE ? Math.floor(r.stage) : 0;
    const dueAt = typeof r.dueAt === 'number' ? r.dueAt : Date.now();
    mistakes[key] = {
      path: r.path,
      chapter: typeof r.chapter === 'string' ? r.chapter : '',
      title: typeof r.title === 'string' ? r.title : '',
      count: r.count,
      lastFailedAt: typeof r.lastFailedAt === 'number' ? r.lastFailedAt : Date.now(),
      ...(reason ? { reason } : {}),
      // 备份里的门控字段原样恢复；缺失/越界则按「刚错、立即到期」兜底，
      // 而不是把整条错题丢掉——丢了等于自动帮用户归档。
      stage,
      dueAt,
      lastAdvanceAt: typeof r.lastAdvanceAt === 'number' ? r.lastAdvanceAt : 0,
      lapses: typeof r.lapses === 'number' && r.lapses >= 0 ? r.lapses : 0,
    };
    n++;
  }
  save(mistakes);
  return n;
}

// ── 归档门控机制 ──────────────────────────────────────────────────

/** 一条错题当前阶段；旧数据没有 stage 字段 → 按 0 处理（不迁移） */
export function stageOf(r: MistakeRecord): number {
  const s = r.stage;
  return typeof s === 'number' && s >= 0 ? Math.min(Math.floor(s), MAX_STAGE) : 0;
}

/** 是否已归档（不再进复习队列） */
export function isArchived(r: MistakeRecord): boolean {
  return stageOf(r) >= MAX_STAGE;
}

/** 两个时间戳是否落在同一个自然日（本地时区）——门控的「同日不连跳」按日历天算，不是按 24 小时 */
export function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
  );
}

/** 本地当天 0 点的时间戳 */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 某阶段通过后，下次该考的绝对时间 */
export function nextDueAt(stage: number, now = Date.now()): number {
  const idx = Math.min(Math.max(stage, 1), STAGE_INTERVAL_DAYS.length) - 1;
  return now + STAGE_INTERVAL_DAYS[idx] * DAY_MS;
}

/**
 * 答对一次：推进一格。
 * - 记录不存在 → 原样返回（不凭空造错题）
 * - 已归档 → 不动
 * - **同一自然日内已经推进过 → 不动**：当天连对两次不能算两格，
 *   否则「点两下就归档」，门控等于没有。
 * 返回更新后的错题表（调用方可直接 setState）。
 */
export function advanceMistake(path: string, now = Date.now()): MistakeMap {
  const mistakes = loadMistakes();
  const cur = mistakes[path];
  if (!cur) return mistakes;
  const stage = stageOf(cur);
  if (stage >= MAX_STAGE) return mistakes;
  if (cur.lastAdvanceAt && sameLocalDay(cur.lastAdvanceAt, now)) return mistakes;
  const nextStage = stage + 1;
  mistakes[path] = { ...cur, stage: nextStage, lastAdvanceAt: now, dueAt: nextDueAt(nextStage, now) };
  save(mistakes);
  return mistakes;
}

/**
 * 又错了：门控归零并立刻到期。
 * 与 recordMistake 的区别——这里**不动失败计数**，用于「错题复核时又没答对」，
 * 语义是「门控回退」而不是「又记了一次错题」。
 */
export function lapseMistake(path: string, now = Date.now()): MistakeMap {
  const mistakes = loadMistakes();
  const cur = mistakes[path];
  if (!cur) return mistakes;
  mistakes[path] = { ...cur, stage: 0, dueAt: now, lastAdvanceAt: 0, lapses: (cur.lapses ?? 0) + 1 };
  save(mistakes);
  return mistakes;
}

/** 今天该考（未归档且已到期）的错题，逾期最久的在前，同一时刻错得多的在前 */
export function dueMistakes(now = Date.now(), map: MistakeMap = loadMistakes()): MistakeRecord[] {
  const list = Object.values(map).filter((r) => !isArchived(r) && (r.dueAt ?? 0) <= now);
  return list.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || b.count - a.count);
}

export interface MistakePools {
  /** 到期时间早于今天 0 点：积压的 */
  overdue: number;
  /** 刚错、还没过第一关 */
  critical: number;
  /** 过一次 */
  core: number;
  /** 过两次 */
  review: number;
  archived: number;
  total: number;
}

/** 分池统计（错题本顶部用）：逾期优先于阶段，因为逾期的题比刚错的题更该先做 */
export function mistakePools(now = Date.now(), map: MistakeMap = loadMistakes()): MistakePools {
  const startOfToday = startOfLocalDay(now);
  const pools: MistakePools = { overdue: 0, critical: 0, core: 0, review: 0, archived: 0, total: 0 };
  for (const r of Object.values(map)) {
    pools.total++;
    const stage = stageOf(r);
    if (stage >= MAX_STAGE) {
      pools.archived++;
    } else if ((r.dueAt ?? 0) < startOfToday) {
      pools.overdue++;
    } else if (stage === 0) {
      pools.critical++;
    } else if (stage === 1) {
      pools.core++;
    } else {
      pools.review++;
    }
  }
  return pools;
}

/**
 * 今日错题队列 = 到期错题按池配额截断（逾期 → 刚错 → 过一次 → 过两次）。
 * 配额只限每个池的**上限**，不是补齐目标：池里没有那么多就返回现有条数。
 */
export function takeDueMistakes(now = Date.now(), map: MistakeMap = loadMistakes()): MistakeRecord[] {
  const startOfToday = startOfLocalDay(now);
  const buckets: Record<'overdue' | 'critical' | 'core' | 'review', MistakeRecord[]> = {
    overdue: [],
    critical: [],
    core: [],
    review: [],
  };
  for (const r of dueMistakes(now, map)) {
    const stage = stageOf(r);
    const key = (r.dueAt ?? 0) < startOfToday ? 'overdue' : stage === 0 ? 'critical' : stage === 1 ? 'core' : 'review';
    buckets[key].push(r);
  }
  const out: MistakeRecord[] = [];
  for (const key of ['overdue', 'critical', 'core', 'review'] as const) {
    out.push(...buckets[key].slice(0, DAILY_QUOTA[key]));
  }
  return out;
}
