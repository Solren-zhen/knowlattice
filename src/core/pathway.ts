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
 * - `>` 开头：该分组的旁注，排在泳道底部
 *
 * 所有文本都经 XML 转义后拼进 SVG，不引入用户 HTML。
 */

export interface PwLink { target: string; label: string }
export interface PwGroup { id: string; name: string; color: string; note?: string }
export interface PwNode { key: string; label: string; group: string; link?: PwLink }
export interface PwEdge { from: string; to: string; label?: string; reversible: boolean; group: string }
export interface PwNote { group: string; text: string }
export interface PwSpec {
  title?: string;
  groups: PwGroup[];
  nodes: PwNode[];
  edges: PwEdge[];
  notes: PwNote[];
}
export interface PwParseResult { spec: PwSpec; errors: string[] }

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

interface RawEdge { left: string; right: string; reversible: boolean; label?: string }

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
  return { left, right: rest, reversible: op === '<->', label };
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

  const addNode = (raw: string, group: PwGroup): PwNode => {
    const { label, link } = parseName(raw);
    let node = nodeMap.get(label);
    if (!node) {
      node = { key: label, label, group: group.id, link };
      nodeMap.set(label, node);
      spec.nodes.push(node);
    } else if (link && !node.link) {
      node.link = link;
    }
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

function errorBlock(messages: string[]): string {
  const items = messages.slice(0, 6).map((m) => `<li>${esc(m)}</li>`).join('');
  return `<div class="pw-wrap pw-error"><b>通路图未渲染</b><ul>${items}</ul></div>`;
}

/**
 * 按源码缓存渲染结果：预览面板每次重渲染（几乎每个按键）都会走到 fence 规则，
 * 缓存让未改动的通路块直接复用上一次的 SVG 字符串，不必重建。
 */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 64;

/** 把围栏块源码渲染成一段内联 SVG（已转义、无外部依赖） */
export function renderPathwaySvg(src: string): string {
  const cached = svgCache.get(src);
  if (cached !== undefined) return cached;
  const out = buildPathwaySvg(src);
  if (svgCache.size >= SVG_CACHE_MAX) svgCache.clear();
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
  const width = PAD * 2 + cols.length * COL_W;
  const height = FIRST_Y + (maxRows - 1) * ROW + NH / 2 + (noteH ? noteH + 14 : 0) + 26;

  interface Pos { x: number; y: number; w: number; h: number; color: string }
  const pos = new Map<string, Pos>();
  cols.forEach((c, gi) => {
    const x = PAD + gi * COL_W + COL_W / 2;
    c.nodes.forEach((n, ri) => {
      pos.set(n.key, { x, y: FIRST_Y + ri * ROW, w: textWidth(n.label, 14) + 30, h: NH, color: c.g.color });
    });
  });

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
      `<marker id="${id}-a${gi}" markerWidth="9" markerHeight="8" refX="7.5" refY="3" orient="auto-start-reverse">` +
        `<path d="M0,0 L7.5,3 L0,6 z" fill="${g.color}"/></marker>`,
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
  const edgeLabels: string[] = [];
  const markerOf = (gid: string) => `url(#${id}-a${edgeGroupIdx.get(gid) ?? 0})`;
  for (const e of spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const color = (groups[edgeGroupIdx.get(e.group) ?? 0] ?? groups[0]).color;
    const markerEnd = markerOf(e.group);
    const markerStart = e.reversible ? `marker-start="${markerEnd}"` : '';

    if (Math.abs(a.x - b.x) < 1) {
      const down = b.y > a.y;
      const sy = a.y + (down ? a.h / 2 : -a.h / 2);
      const ty = b.y + (down ? -b.h / 2 : b.h / 2);
      const gi = edgeGroupIdx.get(e.group) ?? 0;
      const laneRight = PAD + gi * COL_W + COL_W - 8;
      const cross = spec.nodes
        .map((n) => pos.get(n.key))
        .filter((p): p is Pos => !!p && Math.abs(p.x - a.x) < 1 && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y));
      if (Math.abs(b.y - a.y) > ROW * 1.5 && cross.length > 0) {
        const half = Math.max(...cross.map((p) => p.w / 2));
        const bowX = Math.min(a.x + half + 14, laneRight - 8);
        lines.push(
          `<path d="M${a.x},${sy} C${bowX},${sy} ${bowX},${ty} ${b.x},${ty}" stroke="${color}" ${markerStart} marker-end="${markerEnd}"/>`,
        );
        if (e.label) {
          edgeLabels.push(
            `<text class="pw-enzyme pw-edge-label" x="${bowX + 4}" y="${(sy + ty) / 2 + 4}" text-anchor="start">${esc(e.label)}</text>`,
          );
        }
      } else {
        lines.push(`<path d="M${a.x},${sy} L${b.x},${ty}" stroke="${color}" ${markerStart} marker-end="${markerEnd}"/>`);
        if (e.label) {
          edgeLabels.push(
            `<text class="pw-enzyme pw-edge-label" x="${a.x + 12}" y="${(sy + ty) / 2 + 4}" text-anchor="start">${esc(e.label)}</text>`,
          );
        }
      }
    } else {
      const sign = b.x > a.x ? 1 : -1;
      const sx = a.x + sign * (a.w / 2 + 2);
      const tx = b.x - sign * (b.w / 2 + 2);
      const c1 = sx + sign * Math.max(46, Math.abs(tx - sx) * 0.45);
      const c2 = tx - sign * Math.max(46, Math.abs(tx - sx) * 0.45);
      lines.push(
        `<path d="M${sx},${a.y} C${c1},${a.y} ${c2},${b.y} ${tx},${b.y}" stroke="${color}" ${markerStart} marker-end="${markerEnd}"/>`,
      );
      if (e.label) {
        edgeLabels.push(
          `<text class="pw-enzyme pw-edge-label" x="${(sx + tx) / 2}" y="${(a.y + b.y) / 2 - 8}" text-anchor="middle">${esc(e.label)}</text>`,
        );
      }
    }
  }
  if (lines.length) {
    parts.push(`<g class="pw-lines" filter="url(#${id}-rough)">${lines.join('')}</g>`);
  }
  if (edgeLabels.length) {
    parts.push(`<g class="pw-edgelabels">${edgeLabels.join('')}</g>`);
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
    const inner = `<g class="pw-node">${box}${label}</g>`;
    nodeEls.push(
      n.link
        ? `<a class="pw-link lp-wiki" href="javascript:void(0)" data-lp-target="${esc(n.link.target)}" ` +
          `data-mv-target="${esc(n.link.target)}" aria-label="打开笔记：${esc(n.link.target)}">${inner}</a>`
        : inner,
    );
  }
  parts.push(`<g class="pw-nodes">${nodeEls.join('')}</g>`);

  const laneX = (gi: number) => PAD + gi * COL_W + 8 + 12;
  const noteY = FIRST_Y + (maxRows - 1) * ROW + NH / 2 + 26;
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
