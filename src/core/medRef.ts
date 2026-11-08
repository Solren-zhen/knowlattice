/**
 * 医学速查：症状 → 疾病、方剂口诀。
 *
 * 内置数据由 `tools/ingest-app-data.mjs` 洗成 `public/app-data/medref/*.json`（kq.medref.v1），
 * 只留症状/分类/疾病、口诀正文这些内容字段。
 *
 * 用户自己加/改的条目存在本机（见 medRefStore），与内置数据合并显示：
 * 同名时以用户那条为准（自己改的不能被内置覆盖）。
 *
 * 检索刻意做成**本地子串匹配**而不是分词：症状 300+ 条、口诀几十到几百条，线性扫是微秒级；
 * 上索引/模糊匹配只会让边界更难解释。匹配忽略大小写与首尾空白，命中的位置越靠前越优先。
 */

export interface MedSymptom {
  name: string;
  cat: string;
  diseases: string[];
}

export interface MedMnemonic {
  term: string;
  cat: string;
  body: string;
  tip: string;
}

export interface MedMnemonicLib {
  book: string;
  note: string;
  entries: MedMnemonic[];
}

export interface MedRefData {
  symptoms: MedSymptom[];
  books: MedMnemonicLib[];
}

const DATA_BASE = 'app-data/medref';
let cache: Promise<MedRefData> | null = null;

async function readJson<T>(file: string): Promise<T> {
  const res = await fetch(`${DATA_BASE}/${file}`);
  if (!res.ok) {
    throw new Error(`速查数据没生成（${file} HTTP ${res.status}）：先在项目根跑 node tools/ingest-app-data.mjs`);
  }
  return (await res.json()) as T;
}

export async function loadMedRef(): Promise<MedRefData> {
  if (cache) return cache;
  cache = (async () => {
    const s = await readJson<{ symptoms: MedSymptom[] }>('symptoms.json');
    // 中医口诀不再进医学速查；口诀页只显示用户在本机自建的条目。
    return { symptoms: s.symptoms ?? [], books: [] };
  })();
  cache.catch(() => { cache = null; });
  return cache;
}

/** 命中位置（越小越靠前）；没命中返回 -1 */
function hitIndex(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle);
}

/** 按「前缀优先、其次位置」排序。空查询返回前 limit 条（给一个可浏览的起点）。 */
function rank<T>(items: T[], q: string, keys: Array<(x: T) => string>, limit: number): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    let best = -1;
    for (const k of keys) {
      const i = hitIndex(k(item), needle);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) scored.push({ item, score: best === 0 ? -1 : best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.item);
}

export function searchSymptoms(symptoms: MedSymptom[], q: string, limit = 80): MedSymptom[] {
  return rank(symptoms, q, [(x) => x.name, (x) => x.cat, (x) => x.diseases.join(' ')], limit);
}

export function searchMnemonics(books: MedMnemonicLib[], q: string, limit = 80): MedMnemonicLib[] {
  const needle = q.trim().toLowerCase();
  return books
    .map((book) => {
      const entries = needle
        ? book.entries.filter(
            (e) =>
              e.term.toLowerCase().includes(needle) ||
              e.cat.toLowerCase().includes(needle) ||
              e.body.toLowerCase().includes(needle) ||
              e.tip.toLowerCase().includes(needle),
          )
        : book.entries;
      return { ...book, entries: entries.slice(0, limit) };
    })
    .filter((book) => book.entries.length > 0);
}

/** 一条分类及其条目数 */
export interface CatCount {
  name: string;
  count: number;
}

/**
 * 分类清单：条目上的 `cat` 字段汇总而来，不是单独存的实体。
 *
 * 「自定义分类」= 在编辑表单里写下任何新分类名，它下一次渲染就出现在筛选行和
 * 候选列表里；没有条目用的分类自然消失，不用单独维护一张清单，也不会留下
 * 「分类还在、条目已经删光」的孤儿。去重按小写比（英文分类不因大小写分叉），
 * 显示保留第一次写下的写法，排序按中文。
 */
export function countCats(cats: readonly string[]): CatCount[] {
  const seen = new Map<string, CatCount>();
  for (const raw of cats) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const hit = seen.get(key);
    if (hit) hit.count += 1;
    else seen.set(key, { name, count: 1 });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 分类筛选用：'' 表示不筛 */
export function inCat(cat: string, filter: string): boolean {
  return !filter || cat.trim().toLowerCase() === filter.trim().toLowerCase();
}

/**
 * 合并内置症状与用户自建：同名以用户那条为准，其余内置排前面（保持原有顺序）。
 * 用 Map 而不是 find 循环——用户条目多了以后 O(n²) 会在输入时卡顿。
 */
export function mergeSymptoms(builtin: MedSymptom[], user: MedSymptom[], hidden: string[] = []): MedSymptom[] {
  if (!user.length && !hidden.length) return builtin;
  const blocked = new Set(hidden);
  const mine = new Map(user.map((s) => [s.name, s]));
  const out = builtin.filter((s) => !blocked.has(s.name)).map((s) => mine.get(s.name) ?? s);
  for (const s of user) {
    if (!blocked.has(s.name) && !builtin.some((b) => b.name === s.name)) out.push(s);
  }
  return out;
}
