/**
 * 思维导图的**关系线与概要**（统称「标记」）的存储与重建。
 *
 * 与 core/mindmapNodeStyles 完全同一套范式（那边存节点样式，这边存线）：
 *   ① 单键 localStorage（`knowlattice-mindmap-marks`）+ 随整包备份走（vault.ts 的 import/export 链）；
 *      **笔记正文一个字节不动**——它只是「这篇图上有几条线」这种应用侧状态；
 *   ② 缓存按 localStorage 原始字符串比对，外部写存储后下次读自动失效重解析；
 *   ③ 读到的值一律过白名单/校验：一个脏值不能让导图打不开。
 *
 * 键的形状（**关键**，与节点样式同源）：
 *   笔记路径 → { arrows: [...], summaries: [...] }，而每条线的**端点用节点文本路径**记录
 *   （祖先主题 + 自己，`\u0000` 连接，见 core/mindmapNodeStyles.nodePathKey）。
 *   为什么不用库的节点 id：id 每次打开都重算（mn1/mn2…），存下来下次必然指错节点；
 *   文本路径最坏只是「端点找不到了，这条线不画」，绝不会连到别人身上。
 *
 * 重建（打开笔记时）：`resolveMarks` 把文本路径还原成库的节点 id，再由调用方交给
 *   `createArrowFrom(arrow)` / `createSummaryFrom(summary)` —— 库就用这两个接口重建。
 *
 * 已知边界（写在明处，不当成漏做）：
 *   - 关系线被手动拖过的**控制点偏移**（delta1/delta2）不存：重建后回到库的默认走线；
 *   - 概要记录的是「父节点 + 子节点起止下标」，所以在那段子节点里增删会让区间含义漂移
 *     （库自己的 Summary 数据形状就是这样，我们照它的形状存，才能在重建时原样喂回去）；
: *   - 端点节点被**改名**后，键会跟着前缀重写搬到新名字（见 renameNodeMark，视图在 finishEdit 时调用）；
: *     被**删除**后，那条线会**静静地不再画**（不做报错、不猜别的节点）——安全的一侧。
 */
import { nodePathKey } from './mindmapNodeStyles';

/** 能参与标记计算的最小节点形状（与 StylableNode 兼容，额外要求 id） */
export interface MarkNode {
  id?: string;
  topic?: string;
  children?: MarkNode[];
}

/* ---------- 数据形状（与库的 Arrow / Summary 对齐，只留值得存的字段） ---------- */

export interface MarkArrowStyle {
  stroke?: string;
  strokeWidth?: string | number;
  strokeDasharray?: string;
  opacity?: string | number;
  labelColor?: string;
}

/** 一条关系线：两端用**节点文本路径**记录 */
export interface MarkArrow {
  from: string;
  to: string;
  label?: string;
  bidirectional?: boolean;
  style?: MarkArrowStyle;
}

export interface MarkSummary {
  /** 父节点的文本路径（概要是挂在某个父节点下的一段子节点区间） */
  parent: string;
  start: number;
  end: number;
  label?: string;
  style?: { stroke?: string; labelColor?: string };
}

export interface NoteMarks {
  arrows?: MarkArrow[];
  summaries?: MarkSummary[];
}

/** 键 = 笔记路径 */
export type MarkMap = Record<string, NoteMarks>;

export const MARK_KEY = 'knowlattice-mindmap-marks';

/* ---------- 校验（脏值一律丢；标签限长、样式限值域） ---------- */

const COLOR_RE = /^[#a-zA-Z0-9(),.%\s-]{1,48}$/;
const DASH_RE = /^[0-9.\s,]{1,24}$|^(solid|dashed|dotted)$/;
const LABEL_MAX = 120;

function str(v: unknown, max = LABEL_MAX): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function color(v: unknown): string | undefined {
  return typeof v === 'string' && COLOR_RE.test(v) ? v : undefined;
}

function sanitizeArrowStyle(input: unknown): MarkArrowStyle | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const s = input as Record<string, unknown>;
  const out: MarkArrowStyle = {};
  const stroke = color(s.stroke);
  if (stroke) out.stroke = stroke;
  const labelColor = color(s.labelColor);
  if (labelColor) out.labelColor = labelColor;
  const dash = typeof s.strokeDasharray === 'string' && DASH_RE.test(s.strokeDasharray) ? s.strokeDasharray : undefined;
  if (dash) out.strokeDasharray = dash;
  // strokeWidth：数字（0 < w ≤ 20）或等价的字符串；范围外的当脏值丢
  const width = num(s.strokeWidth);
  if (width !== undefined && width > 0 && width <= 20) out.strokeWidth = width;
  else if (typeof s.strokeWidth === 'string' && /^\d{1,2}(\.\d+)?$/.test(s.strokeWidth)) {
    const w = Number(s.strokeWidth);
    if (w > 0 && w <= 20) out.strokeWidth = s.strokeWidth;
  }
  // opacity：只在 0..1 之内。越界的一律丢——否则一条线可能整条看不见，用户还找不到原因。
  const op = num(s.opacity);
  if (op !== undefined && op >= 0 && op <= 1) out.opacity = op;
  else if (typeof s.opacity === 'string' && /^(0|1|0?\.\d{1,2})$/.test(s.opacity)) out.opacity = s.opacity;
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeArrow(input: unknown): MarkArrow | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as Record<string, unknown>;
  const from = str(a.from);
  const to = str(a.to);
  if (!from || !to || from === to) return null; // 端点必须是两个不同的节点
  const out: MarkArrow = { from, to };
  const label = str(a.label);
  if (label) out.label = label;
  if (a.bidirectional === true) out.bidirectional = true;
  const style = sanitizeArrowStyle(a.style);
  if (style) out.style = style;
  return out;
}

export function sanitizeSummary(input: unknown): MarkSummary | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as Record<string, unknown>;
  const parent = str(s.parent);
  const start = num(s.start);
  const end = num(s.end);
  if (!parent || start === undefined || end === undefined) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  const out: MarkSummary = { parent, start, end };
  const label = str(s.label);
  if (label) out.label = label;
  const style = s.style && typeof s.style === 'object' ? (s.style as Record<string, unknown>) : null;
  if (style) {
    const kept: { stroke?: string; labelColor?: string } = {};
    const stroke = color(style.stroke);
    if (stroke) kept.stroke = stroke;
    const labelColor = color(style.labelColor);
    if (labelColor) kept.labelColor = labelColor;
    if (Object.keys(kept).length) out.style = kept;
  }
  return out;
}

/** 逐条过校验；一条都不剩返回 null（该笔记没有任何标记） */
export function sanitizeNoteMarks(input: unknown): NoteMarks | null {
  if (!input || typeof input !== 'object') return null;
  const m = input as Record<string, unknown>;
  const arrows = Array.isArray(m.arrows)
    ? m.arrows.map(sanitizeArrow).filter((a): a is MarkArrow => !!a)
    : [];
  const summaries = Array.isArray(m.summaries)
    ? m.summaries.map(sanitizeSummary).filter((s): s is MarkSummary => !!s)
    : [];
  if (!arrows.length && !summaries.length) return null;
  return { ...(arrows.length ? { arrows } : {}), ...(summaries.length ? { summaries } : {}) };
}

/* ---------- 存储 ---------- */

let cacheRaw: string | null = null;
let cache: MarkMap = {};

function parse(raw: string): MarkMap {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: MarkMap = {};
    for (const [note, v] of Object.entries(obj)) {
      if (!note || !v || typeof v !== 'object') continue;
      const clean = sanitizeNoteMarks(v);
      if (clean) out[note] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadMarks(): MarkMap {
  let raw: string;
  try {
    raw = localStorage.getItem(MARK_KEY) ?? '{}';
  } catch {
    return cache; // 隐私模式等拿不到存储：退回上次读到的内容
  }
  if (raw === cacheRaw) return cache;
  cache = parse(raw);
  cacheRaw = raw;
  return cache;
}

function save(map: MarkMap): void {
  cache = map;
  cacheRaw = JSON.stringify(map);
  try {
    localStorage.setItem(MARK_KEY, cacheRaw);
  } catch {
    // 写不进去（配额/隐私模式）也不抛：标记丢了不影响笔记内容
  }
}

/** 取一篇笔记的标记（**副本**） */
export function getNoteMarks(notePath: string): NoteMarks {
  const m = loadMarks()[notePath.trim()];
  if (!m) return {};
  return {
    ...(m.arrows ? { arrows: m.arrows.map((a) => ({ ...a, ...(a.style ? { style: { ...a.style } } : {}) })) } : {}),
    ...(m.summaries ? { summaries: m.summaries.map((s) => ({ ...s, ...(s.style ? { style: { ...s.style } } : {}) })) } : {}),
  };
}

/** 写入一篇笔记的全部标记；空 → 删掉该笔记的键（不留空壳） */
export function setNoteMarks(notePath: string, marks: NoteMarks): MarkMap {
  const note = notePath.trim();
  if (!note) return loadMarks();
  const map: MarkMap = { ...loadMarks() };
  const clean = sanitizeNoteMarks(marks);
  if (clean) map[note] = clean;
  else delete map[note];
  save(map);
  return map;
}

/** 清掉一篇笔记的标记（回到「没有任何线」） */
export function clearNoteMarks(notePath: string): MarkMap {
  return setNoteMarks(notePath, {});
}
/**
 * 节点改名后把标记里的键搬到新名字（视图在库发 finishEdit 时调用）。
 *
 * 为什么是**前缀**重写，而不像 renameNodeStyle 那样只搬那一个键：
 * 关系线的两端、概要的父节点记的都是**含祖先的完整文本路径**，祖先改名后整棵子树的路径都变了；
 * 只搬改名节点自身的话，子树里那些端点上的线会静静地不再画。
 * 删除不在这里处理——删掉的节点没有新名字可搬，仍按「端点找不到就不画」走。
 *
 * 一篇没有标记、或名字没变（oldKey === newKey）时：什么都不写，直接把当前表返回。
 */
export function renameNodeMark(notePath: string, oldKey: string, newKey: string): MarkMap {
  const note = notePath.trim();
  if (!note || !oldKey || !newKey || oldKey === newKey) return loadMarks();
  const cur = getNoteMarks(note);
  if (!cur.arrows?.length && !cur.summaries?.length) return loadMarks();
  const prefix = `${oldKey}\u0000`;
  const move = (k: string): string =>
    k === oldKey ? newKey : k.startsWith(prefix) ? `${newKey}${k.slice(oldKey.length)}` : k;
  const arrows = (cur.arrows ?? [])
    .map((a) => ({ ...a, from: move(a.from), to: move(a.to) }))
    // 两端被搬到同一个键（把节点改成与另一个已有节点同名）后这条线没有意义了：丢掉。
    // 留着也过不了 sanitize（两端必须不同），所以两种做法结果一样——这里把话说明白。
    .filter((a) => a.from !== a.to);
  const summaries = (cur.summaries ?? []).map((s) => ({ ...s, parent: move(s.parent) }));
  return setNoteMarks(note, {
    ...(arrows.length ? { arrows } : {}),
    ...(summaries.length ? { summaries } : {}),
  });
}

/** 导出全部（供整包备份用）；返回快照 */
export function exportMarks(): MarkMap {
  const out: MarkMap = {};
  for (const note of Object.keys(loadMarks())) out[note] = getNoteMarks(note);
  return out;
}

/** 从备份恢复（**合并**：同笔记整份覆盖，没提到的原样留着）；返回导入了几篇的标记 */
export function importMarks(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const map: MarkMap = { ...loadMarks() };
  let n = 0;
  for (const [note, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!note) continue;
    const clean = sanitizeNoteMarks(v);
    if (!clean) continue;
    map[note] = clean;
    n++;
  }
  save(map);
  return n;
}

/* ---------- 树上的纯计算：序列化（id → 文本路径键）与重建（键 → id） ---------- */

/** 节点键 → 节点 id（重建时把文本路径还原成库的 id；端点对不上就不画） */
export function indexByKey(root: MarkNode, trail: string[] = [], out: Map<string, string> = new Map()): Map<string, string> {
  const self = `${root.topic ?? ''}`;
  if (root.id) out.set(nodePathKey(trail, self), root.id);
  const path = [...trail, self];
  for (const c of root.children ?? []) indexByKey(c, path, out);
  return out;
}

/**
 * 节点 id → 节点键（**整表一次建好**，与 indexByKey 互为反表，复用同一个 nodePathKey）。
 *
 * 为什么要有它：序列化时每次改一条线都要把一堆端点 id 换算成文本路径，而 keyOfId 是
 * 每个 id 各自递归整棵树 → O(端点数 × 节点数)。大图连改几条线就要重扫好几遍整棵树。
 * 建一次表之后每个端点是 O(1) 查表，存进 localStorage 的内容与逐个 keyOfId 的结果逐字相同。
 *
 * 只收有 id 的节点；同一个 id 出现多次时**保留先遍历到的那个**——keyOfId 是深度优先取第一个命中，
 * 这里必须与它一致，否则改线后存下的键会和重建时认到的节点错位。
 */
export function keyIndex(root: MarkNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: MarkNode, trail: string[]): void => {
    const self = `${node.topic ?? ''}`;
    if (node.id && !out.has(node.id)) out.set(node.id, nodePathKey(trail, self));
    const path = [...trail, self];
    for (const c of node.children ?? []) walk(c, path);
  };
  walk(root, []);
  return out;
}
/** 节点 id → 节点键（持久化时把库的 id 换回文本路径；找不到返回 null） */
export function keyOfId(root: MarkNode | null, id: string): string | null {
  if (!root) return null;
  const walk = (node: MarkNode, trail: string[]): string | null => {
    const self = `${node.topic ?? ''}`;
    if (node.id === id) return nodePathKey(trail, self);
    const path = [...trail, self];
    for (const c of node.children ?? []) {
      const hit = walk(c, path);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, []);
}

/** 库里的箭头/概要（id 形态）→ 可存的标记（文本路径形态）。resolve 返回 null 的条目直接丢。 */
/**
 * 库里的箭头/概要 → 可存的标记（id → 文本路径）。resolve 返回 null 的条目直接丢。
 * 入参按**宽松形状**接（库的 Arrow/Summary 里还有 delta1/delta2 等我们不存的字段），
 * 内部一律走 sanitize：只留下白名单里的东西——这样调用方不必做一堆 cast，
 * 库将来加了什么新字段也不会被我们悄悄存进 localStorage。
 */
export function serializeMarks(
  input: {
    arrows?: ReadonlyArray<{ from?: unknown; to?: unknown; label?: unknown; bidirectional?: unknown; style?: unknown }>;
    summaries?: ReadonlyArray<{ parent?: unknown; start?: unknown; end?: unknown; label?: unknown; style?: unknown }>;
  },
  resolve: (id: string) => string | null,
): NoteMarks {
  const arrows: MarkArrow[] = [];
  for (const a of input.arrows ?? []) {
    const from = typeof a.from === 'string' ? resolve(a.from) : null;
    const to = typeof a.to === 'string' ? resolve(a.to) : null;
    if (!from || !to || from === to) continue;
    const clean = sanitizeArrow({ from, to, label: a.label, bidirectional: a.bidirectional, style: a.style });
    if (clean) arrows.push(clean);
  }
  const summaries: MarkSummary[] = [];
  for (const s of input.summaries ?? []) {
    const parent = typeof s.parent === 'string' ? resolve(s.parent) : null;
    if (!parent) continue;
    const clean = sanitizeSummary({ parent, start: s.start, end: s.end, label: s.label, style: s.style });
    if (clean) summaries.push(clean);
  }
  return { ...(arrows.length ? { arrows } : {}), ...(summaries.length ? { summaries } : {}) };
}

/** 存的标记（文本路径形态）→ 库的重建参数（id 形态）。端点/父节点找不到的条目直接跳过。 */
export function resolveMarks(
  root: MarkNode,
  marks: NoteMarks,
): {
  arrows: Array<Omit<MarkArrow, 'from' | 'to'> & { from: string; to: string }>;
  summaries: Array<Omit<MarkSummary, 'parent'> & { parent: string }>;
} {
  const byKey = indexByKey(root);
  const arrows: Array<Omit<MarkArrow, 'from' | 'to'> & { from: string; to: string }> = [];
  for (const a of marks.arrows ?? []) {
    const from = byKey.get(a.from);
    const to = byKey.get(a.to);
    if (!from || !to || from === to) continue;
    arrows.push({ ...a, from, to });
  }
  const summaries: Array<Omit<MarkSummary, 'parent'> & { parent: string }> = [];
  for (const s of marks.summaries ?? []) {
    const parent = byKey.get(s.parent);
    if (!parent) continue;
    summaries.push({ ...s, parent });
  }
  return { arrows, summaries };
}


