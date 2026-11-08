/**
 * 反链增强：把「谁引用了你这篇」升级成「引用了哪一句、这条还活着吗、要不要顺手修」。
 *
 * 原有 `linkIndex` 只回答「incoming: 名字 → 路径列表」，够画关系，不够修问题：
 * 用户看到一条反链，想知道它在原文哪一句、是不是已经指向了一篇不存在的笔记。
 * 这里补三件事，全部是纯函数（解析器由调用方注入，不依赖 vault 实现）：
 *   - 位置：字符偏移 + 行号 + 前后各 40 字上下文
 *   - 分类：普通双链 / 块引用（`#^anchor`）/ 失效（目标解析不到）
 *   - 修复：编辑距离给候选、替换时保留 `#锚点` 与 `|别名`
 */

export const CONTEXT_RADIUS = 40;

export interface ContextWindow {
  before: string;
  match: string;
  after: string;
}

/** 命中位置前后各取 `radius` 字，空白折叠，超长用 … 收尾。 */
export function contextWindow(
  text: string,
  index: number,
  length: number,
  radius: number = CONTEXT_RADIUS,
): ContextWindow {
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + length + radius);
  const head = text.slice(from, index).replace(/\s+/g, ' ').trim();
  const tail = text.slice(index + length, to).replace(/\s+/g, ' ').trim();
  return {
    before: (from > 0 ? '…' : '') + head,
    match: text.slice(index, index + length),
    after: tail + (to < text.length ? '…' : ''),
  };
}

export function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

export interface WikiOccurrence {
  /** 双链目标（不含 # 锚点与 | 别名） */
  target: string;
  /** 显示别名；没有别名时为空串（调用方自己决定显示目标还是标题） */
  label: string;
  /** `#` 之后的部分；块引用以 `^` 开头 */
  anchor: string;
  /** 原始文本 */
  raw: string;
  index: number;
  length: number;
}

/** 扫出正文里的双链（跳过 `![[嵌入]]`）。 */
export function scanWikiOccurrences(body: string): WikiOccurrence[] {
  const out: WikiOccurrence[] = [];
  for (const m of body.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const index = m.index ?? 0;
    if (index > 0 && body[index - 1] === '!') continue;
    const inner = m[1];
    const bar = inner.indexOf('|');
    const head = bar >= 0 ? inner.slice(0, bar) : inner;
    const label = bar >= 0 ? inner.slice(bar + 1).trim() : '';
    const hash = head.indexOf('#');
    const target = (hash >= 0 ? head.slice(0, hash) : head).trim();
    const anchor = hash >= 0 ? head.slice(hash + 1).trim() : '';
    if (!target) continue;
    out.push({ target, label, anchor, raw: m[0], index, length: m[0].length });
  }
  return out;
}

export type BacklinkKind = 'link' | 'block' | 'unresolved';

/** 分类：解析到 = 普通链；`#^` = 块引用；解析不到 = 失效。 */
export function classifyBacklink(anchor: string, resolved: boolean): BacklinkKind {
  if (!resolved) return 'unresolved';
  return anchor.startsWith('^') ? 'block' : 'link';
}

export interface BacklinkHit extends WikiOccurrence {
  /** 引用方笔记路径 */
  fromPath: string;
  kind: BacklinkKind;
  line: number;
  excerpt: ContextWindow;
}

/**
 * 收集指向 `targetPath` 的反链。
 *
 * @param targetPath 当前笔记路径
 * @param docs 全库 `路径 → 正文`
 * @param resolve 名字 → 路径（通常是 `vault.resolveLink`）；返回 null = 解析不到
 * @param targetNames 当前笔记可能被叫的名字（标题、别名）。解析不到的链接里，
 *   目标名恰好等于其中之一时归为 `unresolved`——那是「本该指向你、但名字写错了」的一条。
 */
export function collectBacklinkHits(
  targetPath: string,
  docs: ReadonlyMap<string, string>,
  resolve: (name: string) => string | null,
  targetNames: readonly string[] = [],
  radius: number = CONTEXT_RADIUS,
): BacklinkHit[] {
  if (!targetPath) return [];
  const norm = (s: string) => s.trim().toLowerCase();
  const selfNames = new Set(
    [
      targetPath.replace(/\.md$/, '').split('/').pop() ?? '',
      ...targetNames,
    ]
      .map(norm)
      .filter(Boolean),
  );
  const hits: BacklinkHit[] = [];
  for (const [fromPath, body] of docs) {
    if (fromPath === targetPath || !fromPath.endsWith('.md')) continue;
    for (const occ of scanWikiOccurrences(body)) {
      let resolved: string | null = null;
      try {
        resolved = resolve(occ.target);
      } catch {
        resolved = null; // 索引坏了不该让关联面板整块白屏
      }
      const pointsHere = resolved === targetPath;
      const looksLikeSelf = !resolved && selfNames.has(norm(occ.target));
      if (!pointsHere && !looksLikeSelf) continue;
      hits.push({
        ...occ,
        fromPath,
        kind: classifyBacklink(occ.anchor, pointsHere),
        line: lineOfIndex(body, occ.index),
        excerpt: contextWindow(body, occ.index, occ.length, radius),
      });
    }
  }
  return hits.sort((a, b) => a.fromPath.localeCompare(b.fromPath, 'zh') || a.line - b.line);
}

/** Levenshtein 距离（两行数组滚动，够用且不建表）。 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 失效链接的目标猜测：完全匹配 → 包含关系（取最短）→ 编辑距离最近的。
 * 阈值 `max(1, floor(len/3))`：太远的候选不猜，宁可让用户自己改。
 */
export function suggestTarget(target: string, candidates: readonly string[]): string | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  const exact = candidates.find((c) => c.trim().toLowerCase() === t);
  if (exact) return exact;
  const contains = candidates.filter((c) => {
    const lc = c.toLowerCase();
    return lc.includes(t) || t.includes(lc);
  });
  if (contains.length > 0) return [...contains].sort((a, b) => a.length - b.length)[0];
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(t, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (!best) return null;
  return bestD <= Math.max(1, Math.floor(t.length / 3)) ? best : null;
}

/** 把一条失效链接改成新目标；`#锚点` 与 `|别名` 原样保留。 */
export function applyLinkFix(
  body: string,
  hit: Pick<WikiOccurrence, 'index' | 'raw' | 'anchor' | 'label' | 'target'>,
  newTarget: string,
): string {
  const bar = hit.label && hit.label !== hit.target ? '|' + hit.label : '';
  const hash = hit.anchor ? '#' + hit.anchor : '';
  const replacement = '[[' + newTarget.trim() + hash + bar + ']]';
  const from = Math.max(0, Math.min(hit.index, body.length));
  const raw = hit.raw || '';
  const end = from + raw.length <= body.length ? from + raw.length : body.length;
  return body.slice(0, from) + replacement + body.slice(end);
}

/** 忽略清单的键：同一篇里的同一条坏链（不是全局按名字忽略）。 */
export function ignoreKey(hit: Pick<BacklinkHit, 'fromPath' | 'raw'>): string {
  return hit.fromPath + '::' + hit.raw;
}

/** 按忽略清单拆成「要看的」与「收起的」。 */
export function splitIgnored(
  hits: readonly BacklinkHit[],
  ignored: readonly string[],
): { active: BacklinkHit[]; hidden: BacklinkHit[] } {
  const set = new Set(ignored);
  const active: BacklinkHit[] = [];
  const hidden: BacklinkHit[] = [];
  for (const hit of hits) (set.has(ignoreKey(hit)) ? hidden : active).push(hit);
  return { active, hidden };
}

/** 面板上的一句话摘要（避免每个调用点各写一套口径）。 */
export function backlinkSummary(hits: readonly BacklinkHit[]): string {
  const counts = { link: 0, block: 0, unresolved: 0 } as Record<BacklinkKind, number>;
  for (const hit of hits) counts[hit.kind] += 1;
  const parts = [`${counts.link + counts.block} 条引用`];
  if (counts.block) parts.push(`${counts.block} 条块引用`);
  if (counts.unresolved) parts.push(`${counts.unresolved} 条失效`);
  return parts.join(' · ');
}
