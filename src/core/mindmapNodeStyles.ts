/**
 * 思维导图的**节点样式**：一篇笔记里，某些节点被设过字号/粗斜/颜色/形状等。
 *
 * 存哪儿、为什么（这是被明确拍过的决定，不是随手挑的）：
 *   ① **单键 localStorage + 随整包备份走**（vault.ts 的 import/export 链），
 *      与 core/noteMedia、core/cardEdits、core/mindmapPrefs 完全同一性质——
 *      它是**应用侧的呈现状态**（"这个节点上次被涂成红色"），不是笔记内容；
 *   ② 另一条路是写进笔记正文（比如藏一个注释块）。那样每篇被设过样式的笔记字节都会变，
 *      外部同步工具一律判成「被改过」，而复习卡、Anki 导出、统计都读正文——风险落在全部历史
 *      笔记上，收益只是「换机不用重新调样式」。所以正文一个字不动。
 *
 * 键的形状（**关键**）：
 *   笔记路径 → { 节点键 → 样式 }，节点键是**文本路径**（祖先主题文字 + 自己，用 \u0000 连接）。
 *   为什么不用节点 id：mind-elixir 的 id 每次打开都是重算的（mn1/mn2…），存下来下次一定错位。
 *   为什么不用下标路径（"0/2/1"）：在前面插一个同级节点，后面所有下标都会平移，
 *   样式就会**错位到别的节点上**；文本路径在最坏情况下只会**丢失**（改名/移动后找不到原路径），
 *   不会把红色涂到别人头上——两种坏法的严重程度差一个量级。
 *
 * 已知边界（写在这里，免得下次以为是漏了）：
 *   - 改名会就地迁移（见 MindMapView 监听库的 finishEdit）：改名的节点**以及它整棵子树**的键
 *     一起搬（键里含祖先文字，只搬自己会让子树样式变成孤儿、下次打开被 prune 掉）；
 *   - 拖动节点（换父级）暂不迁移，那一支的样式会丢；
 *   - 删掉节点后样式条目会成为孤儿，直到下次打开这篇导图时被 prune 掉；
 *   - 只白名单里的 CSS 属性进得来（脏值一律丢），一个坏值不能让导图打不开。
 */

/** 允许存下来的样式属性（camelCase，直接 correspond 到元素的 inline style）。
 *  库对 node.style 是**逐键赋值**（dist: `for (let t in n) e.style[t] = n[t]`），
 *  所以这里能自由扩展，不受 NodeObj.style 的类型声明限制（fontStyle / textAlign / borderRadius
 *  都不在声明里，但确实生效）。 */
export interface NodeStyle {
  fontSize?: string;
  fontFamily?: string;
  color?: string;
  background?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  textAlign?: string;
  borderRadius?: string;
  border?: string;
  borderBottom?: string;
}

/** 键 = 节点文本路径；值 = 该节点的样式（至少一项） */
export type NodeStyleMap = Record<string, NodeStyle>;
/** 键 = 笔记路径 */
export type NoteStyleMap = Record<string, NodeStyleMap>;

export const NODE_STYLE_KEY = 'knowlattice-mindmap-styles';

/** 文本路径的分隔符：主题文字里不会出现这个控制字符（同 vault 里路径签名的做法） */
const SEP = '\u0000';

/** 祖先主题（不含自己）+ 自己 → 节点键 */
export function nodePathKey(ancestors: string[], topic: string): string {
  return [...ancestors, topic].join(SEP);
}

/** 节点键 → 各层文字（界面提示/调试用） */
export function keyParts(key: string): string[] {
  return key.split(SEP);
}

/* ---------- 白名单：值必须像个正常的 CSS 值，认不得一律丢 ---------- */

const COLOR_RE = /^[#a-zA-Z0-9(),.%\s-]{1,48}$/;
const VALIDATORS: Record<keyof NodeStyle, (v: string) => boolean> = {
  fontSize: (v) => /^\d{1,3}(\.\d+)?(px|em|rem)$/.test(v),
  fontFamily: (v) => v.trim().length > 0 && v.length <= 80,
  color: (v) => COLOR_RE.test(v),
  background: (v) => COLOR_RE.test(v),
  fontWeight: (v) => /^(normal|bold|[1-9]00)$/.test(v),
  fontStyle: (v) => /^(normal|italic)$/.test(v),
  textDecoration: (v) => /^(none|underline|line-through|underline line-through|line-through underline)$/.test(v),
  textAlign: (v) => /^(left|center|right)$/.test(v),
  borderRadius: (v) => /^\d{1,3}(px|%)$|^9999px$/.test(v),
  border: (v) => COLOR_RE.test(v),
  borderBottom: (v) => COLOR_RE.test(v),
};

const STYLE_KEYS = Object.keys(VALIDATORS) as Array<keyof NodeStyle>;
/** 白名单键（界面要按它把「没设的项」显式清空，见 MindMapView.applyStyle） */
export const NODE_STYLE_KEYS: ReadonlyArray<keyof NodeStyle> = STYLE_KEYS;

/** 只留下认得的键 + 合法的值；一个都不剩返回 null（空样式 = 没设过） */
export function sanitizeStyle(input: unknown): NodeStyle | null {
  if (!input || typeof input !== 'object') return null;
  const src = input as Record<string, unknown>;
  const out: NodeStyle = {};
  for (const k of STYLE_KEYS) {
    const v = src[k];
    if (typeof v !== 'string') continue;
    if (!VALIDATORS[k](v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 合并样式补丁：`null` 值的键 = 清掉这一项（同 mindmapPrefs 的 `''` 语义） */
export function mergeStyle(base: NodeStyle | null, patch: Partial<Record<keyof NodeStyle, string | null>>): NodeStyle | null {
  const out: NodeStyle = { ...(base ?? {}) };
  for (const k of STYLE_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null) delete out[k];
    else if (typeof v === 'string' && VALIDATORS[k](v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- 存储（缓存按原始字符串比对，见文件头） ---------- */

let cacheRaw: string | null = null;
let cache: NoteStyleMap = {};

function parse(raw: string): NoteStyleMap {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: NoteStyleMap = {};
    for (const [note, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      const perNode: NodeStyleMap = {};
      for (const [key, style] of Object.entries(v as Record<string, unknown>)) {
        if (!key) continue;
        const clean = sanitizeStyle(style);
        if (clean) perNode[key] = clean;
      }
      if (Object.keys(perNode).length) out[note] = perNode;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读出整份映射；空/损坏的存储一律当空表 */
export function loadNoteStyles(): NoteStyleMap {
  let raw: string;
  try {
    raw = localStorage.getItem(NODE_STYLE_KEY) ?? '{}';
  } catch {
    return cache; // 隐私模式等拿不到存储：退回上一次读到的内容
  }
  if (raw === cacheRaw) return cache;
  cache = parse(raw);
  cacheRaw = raw;
  return cache;
}

function save(map: NoteStyleMap): void {
  cache = map;
  cacheRaw = JSON.stringify(map);
  try {
    localStorage.setItem(NODE_STYLE_KEY, cacheRaw);
  } catch {
    // 写不进去（配额/隐私模式）也不抛：样式丢了不影响任何数据
  }
}

/** 取一篇笔记的节点样式（**副本**：调用方改它不会污染缓存） */
export function getNoteStyles(notePath: string): NodeStyleMap {
  const m = loadNoteStyles()[notePath.trim()];
  if (!m) return {};
  const out: NodeStyleMap = {};
  for (const [k, v] of Object.entries(m)) out[k] = { ...v };
  return out;
}

/**
 * 写入一个节点的样式。`style === null` = 清掉该节点的样式。
 * 笔记下一条都不剩 → 连笔记键一起删（不留空壳）。返回新映射。
 */
export function setNodeStyle(notePath: string, nodeKey: string, style: NodeStyle | null): NoteStyleMap {
  const note = notePath.trim();
  if (!note || !nodeKey) return loadNoteStyles();
  const map: NoteStyleMap = { ...loadNoteStyles() };
  const perNode: NodeStyleMap = { ...(map[note] ?? {}) };
  const clean = style ? sanitizeStyle(style) : null;
  if (clean) perNode[nodeKey] = clean;
  else delete perNode[nodeKey];
  if (Object.keys(perNode).length) map[note] = perNode;
  else delete map[note];
  save(map);
  return map;
}

/**
 * 改名后把样式条目搬到新键。
 *
 * 为什么是**前缀**重写：节点键含祖先文字，祖先改名后整棵子树的键都变了。
 * 只搬改名节点自身的话，子树里那些样式会立刻变成孤儿，并在下次打开这篇导图时被 prune 掉
 * ——用户看到的是「父节点改个名，子节点的字号/颜色全没了」。
 * 与关系线/概要用的是同一套迁移（见 core/mindmapMarks.renameNodeMark）。
 * 搬过去的键已经存在时，后来的值覆盖先前的（同 mindmapMarks 的取舍：宁可覆盖，不跨节点乱串）。
 * 这篇笔记下一条都没有 / 键没变时：什么都不写。
 */
export function renameNodeStyle(notePath: string, oldKey: string, newKey: string): NoteStyleMap {
  const note = notePath.trim();
  if (!note || !oldKey || !newKey || oldKey === newKey) return loadNoteStyles();
  const cur = getNoteStyles(note);
  const keys = Object.keys(cur);
  if (!keys.length) return loadNoteStyles();
  const prefix = `${oldKey}${SEP}`;
  const perNode: NodeStyleMap = {};
  let moved = false;
  for (const k of keys) {
    const next = k === oldKey ? newKey : k.startsWith(prefix) ? `${newKey}${k.slice(oldKey.length)}` : k;
    if (next !== k) moved = true;
    perNode[next] = { ...cur[k] };
  }
  if (!moved) return loadNoteStyles();
  const map: NoteStyleMap = { ...loadNoteStyles() };
  map[note] = perNode;
  save(map);
  return map;
}

/** 清掉某一篇（或某几个键）的样式；不传 keys = 清掉整篇 */
export function clearNoteStyles(notePath: string, keys?: string[]): NoteStyleMap {
  const note = notePath.trim();
  const map: NoteStyleMap = { ...loadNoteStyles() };
  if (!note || !map[note]) return map;
  if (!keys) delete map[note];
  else {
    const perNode = { ...map[note] };
    for (const k of keys) delete perNode[k];
    if (Object.keys(perNode).length) map[note] = perNode;
    else delete map[note];
  }
  save(map);
  return map;
}

/** 丢掉树里已经不存在的键（改名/删除留下的孤儿）。返回新映射与丢掉的数量。 */
export function pruneNoteStyles(notePath: string, keys: string[]): { map: NoteStyleMap; dropped: number } {
  const note = notePath.trim();
  const cur = getNoteStyles(note);
  const alive = new Set(keys);
  const dead = Object.keys(cur).filter((k) => !alive.has(k));
  if (!dead.length) return { map: loadNoteStyles(), dropped: 0 };
  return { map: clearNoteStyles(note, dead), dropped: dead.length };
}

/** 导出全部（供整包备份用）；返回快照，改它不影响存储 */
export function exportNoteStyles(): NoteStyleMap {
  const out: NoteStyleMap = {};
  for (const [note, perNode] of Object.entries(loadNoteStyles())) {
    out[note] = {};
    for (const [k, v] of Object.entries(perNode)) out[note][k] = { ...v };
  }
  return out;
}

/** 从备份恢复（**合并**导入：同笔记同键覆盖，没提到的原样留着）；返回导入了几条节点样式 */
export function importNoteStyles(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const map: NoteStyleMap = { ...loadNoteStyles() };
  let n = 0;
  for (const [note, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!note || !v || typeof v !== 'object') continue;
    const perNode: NodeStyleMap = { ...(map[note] ?? {}) };
    for (const [key, style] of Object.entries(v as Record<string, unknown>)) {
      if (!key) continue;
      const clean = sanitizeStyle(style);
      if (!clean) continue;
      perNode[key] = clean;
      n++;
    }
    if (Object.keys(perNode).length) map[note] = perNode;
  }
  save(map);
  return n;
}

/* ---------- 树上的纯计算（初始化时把存下来的样式贴回节点） ---------- */

/** 能带样式的最小节点形状（只用到这三个字段，便于单测） */
export interface StylableNode {
  topic?: string;
  style?: NodeStyle;
  children?: StylableNode[];
}

/** 收集树里所有节点的文本路径键（顺便给 prune 用） */
export function collectNodeKeys(root: StylableNode, trail: string[] = []): string[] {
  const self = `${root.topic ?? ''}`;
  const path = [...trail, self];
  const out: string[] = [nodePathKey(trail, self)];
  for (const c of root.children ?? []) out.push(...collectNodeKeys(c, path));
  return out;
}

/**
 * 把存下来的样式贴回树（**就地改**，返回贴了几处）。初始化时用：
 * 库的 createTopic 是逐键赋值，所以只要 nodeData 里带 style，第一帧就是对的。
 * 不在存储里的节点保持 `undefined`（= 用主题的默认观感，与改动前逐字一致）。
 */
export function applyStoredStyles(root: StylableNode, styles: NodeStyleMap, trail: string[] = []): number {
  const self = `${root.topic ?? ''}`;
  const key = nodePathKey(trail, self);
  const hit = styles[key];
  let n = 0;
  if (hit) {
    root.style = { ...hit };
    n++;
  }
  const path = [...trail, self];
  for (const c of root.children ?? []) n += applyStoredStyles(c, styles, path);
  return n;
}

/* ---------- 界面预设（每组都是「键 → 值」的补丁，null = 清掉这一项） ---------- */

/** 一个预设项：`patch` 直接喂给 mergeStyle；`default: true` 的项 = 清掉该组的所有键 */
export interface StylePatch {
  id: string;
  label: string;
  patch: Partial<Record<keyof NodeStyle, string | null>>;
}

/**
 * 字体 / 字号 / 字色 / 底色 / 形状四组预设。
 * 为什么是「补丁」而不是直接给最终样式：样式是逐项的（一个节点可能只有粗体、没有字号），
 * 所以每次点一下只改它管的那几项，其余项（别的组设的）原样留着——同 mindmapPrefs 的 patch 语义。
 * 值都写成白名单能过的样子（含 `var(--accent)` 这类 token，深浅色主题下自动跟随）。
 */
export const STYLE_PRESETS: Record<'fontFamily' | 'fontSize' | 'color' | 'background' | 'shape', StylePatch[]> = {
  fontFamily: [
    { id: 'inherit', label: '默认字体', patch: { fontFamily: null } },
    { id: 'system', label: '系统默认', patch: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' } },
    { id: 'yahei', label: '微软雅黑', patch: { fontFamily: '"Microsoft YaHei", sans-serif' } },
    { id: 'sun', label: '宋体', patch: { fontFamily: 'SimSun, serif' } },
    { id: 'hei', label: '黑体', patch: { fontFamily: 'SimHei, sans-serif' } },
    { id: 'kai', label: '楷体', patch: { fontFamily: 'KaiTi, serif' } },
    { id: 'deng', label: '等线', patch: { fontFamily: 'DengXian, sans-serif' } },
    { id: 'mono', label: '等宽', patch: { fontFamily: 'Consolas, "Cascadia Mono", monospace' } },
  ],
  fontSize: [
    { id: 'auto', label: '默认字号', patch: { fontSize: null } },
    ...[12, 13, 14, 15, 16, 18, 20, 24, 28].map((n) => ({
      id: String(n),
      label: `${n}px`,
      patch: { fontSize: `${n}px` },
    })),
  ],
  color: [
    { id: 'auto', label: '默认字色', patch: { color: null } },
    { id: 'red', label: '红', patch: { color: '#dc2626' } },
    { id: 'orange', label: '橙', patch: { color: '#ea580c' } },
    { id: 'green', label: '绿', patch: { color: '#16a34a' } },
    { id: 'blue', label: '蓝', patch: { color: '#2563eb' } },
    { id: 'purple', label: '紫', patch: { color: '#7c3aed' } },
    { id: 'gray', label: '灰', patch: { color: '#64748b' } },
  ],
  background: [
    { id: 'auto', label: '默认底色', patch: { background: null } },
    { id: 'yellow', label: '淡黄', patch: { background: '#fef9c3' } },
    { id: 'blue', label: '淡蓝', patch: { background: '#dbeafe' } },
    { id: 'green', label: '淡绿', patch: { background: '#dcfce7' } },
    { id: 'red', label: '淡红', patch: { background: '#fee2e2' } },
    { id: 'purple', label: '淡紫', patch: { background: '#ede9fe' } },
  ],
  shape: [
    { id: 'round', label: '圆角矩形', patch: { borderRadius: '12px', border: null, borderBottom: null } },
    { id: 'square', label: '矩形', patch: { borderRadius: '0px', border: null, borderBottom: null } },
    {
      id: 'underline',
      label: '下划线',
      patch: { borderRadius: '0px', background: null, border: 'none', borderBottom: '2px solid var(--accent)' },
    },
    { id: 'pill', label: '椭圆（胶囊）', patch: { borderRadius: '9999px' } },
  ],
};
