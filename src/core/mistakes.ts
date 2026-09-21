/**
 * M7 · 错题本：复习时点「忘了」自动收录的错题记录（localStorage 轻量存储）。
 * - 按笔记路径聚合，同名路径累加失败次数
 * - chapterHeat 按章节聚合 → 薄弱点热力图
 * - 记录可手动清除；删掉笔记不影响已有记录，点击直达时由上层容错
 */
import { parseFrontmatter } from './parser';

export interface MistakeRecord {
  path: string;
  chapter: string;
  title: string;
  /** 累计失败次数 */
  count: number;
  /** 最近一次失败时间戳 (ms) */
  lastFailedAt: number;
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
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as MistakeMap;
    } catch {
      cache = {};
    }
  }
  return { ...cache };
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
  const { title, meta } = parseFrontmatter(content);
  const mistakes = loadMistakes();
  const prev = mistakes[path];
  mistakes[path] = {
    path,
    chapter: meta.chapter || '未分类',
    title: title || path.replace(/\.md$/, '').split('/').pop()!,
    count: (prev?.count ?? 0) + 1,
    lastFailedAt: Date.now(),
  };
  save(mistakes);
  return mistakes;
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
    mistakes[key] = {
      path: r.path,
      chapter: typeof r.chapter === 'string' ? r.chapter : '',
      title: typeof r.title === 'string' ? r.title : '',
      count: r.count,
      lastFailedAt: typeof r.lastFailedAt === 'number' ? r.lastFailedAt : Date.now(),
    };
    n++;
  }
  save(mistakes);
  return n;
}
