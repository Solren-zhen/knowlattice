/**
 * 思维导图的**呈现偏好**：布局方向 / 主题 / 视图，按笔记存 localStorage。
 *
 * 为什么只存「呈现层」，不写进笔记：
 * 导图内容的唯一真相始终是笔记里的 Markdown 大纲（views/MindMapView 的 parseOutline/treeToMd）。
 * 复习卡（`## 小节`）、复习队列、统计、Anki 导出、备份全读它。把 layout/theme 写进 frontmatter，
 * 等于让**每一篇历史笔记**在下次保存时都变一次字节（外部同步工具一律判成"被改过"），
 * 而换来的只是省一个键。这份偏好本质是应用侧界面状态（"这篇笔记上次是用哪种配色看的图"），
 * 与 core/noteMedia、core/cardEdits 同一性质，所以用同一种存法：单键 localStorage。
 *
 * 为什么**也**接进整包备份（vault.ts，v12 起）：
 *   ① 它丢了不丢数据（最坏是回到默认观感），但换设备恢复后「每篇笔记上次用哪种配色看的图」
 *      得一篇篇重设——收益虽小，代价只是两行接线，不值得留个例外；
 *   ② 形状与 core/noteMedia 完全一致（键 = 笔记路径 → 对象），旧备份里没有这个字段时整段跳过，
 *      所以接进来不会让任何历史备份失效。
 *
 * 范式对齐 core/noteMedia：
 *   ① 单键 + 模块级缓存（界面每次渲染都会读）；
 *   ② 缓存按 **localStorage 原始字符串**比对（不是"第一次读到就永远用它"），
 *      外部直接写存储（另一个标签页、备份导入、测试里 clear）时下一次读自动失效重解析；
 *   ③ getX 返回**副本**、saveX 按字段合并、三项都空删键；
 *   ④ 读到的值一律过白名单：**一个脏值不能让导图打不开**（回默认值继续用）。
 *
 * 已知边界（写在这里，免得下次以为是漏了）：
 *   - 键 = 笔记路径，重命名/移动笔记等于换了一个键，旧偏好会变成孤儿留在存储里
 *     （不影响使用，只是不再命中）；
 *   - 路径为空时不写存储（见 saveMindMapPref），避免出现 `""` 这种野键。
 */

/** 布局方向（本模块只认这四个 id；映射到 mind-elixir 的真实枚举在 MindMapView 里做） */
export type MindMapDirection = 'side' | 'right' | 'down' | 'left';
/** 主题预设：follow = 跟随应用（改动前那套），其余三个：暖阳纸页 / 护眼绿 / 纯文字大纲 */
export type MindMapTheme = 'follow' | 'warm' | 'eye' | 'plain';
/** 视图：map = 思维导图，outline = 可编辑的纯文本缩进大纲 */
export type MindMapViewKind = 'map' | 'outline';
/**
 * 连线样式：curve = 库自带曲线（改动前那套，默认），ortho = 直角折线。
 * ortho 就是同类 App 里的「逻辑图 / 组织结构」那一路连线，和方向是两个独立的轴——
 * 医记通把它们做成了「逻辑向右 / 向右展开 / 树状向下 / 向下展开」四个按钮，
 * 本质是 2×2 的组合，这里按两个轴给，组合数一样但用户不必背四套名字。
 */
export type MindMapLine = 'curve' | 'ortho';
/**
 * 标题编号：none = 不编号（默认，改动前那套）；其余七个对齐医记通右栏「标题编号」那组。
 * 只影响**显示**（CSS 计数器），不改节点文字、也不写进笔记——见 MindMapView 里的实现说明。
 */
export type MindMapNumbering = 'none' | 'dot' | 'comma' | 'paren' | 'cn-dot' | 'cn-paren' | 'alpha' | 'circled';
/** 一篇笔记的偏好；字段缺省 = 用默认值 */
export interface MindMapPref {
  direction?: MindMapDirection;
  theme?: MindMapTheme;
  view?: MindMapViewKind;
  line?: MindMapLine;
  numbering?: MindMapNumbering;
}

/**
 * 保存时的补丁：**不给**该字段＝保留原值；显式给 `''`＝清掉该字段、回默认值。
 * 两种意图必须能区分，否则用户没法把某一项单独恢复成默认（同 core/noteMedia 的约定）。
 */
export type MindMapPatch = {
  direction?: MindMapDirection | '';
  theme?: MindMapTheme | '';
  view?: MindMapViewKind | '';
  line?: MindMapLine | '';
  numbering?: MindMapNumbering | '';
};

/** 键 = 笔记路径 */
export type MindMapPrefs = Record<string, MindMapPref>;

/** 补齐默认值后的偏好（界面直接用它，不必自己 `?? 'side'`） */
export type ResolvedMindMapPref = Required<MindMapPref>;

export const DIRECTION_IDS: readonly MindMapDirection[] = ['side', 'right', 'down', 'left'];
export const THEME_IDS: readonly MindMapTheme[] = ['follow', 'warm', 'eye', 'plain'];
export const VIEW_IDS: readonly MindMapViewKind[] = ['map', 'outline'];
export const LINE_IDS: readonly MindMapLine[] = ['curve', 'ortho'];
export const NUMBERING_IDS: readonly MindMapNumbering[] = [
  'none', 'dot', 'comma', 'paren', 'cn-dot', 'cn-paren', 'alpha', 'circled',
];

/** 没存过任何偏好时的观感：与加入偏好之前的观感**逐字一致**
 *  （双向展开 + 跟随应用 + 导图视图 + 曲线连线 + 不编号） */
export const MINDMAP_DEFAULTS: ResolvedMindMapPref = {
  direction: 'side',
  theme: 'follow',
  view: 'map',
  line: 'curve',
  numbering: 'none',
};

const KEY = 'knowlattice-mindmap-prefs';

/** 缓存原文（localStorage 里的原始字符串）与解析结果；两者一起换，见文件头说明 */
let cacheRaw: string | null = null;
let cache: MindMapPrefs = {};

/** 白名单取值：认得才要，认不得一律当"没给" */
function pick<T extends string>(v: unknown, ids: readonly T[]): T | undefined {
  return typeof v === 'string' && (ids as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * 主题取值：白名单 + **旧 id 别名**。
 * 为什么需要别名：`classic`（经典圆弧）已删除——它与默认主题的差别只有 6 个间距/圆角数值，
 * 曲线形状与配色完全一致（用户反馈「看不出区别」，详见 MindMapView 里 warmTheme 的注释）。
 * 它唯一真实的价值（更舒展的间距）由新主题 `warm` 接手，所以老笔记里存着的 `classic`
 * 直接映射过去，比静默重置成默认更贴合用户当初的选择。
 */
const THEME_ALIAS: Record<string, MindMapTheme> = { classic: 'warm' };
function pickTheme(v: unknown): MindMapTheme | undefined {
  return pick(v, THEME_IDS) ?? (typeof v === 'string' ? THEME_ALIAS[v] : undefined);
}

/** 剔除认不得的字段；一个都不剩就返回 null（空壳记录不留） */
function sanitize(patch: Partial<MindMapPref>): MindMapPref | null {
  const direction = pick(patch.direction, DIRECTION_IDS);
  const theme = pickTheme(patch.theme);
  const view = pick(patch.view, VIEW_IDS);
  const line = pick(patch.line, LINE_IDS);
  const numbering = pick(patch.numbering, NUMBERING_IDS);
  if (!direction && !theme && !view && !line && !numbering) return null;
  return {
    ...(direction ? { direction } : {}),
    ...(theme ? { theme } : {}),
    ...(view ? { view } : {}),
    ...(line ? { line } : {}),
    ...(numbering ? { numbering } : {}),
  };
}

/** 解析原始字符串；坏 JSON / 非对象条目一律丢掉，不抛错（存储是用户机器上的，脏了也得能开） */
function parse(raw: string): MindMapPrefs {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: MindMapPrefs = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      const e = sanitize(v as Partial<MindMapPref>);
      if (e) out[k] = e;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读出整份映射；空/损坏的存储一律当空表 */
export function loadMindMapPrefs(): MindMapPrefs {
  let raw: string;
  try {
    raw = localStorage.getItem(KEY) ?? '{}';
  } catch {
    // 隐私模式等拿不到存储：退回上一次读到的内容，界面不至于白屏
    return cache;
  }
  if (raw === cacheRaw) return cache;
  cache = parse(raw);
  cacheRaw = raw;
  return cache;
}

function save(map: MindMapPrefs) {
  cache = map;
  cacheRaw = JSON.stringify(map);
  try {
    localStorage.setItem(KEY, cacheRaw);
  } catch {
    // 写不进去（配额/隐私模式）也不抛：这份偏好是纯观感，丢掉不影响任何数据
  }
}

/**
 * 取一篇笔记的偏好；没存过返回 null。
 * 返回**副本**：调用方拿它拼 patch 再存回去，原地改会污染模块缓存
 * （下一次读到的就是被改过的对象，而"存储里并没有"）。
 */
export function getMindMapPref(path: string): MindMapPref | null {
  const m = loadMindMapPrefs()[path.trim()];
  return m ? { ...m } : null;
}

/** 取一篇笔记**生效**的偏好：缺的字段补默认值 */
export function resolveMindMapPref(path: string): ResolvedMindMapPref {
  return { ...MINDMAP_DEFAULTS, ...(getMindMapPref(path) ?? {}) };
}

/**
 * 写入偏好（逐字段合并的 patch）：
 *   - 没给的字段（undefined）→ 保留原值（换主题不会顺手把布局重置）；
 *   - `''` → 清掉这一项（回默认观感，等于"重置这一项"）；
 *   - 认不得的值 → 当没给：宁可不动，也不把一个脏值写进存储（否则每次读都得再兜底一次）。
 * 合并后三项都空 → 整条记录删掉（不留空壳）。一律返回**新对象**：视图把它放进 state 时，
 * 原地改再返回同一引用会被判定为"没变化"而不重渲染（同 core/noteMedia 的坑）。
 *
 * `now` 只为与 core/noteMedia / core/cardEdits 的签名对齐（调用方不必记两套）；
 * 这份偏好没有 updatedAt 字段，时间戳没有落点，所以显式 `void` 掉表示"有意忽略"。
 */
export function saveMindMapPref(path: string, patch: MindMapPatch, now = Date.now()): MindMapPrefs {
  void now;
  const key = path.trim();
  // 路径为空（界面没传 noteKey 且标题也空）就不写：不然会攒出一个 `""` 野键
  if (!key) return loadMindMapPrefs();
  const prev = loadMindMapPrefs()[key] ?? {};
  const clean = sanitize({
    direction: patch.direction === undefined ? prev.direction : pick(patch.direction, DIRECTION_IDS),
    theme: patch.theme === undefined ? prev.theme : pickTheme(patch.theme),
    view: patch.view === undefined ? prev.view : pick(patch.view, VIEW_IDS),
    line: patch.line === undefined ? prev.line : pick(patch.line, LINE_IDS),
    numbering: patch.numbering === undefined ? prev.numbering : pick(patch.numbering, NUMBERING_IDS),
  });
  const map: MindMapPrefs = { ...loadMindMapPrefs() };
  if (clean) map[key] = clean;
  else delete map[key];
  save(map);
  return map;
}

/** 清掉一篇笔记的偏好（回到全默认）。返回新映射。 */
export function clearMindMapPref(path: string): MindMapPrefs {
  const map: MindMapPrefs = { ...loadMindMapPrefs() };
  delete map[path.trim()];
  save(map);
  return map;
}

/** 导出全部偏好（供整包备份用）；返回的是快照，改它不影响存储 */
export function exportMindMapPrefs(): MindMapPrefs {
  const out: MindMapPrefs = {};
  for (const [k, v] of Object.entries(loadMindMapPrefs())) out[k] = { ...v };
  return out;
}

/**
 * 从备份恢复（**合并**导入：同键覆盖，没提到的键原样留着）；返回导入了几条。
 * 非法输入不抛错、也不动已存数据：备份是用户手里的文件，坏一条不该毁掉整份偏好。
 */
export function importMindMapPrefs(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const map: MindMapPrefs = { ...loadMindMapPrefs() };
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = sanitize(v as Partial<MindMapPref>);
    if (!e) continue;
    map[k] = e;
    n++;
  }
  save(map);
  return n;
}
