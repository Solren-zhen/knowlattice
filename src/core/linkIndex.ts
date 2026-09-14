/**
 * 双链 / 反链索引（M3 预留骨架，~50 行自写）。
 * - 正向链接：从笔记正文提取 [[目标]]
 * - 反向链接：哪些笔记提到了它
 * 支持单篇增量更新（保存/删除时 O(该篇) 而非全库重建）。
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** 提取一篇笔记中的所有 wikilink 目标（去重） */
export function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    links.add(m[1].trim());
  }
  return [...links];
}

export interface LinkIndex {
  /** path -> 该笔记引用的目标名列表 */
  outgoing: Map<string, string[]>;
  /** 目标名(小写) -> 引用它的笔记路径列表 */
  incoming: Map<string, string[]>;
}

/** 全量重建索引（仅启动/导入等低频时机使用） */
export function rebuildLinkIndex(docs: Map<string, string>): LinkIndex {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const [path, content] of docs) {
    const targets = path.endsWith('.md') ? extractLinks(content) : [];
    outgoing.set(path, targets);
    for (const t of targets) {
      const key = t.toLowerCase();
      if (!incoming.has(key)) incoming.set(key, []);
      incoming.get(key)!.push(path);
    }
  }
  return { outgoing, incoming };
}

/** 单篇增量更新：先把该篇旧的出链从 incoming 摘除，再登记新出链。
 *  content 传空串（或非 .md 路径）即等于删除该篇的链接参与。O(旧出链数 + 新出链数)。 */
export function updateLinksForPath(index: LinkIndex, path: string, content: string): void {
  for (const t of index.outgoing.get(path) ?? []) {
    const arr = index.incoming.get(t.toLowerCase());
    if (!arr) continue;
    const i = arr.indexOf(path);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) index.incoming.delete(t.toLowerCase());
  }
  const targets = path.endsWith('.md') ? extractLinks(content) : [];
  index.outgoing.set(path, targets);
  const seen = new Set<string>();
  for (const t of targets) {
    const key = t.toLowerCase();
    // 同一篇里 [[b]] 与 [[B]] 指向同一目标，只登记一次（避免反链重复）
    if (seen.has(key)) continue;
    seen.add(key);
    if (!index.incoming.has(key)) index.incoming.set(key, []);
    index.incoming.get(key)!.push(path);
  }
}

/** 查反链：给定笔记名，返回所有提到它的笔记路径 */
export function backlinks(index: LinkIndex, name: string): string[] {
  return index.incoming.get(name.toLowerCase()) ?? [];
}
