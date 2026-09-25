/**
 * 通路图：把笔记里的 ```pathway 围栏块渲染成手绘风 SVG 代谢通路图。
 *
 * 笔记里只写纯文本，渲染在本地完成（不联网、无第三方依赖）：
 *   # 糖代谢总览
 *   ## EMP 糖酵解 | #d64545 | 无氧条件 · 细胞质基质
 *   葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶
 *   6-磷酸葡萄糖 <-> 6-磷酸果糖 : 磷酸己糖异构酶
 *   > 关键酶：己糖激酶、PFK-1、丙酮酸激酶
 *
 * - `## 名称 | 颜色 | 旁注`：一条泳道/分组，颜色可省；同一节点在别的分组被引用即跨泳道连线
 * - `A -> B : 酶名` 正向；`A <-> B : 酶名` 可逆（也可用 → / ⇌）
 * - `[[目标]]` 或 `[[目标|显示名]]`：节点可点击跳转到对应笔记
 * - `@ 节点`：声明没有连线的节点（适合在编辑器中先搭图再补关系）
 * - `>` 开头：该分组的旁注，排在泳道底部
 *
 * 所有文本都经 XML 转义后拼进 SVG，不引入用户 HTML。
 */

export interface PwLink { target: string; label: string }
export interface PwGroup { id: string; name: string; color: string; note?: string }
export interface PwNode { key: string; label: string; group: string; link?: PwLink; x?: number; y?: number }
export type PwRelation = 'convert' | 'promote' | 'inhibit' | 'reversible';
export interface PwEdge { from: string; to: string; label?: string; reversible: boolean; relation: PwRelation; group: string }
export interface PwNote { group: string; text: string }
export interface PwSpec {
  title?: string;
  groups: PwGroup[];
  nodes: PwNode[];
  edges: PwEdge[];
  notes: PwNote[];
}
export interface PwParseResult { spec: PwSpec; errors: string[] }
export interface PwPoint { x: number; y: number }
export interface PwNodeSize { width: number; height: number }

export const PW_LANGS = ['pathway', 'biochem'];

const PALETTE = ['#d64545', '#2f9e44', '#1c7ed6', '#e8590c', '#7048e8', '#0ca678', '#c2255c', '#5c940d'];

export function isPathwayLang(info: string): boolean {
  return PW_LANGS.includes(info.trim().toLowerCase());
}

const isHex = (s: string) => /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.trim());

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `[[目标]]` / `[[目标|显示名]]` → 显示名 + 链接；否则纯文本 */
function parseName(raw: string): { label: string; link?: PwLink } {
  const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw.trim());
  if (!m) return { label: raw.trim() };
  const target = m[1].trim();
  const label = (m[2] ?? m[1]).trim();
  return { label, link: { target, label } };
}

interface RawEdge { left: string; right: string; reversible: boolean; relation: PwRelation; label?: string }

function splitEdge(line: string): RawEdge | null {
  let op = '';
  let i = -1;
  const arrowIdx = line.indexOf('<->');
  if (arrowIdx >= 0) { op = '<->'; i = arrowIdx; }
  else {
    const fwd = line.indexOf('->');
    const uni = line.indexOf('→');
    const rev = line.indexOf('⇌');
    if (fwd >= 0) { op = '->'; i = fwd; }
    else if (uni >= 0) { op = '->'; i = uni; }
    else if (rev >= 0) { op = '<->'; i = rev; }
  }
  if (!op) return null;

  const left = line.slice(0, i).trim();
  let rest = line.slice(i + op.length).trim();
  if (!left || !rest) return null;

  let label: string | undefined;
  const m = /^([\s\S]*?)\s*[:：]\s*([\s\S]+)$/.exec(rest);
  if (m) {
    rest = m[1].trim();
    label = m[2].trim() || undefined;
  }
  if (!rest) return null;
  const rawLabel = label ?? '';
  const relationMatch = /^(促进|抑制|转化|可逆)(?:\s*[·:]\s*([\s\S]*))?$/.exec(rawLabel.trim());
  const relation: PwRelation = op === '<->' ? 'reversible' : relationMatch?.[1] === '促进' ? 'promote' : relationMatch?.[1] === '抑制' ? 'inhibit' : 'convert';
  label = relationMatch ? (relationMatch[2]?.trim() || undefined) : label;
  return { left, right: rest, reversible: op === '<->', relation, label };
}

/** 解析围栏块源码；结构错误不抛异常，收集到 errors 里由渲染层决定如何提示 */
export function parsePathway(src: string): PwParseResult {
  const spec: PwSpec = { groups: [], nodes: [], edges: [], notes: [] };
  const errors: string[] = [];
  const nodeMap = new Map<string, PwNode>();
  let cur: PwGroup | null = null;

  const ensureGroup = (): PwGroup => {
    if (cur) return cur;
    cur = { id: `g${spec.groups.length}`, name: '通路', color: PALETTE[0] };
    spec.groups.push(cur);
    return cur;
  };

  const addNode = (raw: string, group: PwGroup, position?: { x: number; y: number }): PwNode => {
    const { label, link } = parseName(raw);
    let node = nodeMap.get(label);
    if (!node) {
      node = { key: label, label, group: group.id, link };
      nodeMap.set(label, node);
      spec.nodes.push(node);
    } else if (link && !node.link) {
      node.link = link;
    }
    if (position) Object.assign(node, position);
    return node;
  };

  const lines = src.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].replace(/\s+$/, '');
    if (!raw.trim()) continue;

    if (/^###/.test(raw)) {
      errors.push(`第 ${n + 1} 行：最多两级标题（# 标题 / ## 分组）`);
      continue;
    }
    if (/^##\s+/.test(raw)) {
      const parts = raw.replace(/^##\s+/, '').split('|').map((s) => s.trim());
      const name = parts[0] || `分组 ${spec.groups.length + 1}`;
      const hasColor = parts.length > 1 && isHex(parts[1]);
      const color = hasColor ? parts[1] : PALETTE[spec.groups.length % PALETTE.length];
      const noteParts = parts.slice(hasColor ? 2 : 1).filter(Boolean);
      cur = {
        id: `g${spec.groups.length}`,
        name,
        color,
        note: noteParts.length ? noteParts.join(' · ') : undefined,
      };
      spec.groups.push(cur);
      continue;
    }
    if (/^#\s+/.test(raw)) {
      spec.title = raw.replace(/^#\s+/, '').trim();
      continue;
    }
    if (/^>\s?/.test(raw)) {
      const group = ensureGroup();
      spec.notes.push({ group: group.id, text: raw.replace(/^>\s?/, '').trim() });
      continue;
    }
    if (/^@\s+/.test(raw)) {
      const group = ensureGroup();
      const declaration = raw.replace(/^@\s+/, '').trim();
      const match = /^(.*?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)$/.exec(declaration);
      const name = (match?.[1] ?? declaration).trim();
      const x = match ? Number(match[2]) : NaN;
      const y = match ? Number(match[3]) : NaN;
      if (name) addNode(name, group, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined);
      else errors.push(`第 ${n + 1} 行：节点声明不能为空`);
      continue;
    }

    const edge = splitEdge(raw);
    if (!edge) {
      errors.push(`第 ${n + 1} 行：应为“A -> B : 酶名”或“A <-> B : 酶名”`);
      continue;
    }
    const group = ensureGroup();
    const from = addNode(edge.left, group);
    const to = addNode(edge.right, group);
    spec.edges.push({
      from: from.key,
      to: to.key,
      label: edge.label,
      reversible: edge.reversible,
      relation: edge.relation,
      group: group.id,
    });
  }

  return { spec, errors };
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 粗略估算文本宽度：CJK 按 1em，拉丁按 0.58em（用于定节点框宽，不追求像素级） */
function textWidth(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) w += CJK.test(ch) ? fs : fs * 0.58;
  return w;
}

/** 按可用宽度把长文本折断成多行（CJK 逐字断，拉丁按字符近似） */
function wrapText(s: string, maxW: number, fs: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of s) {
    if (line && textWidth(line + ch, fs) > maxW) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * 内容派生的稳定 id：同一份源码永远得到同一个 id（渲染结果因此可缓存、可安全 memo），
 * 不同源码 id 不同。内联 SVG 共享同一个文档，用内容哈希足以让多张图互不串扰——
 * 只有两份**完全相同**的通路才会同 id，而它们的 defs 也完全相同，引用到谁都一样。
 */
function contentId(s: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = (Math.imul(b, 33) ^ c) >>> 0;
  }
  return `pw${(a >>> 0).toString(36)}${b.toString(36)}`;
}

/** Route an edge between node borders so the arrow tip stays attached while either node moves.
 *  `bend` offsets parallel edges to opposite sides of the chord so labels do not stack. */
export function routePathwayEdge(from: PwPoint, to: PwPoint, fromSize: PwNodeSize, toSize: PwNodeSize, bend = 0) {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const samePoint = Math.hypot(dx, dy) < 1;
  if (samePoint) { dx = 1; dy = 0; }
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const borderDistance = (size: PwNodeSize) => Math.min(
    Math.abs(ux) < 0.0001 ? Infinity : (size.width / 2 + 2) / Math.abs(ux),
    Math.abs(uy) < 0.0001 ? Infinity : (size.height / 2 + 2) / Math.abs(uy),
  );
  const startDistance = borderDistance(fromSize);
  const endDistance = borderDistance(toSize);
  const start = { x: from.x + ux * startDistance, y: from.y + uy * startDistance };
  const end = { x: to.x - ux * endDistance, y: to.y - uy * endDistance };

  if (samePoint) {
    const right = from.x + fromSize.width / 2 + 2;
    const top = from.y - fromSize.height / 2 - 2;
    const d = `M${right},${from.y} C${right + 48},${from.y - 4} ${from.x + 28},${top - 48} ${from.x},${top}`;
    return { d, labelX: right + 23, labelY: top - 20 };
  }

  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const handle = Math.max(18, Math.min(110, gap * 0.38));
  const offset = bend * Math.min(36, Math.max(14, gap * 0.18));
  const c1 = { x: start.x + ux * handle + px * offset, y: start.y + uy * handle + py * offset };
  const c2 = { x: end.x - ux * handle + px * offset, y: end.y - uy * handle + py * offset };
  const d = `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
  const labelX = (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8;
  const labelY = (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 - 8;
  return { d, labelX, labelY };
}

/** Recalculate all edge paths from their node positions; used during direct-manipulation drags. */
export function updatePathwaySvgEdges(svg: SVGSVGElement) {
  const nodes = new Map<string, { point: PwPoint; size: PwNodeSize }>();
  svg.querySelectorAll<SVGGElement>('.pw-node[data-pw-key]').forEach((node) => {
    const key = node.dataset.pwKey;
    const x = Number(node.dataset.pwX);
    const y = Number(node.dataset.pwY);
    const width = Number(node.dataset.pwW);
    const height = Number(node.dataset.pwH);
    if (key && [x, y, width, height].every(Number.isFinite)) nodes.set(key, { point: { x, y }, size: { width, height } });
  });
  svg.querySelectorAll<SVGGElement>('.pw-edge-group').forEach((edge) => {
    const from = nodes.get(edge.dataset.pwFrom ?? '');
    const to = nodes.get(edge.dataset.pwTo ?? '');
    if (!from || !to) return;
    const bend = Number(edge.dataset.pwBend);
    const route = routePathwayEdge(from.point, to.point, from.size, to.size, Number.isFinite(bend) ? bend : 0);
    const path = edge.querySelector<SVGPathElement>('.pw-edge');
    if (path) path.setAttribute('d', route.d);
    const label = edge.querySelector<SVGTextElement>('.pw-edge-label');
    if (label) {
      label.setAttribute('x', String(route.labelX));
      label.setAttribute('y', String(route.labelY));
    }
  });
}

function errorBlock(messages: string[]): string {
  const items = messages.slice(0, 6).map((m) => `<li>${esc(m)}</li>`).join('');
  return `<div class="pw-wrap pw-error"><b>通路图未渲染</b><ul>${items}</ul></div>`;
}

/**
 * 按源码缓存渲染结果：预览面板每次重渲染（几乎每个按键）都会走到 fence 规则，
 * 缓存让未改动的通路块直接复用上一次的 SVG 字符串，不必重建。
 * 满了逐出最旧一项（FIFO）而不是整表清空：清空会把笔记里其他未改动通路块的
 * 缓存一起干掉，它们下次重建（滚动/部件重建）就得全量重算布局。
 */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 64;

/** 把围栏块源码渲染成一段内联 SVG（已转义、无外部依赖） */
export function renderPathwaySvg(src: string): string {
  const cached = svgCache.get(src);
  if (cached !== undefined) return cached;
  const out = buildPathwaySvg(src);
  if (svgCache.size >= SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(src, out);
  return out;
}

function buildPathwaySvg(src: string): string {
  let parsed: PwParseResult;
  try {
    parsed = parsePathway(src);
  } catch (e) {
    return errorBlock([`解析异常：${(e as Error).message}`]);
  }
  const { spec, errors } = parsed;
  if (spec.edges.length === 0) {
    return errorBlock(
      errors.length
        ? errors
        : ['没有解析到通路。每行写成：葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶'],
    );
  }
  return renderSpec(spec, contentId(src));
}

function renderSpec(spec: PwSpec, id: string): string {
  const PAD = 44;
  const COL_W = 216;
  const ROW = 64;
  const NH = 32;
  const TITLE_Y = 30;
  const LANE_TOP = 48;
  const FIRST_Y = 112;

  const groups = spec.groups;
  const cols = groups.map((g) => ({ g, nodes: spec.nodes.filter((n) => n.group === g.id) }));
  const maxRows = Math.max(1, ...cols.map((c) => c.nodes.length));
  const noteW = COL_W - 30;
  const wrappedNotes = groups.map((g) =>
    spec.notes.filter((n) => n.group === g.id).flatMap((n) => wrapText(n.text, noteW, 11.5)),
  );
  const maxNoteLines = Math.max(0, ...wrappedNotes.map((l) => l.length));
  const noteH = maxNoteLines * 18;
  let width = PAD * 2 + cols.length * COL_W;
  let height = FIRST_Y + (maxRows - 1) * ROW + NH / 2 + (noteH ? noteH + 14 : 0) + 26;

  interface Pos { x: number; y: number; w: number; h: number; color: string }
  const pos = new Map<string, Pos>();
  // 未手动定位时按流向分层：源在上、产物在下，跨步边不再穿过同泳道中间节点。
  const rank = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const e of spec.edges) {
    if (e.from === e.to) continue;
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  const visiting = new Set<string>();
  const rankOf = (key: string): number => {
    const known = rank.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = incoming.get(key) ?? [];
    const value = parents.length ? Math.max(...parents.map(rankOf)) + 1 : 0;
    visiting.delete(key);
    rank.set(key, value);
    return value;
  };
  for (const n of spec.nodes) rankOf(n.key);
  const children = new Map<string, string[]>();
  for (const e of spec.edges) {
    if (e.from === e.to) continue;
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  cols.forEach((c, gi) => {
    const center = PAD + gi * COL_W + COL_W / 2;
    const members = new Set(c.nodes.map((n) => n.key));
    // 手动定位的节点（@ 节点 | x | y，来自通路工作区的拖拽/微调）：跳过自动布局，
    // 直接钉在指定坐标（负值夹到可见区，避免 viewBox 从 0 起把节点裁掉）。
    // 其余节点照常按流向分层；两类节点可以混排，连线两端位置各自取自 pos。
    const manual = new Map<string, { x: number; y: number }>();
    for (const n of c.nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const fixed = { x: Math.max(60, n.x!), y: Math.max(60, n.y!) };
      manual.set(n.key, fixed);
      pos.set(n.key, { x: fixed.x, y: fixed.y, w: textWidth(n.label, 14) + 30, h: NH, color: c.g.color });
    }
    const auto = c.nodes.filter((n) => !manual.has(n.key));
    const sibling = new Map<string, number>();
    const seen = new Set<string>();
    for (const n of auto) {
      const kids = (children.get(n.key) ?? []).filter((key) => members.has(key) && !seen.has(key) && !manual.has(key));
      if (kids.length < 2) continue;
      kids.forEach((key, index) => {
        sibling.set(key, index - (kids.length - 1) / 2);
        seen.add(key);
      });
    }
    const buckets = new Map<number, PwNode[]>();
    for (const n of auto) {
      const r = rank.get(n.key) ?? 0;
      buckets.set(r, [...(buckets.get(r) ?? []), n]);
    }
    let row = 0;
    for (const r of [...buckets.keys()].sort((a, b) => a - b)) {
      const rowNodes = buckets.get(r) ?? [];
      const branches = rowNodes.filter((n) => sibling.has(n.key));
      const trunks = rowNodes.filter((n) => !sibling.has(n.key));
      for (const n of trunks) {
        pos.set(n.key, { x: center, y: FIRST_Y + row * ROW, w: textWidth(n.label, 14) + 30, h: NH, color: c.g.color });
        row += 1;
      }
      if (branches.length) {
        const span = Math.min(88, (COL_W - 36) / Math.max(1, branches.length - 1));
        for (const n of branches) {
          const slot = sibling.get(n.key) ?? 0;
          pos.set(n.key, { x: center + slot * span, y: FIRST_Y + row * ROW, w: textWidth(n.label, 14) + 30, h: NH, color: c.g.color });
        }
        row += 1;
      }
    }
  });
  const noteY = Math.max(FIRST_Y + (maxRows - 1) * ROW + NH / 2 + 26, ...[...pos.values()].map((p) => p.y + p.h / 2 + 26));
  width = Math.max(width, ...[...pos.values()].map((p) => p.x + p.w / 2 + 36));
  height = Math.max(height, noteY + noteH + 20);

  const parts: string[] = [];
  parts.push(
    `<svg class="pw-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" ` +
      `xmlns="http://www.w3.org/2000/svg">`,
  );
  parts.push(
    `<defs><filter id="${id}-rough" x="-6%" y="-6%" width="112%" height="112%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.018 0.026" numOctaves="2" seed="9" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/>` +
      `</filter>`,
  );
  groups.forEach((g, gi) => {
    parts.push(
      `<marker id="${id}-a${gi}" markerWidth="12" markerHeight="12" refX="10" refY="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
        `<path d="M0,0 L10,6 L0,12 z" fill="${g.color}" stroke="${g.color}" stroke-width="0.8"/></marker>`,
      `<marker id="${id}-i${gi}" markerWidth="12" markerHeight="12" refX="10" refY="6" markerUnits="userSpaceOnUse" orient="auto">` +
        `<path d="M10,0 L10,12" stroke="${g.color}" stroke-width="2.4"/></marker>`,
    );
  });
  parts.push('</defs>');

  if (spec.title) {
    parts.push(`<text class="pw-title" x="${PAD - 14}" y="${TITLE_Y}">${esc(spec.title)}</text>`);
  }

  groups.forEach((g, gi) => {
    const x = PAD + gi * COL_W + 8;
    parts.push(
      `<rect class="pw-lane" x="${x}" y="${LANE_TOP}" width="${COL_W - 16}" height="${height - LANE_TOP - 14}" rx="14" ` +
        `fill="${g.color}" fill-opacity="0.05" stroke="${g.color}" stroke-opacity="0.22" stroke-width="1"/>`,
    );
    // 泳道标题把原色挂到自定义属性上，由 CSS 按主题向正文色混合到可读对比度
    // （用户显式写的 #hex 也照此自适应；fill 保留原色作为 color-mix 不可用时的回退）
    parts.push(
      `<text class="pw-group" x="${x + 12}" y="${LANE_TOP + 24}" style="--pw-gc:${esc(g.color)}" fill="${g.color}">${esc(g.name)}</text>`,
    );
    if (g.note) {
      parts.push(`<text class="pw-group-note" x="${x + 12}" y="${LANE_TOP + 43}">${esc(g.note)}</text>`);
    }
  });

  const edgeGroupIdx = new Map(groups.map((g, gi) => [g.id, gi]));
  const lines: string[] = [];
  const markerOf = (gid: string) => `url(#${id}-a${edgeGroupIdx.get(gid) ?? 0})`;
  const inhibitMarkerOf = (gid: string) => `url(#${id}-i${edgeGroupIdx.get(gid) ?? 0})`;
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const e of spec.edges) {
    const key = [e.from, e.to].sort().join('\0');
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  for (const e of spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const color = (groups[edgeGroupIdx.get(e.group) ?? 0] ?? groups[0]).color;
    const markerEnd = e.relation === 'inhibit' ? inhibitMarkerOf(e.group) : markerOf(e.group);
    const markerStart = e.reversible ? `marker-start="${markerOf(e.group)}"` : '';
    const pairKey = [e.from, e.to].sort().join('\0');
    const total = pairCount.get(pairKey) ?? 1;
    const index = pairIndex.get(pairKey) ?? 0;
    pairIndex.set(pairKey, index + 1);
    // 反向边的法线也反向，所以按字典序统一朝向，避免两条边弯到同一侧。
    const facing = e.from <= e.to ? 1 : -1;
    const bend = (total < 2 ? 0 : index - (total - 1) / 2) * facing;
    const route = routePathwayEdge(
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
      { width: a.w, height: a.h },
      { width: b.w, height: b.h },
      bend,
    );
    const edgeLabel = e.label
      ? `<text class="pw-enzyme pw-edge-label" x="${route.labelX}" y="${route.labelY}" text-anchor="middle">${esc(e.label)}</text>`
      : '';
    lines.push(
      `<g class="pw-edge-group" data-pw-from="${esc(e.from)}" data-pw-to="${esc(e.to)}" data-pw-bend="${bend}">` +
        `<path d="${route.d}" class="pw-edge" data-pw-relation="${e.relation}" stroke="${color}" ${markerStart} marker-end="${markerEnd}"/>` +
        edgeLabel +
      `</g>`,
    );
  }
  if (lines.length) {
    parts.push(`<g class="pw-lines">${lines.join('')}</g>`);
  }

  const nodeEls: string[] = [];
  for (const n of spec.nodes) {
    const p = pos.get(n.key);
    if (!p) continue;
    const x = p.x - p.w / 2;
    const y = p.y - p.h / 2;
    const box =
      `<g filter="url(#${id}-rough)"><rect class="pw-node-box" x="${x}" y="${y}" width="${p.w}" height="${p.h}" rx="9" ry="9" ` +
      `fill="${p.color}" fill-opacity="0.10" stroke="${p.color}" stroke-width="1.6"/></g>`;
    const label = `<text class="pw-label" x="${p.x}" y="${p.y + 5}" text-anchor="middle">${esc(n.label)}</text>`;
    const localBox = `<g transform="translate(${-p.x} ${-p.y})">${box}${label}</g>`;
    const inner = `<g class="pw-node" data-pw-key="${esc(n.key)}" data-pw-x="${p.x}" data-pw-y="${p.y}" data-pw-w="${p.w}" data-pw-h="${p.h}" transform="translate(${p.x} ${p.y})">${localBox}</g>`;
    nodeEls.push(
      n.link
        ? `<a class="pw-link lp-wiki" href="javascript:void(0)" data-lp-target="${esc(n.link.target)}" ` +
          `data-mv-target="${esc(n.link.target)}" aria-label="打开笔记：${esc(n.link.target)}">${inner}</a>`
        : inner,
    );
  }
  parts.push(`<g class="pw-nodes">${nodeEls.join('')}</g>`);

  const laneX = (gi: number) => PAD + gi * COL_W + 8 + 12;
  wrappedNotes.forEach((lines, gi) => {
    let yy = noteY;
    lines.forEach((line, li) => {
      parts.push(`<text class="pw-note" x="${laneX(gi)}" y="${yy}">${li === 0 ? '· ' : '   '}${esc(line)}</text>`);
      yy += 18;
    });
  });

  parts.push('</svg>');
  return `<div class="pw-wrap">${parts.join('')}</div>`;
}
