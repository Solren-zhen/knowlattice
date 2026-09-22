/**
 * 全文检索：MiniSearch + 中文二元分词（bigram）。
 * "氧解离曲线" → 氧解 / 解离 / 离曲 / 曲线
 * 无需重型 NLP 库即可支持任意子串命中（M2 验收项）。
 *
 * VaultSearch：懒构建 + 增量同步引擎。
 * - 启动时只登记文档（引用比对，近零成本），不打断首屏；
 *   空闲时 warm() 预构建，或首次搜索时才构建。
 * - 之后每次保存/删除只增量处理变化的篇目（O(变化篇数)），
 *   替代旧版「每次保存全库重新分词」的做法。
 * - 只索引 .md 笔记；附件（_attachments dataURL）不进入索引。
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import { expandQuery } from './medSynonyms';
import { parseFrontmatterCached } from './parser';

/** 中英混合分词：连续 ASCII 词元保留，CJK 部分做二元切分 */
export function bigramTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.split(/([a-zA-Z0-9]+)/)) {
    if (!chunk) continue;
    if (/^[a-zA-Z0-9]+$/.test(chunk)) {
      tokens.push(chunk.toLowerCase());
    } else {
      const cjk = chunk.replace(/\s+/g, '');
      for (let i = 0; i < cjk.length; i++) {
        const gram = cjk.slice(i, i + 2);
        if (gram.length === 2) tokens.push(gram);
      }
    }
  }
  return tokens;
}

export interface SearchDoc {
  id: string; // vault path
  title: string;
  content: string;
}

/** 真正进索引的文档：比 SearchDoc 多一个 aliases 字段（视图用不到，不进公开形状） */
interface IndexedDoc extends SearchDoc {
  aliases: string;
}

const titleOf = (id: string): string => id.replace(/\.md$/, '').split('/').pop()!;

/**
 * 笔记自己写的 `aliases` 也进索引——这才是**随用户数据长出来**的语义层：
 * 笔记标题是「心肌梗死」，用户写了 `aliases: [心梗]`，搜「心梗」就该找到它。
 * 内置词表（medSynonyms.ts）只补词表里有的常见缩写，覆盖不到用户自己的叫法。
 */
const aliasText = (id: string, content: string): string =>
  parseFrontmatterCached(id, content).meta.aliases.join(' ');

const toIndexed = (id: string, content: string): IndexedDoc => ({
  id,
  title: titleOf(id),
  content,
  aliases: aliasText(id, content),
});

const toDoc = (id: string, content: string): SearchDoc => ({
  id,
  title: titleOf(id),
  content,
});

export class VaultSearch {
  private docs = new Map<string, string>(); // path -> content（仅 .md）
  private mini: MiniSearch | null = null;
  /** 空闲预热回调注册 */
  private warmQueued = false;
  /** 正在进行的异步构建（幂等：多次请求共享同一个 Promise） */
  private warming: Promise<void> | null = null;

  /** 与最新 docs 对账：登记新增/变更/删除；已构建则增量应用到索引 */
  sync(all: Map<string, string>): void {
    let dirty = false;
    for (const [path, content] of all) {
      if (!path.endsWith('.md')) continue;
      if (this.docs.get(path) === content) continue;
      this.docs.set(path, content);
      if (this.mini) {
        if (this.mini.has(path)) this.mini.discard(path);
        this.mini.add(toIndexed(path, content));
      }
      dirty = true;
    }
    for (const path of [...this.docs.keys()]) {
      if (all.has(path)) continue;
      this.docs.delete(path);
      if (this.mini?.has(path)) this.mini.discard(path);
      dirty = true;
    }
    if (dirty) this.scheduleWarm();
  }

  /** 索引是否已就绪 */
  isReady(): boolean {
    return this.mini !== null;
  }

  /** 首次构建全量索引（幂等）。用 addAllAsync 分块构建，每块之间让出主线程，
   *  避免 5227 篇规模下同步 addAll 把 UI 冻住。 */
  warm(): Promise<void> {
    if (this.mini) return Promise.resolve();
    if (this.warming) return this.warming;
    const m = new MiniSearch({
      fields: ['title', 'content', 'aliases'],
      tokenize: bigramTokenize,
      searchOptions: {
        prefix: true,
        // 错字容忍：CJK 二元词只有 2 字，0.2×2 向下取整为 0，所以**只对 ASCII 生效**
        // （fibrilation → fibrillation）。中文的近似靠 bigram 子串 + 词表 + aliases。
        fuzzy: 0.2,
        boost: { title: 3, aliases: 2 },
      },
    });
    this.warming = m
      .addAllAsync([...this.docs.entries()].map(([id, c]) => toIndexed(id, c)), { chunkSize: 200 })
      .then(() => {
        this.mini = m;
        this.warming = null;
      })
      .catch((e) => {
        console.error('全文索引构建失败：', e);
        this.warming = null;
      });
    return this.warming;
  }

  /** 空闲时自动预热（构建一次）；有文档同步后若仍未构建则再约 */
  private scheduleWarm(): void {
    if (this.mini || this.warmQueued || typeof window === 'undefined') return;
    this.warmQueued = true;
    const idle =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 500));
    idle(() => {
      this.warmQueued = false;
      void this.warm();
    });
  }

  /** 当前已登记的 .md 文档（供最近打开列表等使用） */
  list(): SearchDoc[] {
    return [...this.docs.entries()].map(([id, c]) => toDoc(id, c));
  }

  /** 取前 limit 个未被排除的文档（空查询时只取足够渲染的量，避免全库排序） */
  listSome(exclude: Set<string>, limit: number): SearchDoc[] {
    if (limit <= 0) return [];
    const out: SearchDoc[] = [];
    for (const [id, c] of this.docs) {
      if (exclude.has(id)) continue;
      out.push(toDoc(id, c));
      if (out.length >= limit) break;
    }
    return out;
  }

  getDoc(id: string): SearchDoc | undefined {
    const c = this.docs.get(id);
    return c === undefined ? undefined : toDoc(id, c);
  }

  /** 全文搜索：索引未就绪时返回空数组（调用方负责显示构建中状态），绝不同步构建阻塞 UI。
   *
   *  查询先做语义近似展开（词表 + 原查询），再交给 MiniSearch。**不再手工预分词**：
   *  旧写法 `bigramTokenize(query).join(' ')` 交给 MiniSearch 后会被**再切一次**，
   *  于是"氧解离曲线"多出「解解 / 离离 / 曲曲」这类跨词垃圾二元组（匹配不到东西，
   *  纯属白算）。直接传原串，MiniSearch 用同一个 tokenize 切一次就是对的。 */
  search(query: string): SearchResult[] {
    if (!this.mini) return [];
    const terms = expandQuery(query);
    if (!terms.length) return [];
    return this.mini.search(terms.join(' '));
  }
}

/** 应用级单例：全库只有一个倒排索引 */
export const vaultSearch = new VaultSearch();
