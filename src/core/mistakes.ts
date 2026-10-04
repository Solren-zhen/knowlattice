/**
 * M7 · 错题本：复习时点「忘了」自动收录的错题记录（localStorage 轻量存储）。
 * - 按笔记路径聚合，同名路径累加失败次数
 * - chapterHeat 按章节聚合 → 薄弱点热力图
 * - 记录可手动清除；删掉笔记不影响已有记录，点击直达时由上层容错
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
}

export type MistakeMap = Record<string, MistakeRecord>;

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
  mistakes[path] = {
    path,
    chapter: meta.chapter || '未分类',
    title: title || path.replace(/\.md$/, '').split('/').pop()!,
    count: (prev?.count ?? 0) + 1,
    lastFailedAt: Date.now(),
    // 同一篇再次失败不能丢掉已标注的错因：错因是用户对「为什么错」的判断，
    // 与失败次数无关；丢了就得每次重标，标注也就没人用了。
    ...(prev?.reason ? { reason: prev.reason } : {}),
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
    mistakes[key] = {
      path: r.path,
      chapter: typeof r.chapter === 'string' ? r.chapter : '',
      title: typeof r.title === 'string' ? r.title : '',
      count: r.count,
      lastFailedAt: typeof r.lastFailedAt === 'number' ? r.lastFailedAt : Date.now(),
      ...(reason ? { reason } : {}),
    };
    n++;
  }
  save(mistakes);
  return n;
}
