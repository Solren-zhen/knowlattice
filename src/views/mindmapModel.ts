/**
 * 思维导图的「模型层」：节点类型、主题（22 个 CSS 变量 + 三套预设）、Markdown 大纲互转。
 *
 * 从 MindMapView.tsx 搬出来（那个文件 1690 行，改一个主题色也要先读完整块交互逻辑）。
 * 这里没有一个 React import：入参是 md 或树，出参是 md / mind-elixir 的 data，
 * 所以往返转换可以直接单测（见 __tests__/mindmapModel.test.ts）。
 */
import MindElixir, { type MainLineParams, type SubLineParams, type Theme } from 'mind-elixir';
import type { MindMapDirection, MindMapLine, MindMapTheme } from '../core/mindmapPrefs';
import type { NodeStyle } from '../core/mindmapNodeStyles';
import { orthoMainBranch, orthoSubBranch } from '../core/mindmapStyles';

export type TNode = { id: string; content: string; children: TNode[] };
/** mind-elixir 的节点形状（只用到我们碰的那几个字段） */
export type MindNode = {
  id?: string;
  topic?: string;
  children?: unknown[];
  /** 节点自己的样式（白名单键，见 core/mindmapNodeStyles） */
  style?: NodeStyle;
  /** 库在构建时挂上的父引用：算文本路径键要用它（根节点没有） */
  parent?: MindNode;
};
let seq = 0;
const nid = () => `mn${++seq}`;

/** 笔记开头的 YAML frontmatter：导图只管正文，写回时原样拼回去 */
export const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;


/**
 * 主分支配色：取自应用背景极光图的同一组色相（靛蓝 → 青 → 紫 → 蓝绿），
 * 保证脑图和整体视觉同源，而不是随便挑一组鲜艳颜色。
 */
const PALETTE = ['#4f46e5', '#0891b2', '#7c3aed', '#0d9488', '#2563eb', '#c026d3', '#0ea5e9', '#a855f7'];

/**
 * 把 mind-elixir 的 22 个 CSS 变量接到本项目的设计 token 上。
 * 关键点：**全部写成 var(--token)**，不写死颜色——
 * 深色主题在 [data-theme='dark'] 里重定义了这些 token，
 * 于是切换主题时变量自动重解析，脑图即时跟随，不需要重建实例。
 */
const CSS_VARS = {
  '--node-gap-x': '26px',
  '--node-gap-y': '9px',
  '--main-gap-x': '58px',
  '--main-gap-y': '40px',
  '--root-radius': '11px',
  '--main-radius': '9px',
  '--root-color': 'var(--accent-ink)',
  '--root-bgcolor': 'var(--accent)',
  '--root-border-color': 'transparent',
  '--main-border': '1px solid var(--border)',
  '--main-color': 'var(--text)',
  '--main-bgcolor': 'var(--bg-raised)',
  '--main-bgcolor-transparent': 'var(--bg-raised)',
  '--topic-padding': '2px',
  '--color': 'var(--muted)',
  '--bgcolor': 'var(--bg)',
  '--selected': 'var(--accent-ring)',
  '--accent-color': 'var(--accent)',
  '--panel-color': 'var(--text)',
  '--panel-bgcolor': 'var(--bg-raised)',
  '--panel-border-color': 'var(--border)',
  '--map-padding': '56px 72px',
} as const;

/** 默认主题：改动前那一套，一个像素都不动 */
function knowlatticeTheme(dark: boolean): Theme {
  return {
    name: dark ? 'knowlattice-dark' : 'knowlattice-light',
    type: (dark ? 'dark' : 'light') as 'dark' | 'light',
    palette: PALETTE,
    cssVar: { ...CSS_VARS },
  };
}

/**
 * 「暖阳纸页」：暖色纸面 + 琥珀主分支 + 柔光卡片。
 *
 * 它取代了原来的「经典圆弧」——那个主题与默认主题的差别只有 6 个间距/圆角数值，曲线形状与配色
 * 完全一样，用户反馈「看不出区别」。它唯一真实的价值（更舒展的间距）由这里接手，所以那个 id
 * 可以安心删掉；老笔记里存着的 `classic` 由 core/mindmapPrefs 的 THEME_ALIAS 映射到本主题，
 * 不会被静默重置成默认。
 *
 * 三个设计决定：
 *  ① 颜色只从项目里真实存在的暖色 token 派生（--amber-text：浅色 #b45309 / 深色 #fcd34d），
 *     用 color-mix 混进 --bg / --bg-raised / --border，**不写死两套色值**：深色 token 由
 *     [data-theme='dark'] 重定义，切换时变量自动重解析（与「跟随应用」同一套机制）。
 *  ② 根节点 = 把琥珀往 --text 方向压深一档，字色用 --accent-ink——它本来就是「亮填充之上的
 *     文字」那一对（白 / 近黑），所以两个模式的对比度都远高于 AA。
 *  ③ 间距与圆角比默认舒展一档，这是「松而不散」的来源。
 * 盒子属性（柔光阴影、暖纸画布、暖色选中环）由 index.css 的 .mm-warm 收口：库没有 box-shadow 出口。
 */
const WARM_PALETTE_LIGHT = ['#b45309', '#c2410c', '#a16207', '#9a3412', '#d97706', '#b91c1c', '#ca8a04', '#92400e'];
const WARM_PALETTE_DARK = ['#fcd34d', '#fb923c', '#facc15', '#fdba74', '#f59e0b', '#f87171', '#eab308', '#fbbf24'];

function warmTheme(dark: boolean): Theme {
  return {
    name: dark ? 'knowlattice-warm-dark' : 'knowlattice-warm-light',
    type: dark ? 'dark' : 'light',
    palette: dark ? WARM_PALETTE_DARK : WARM_PALETTE_LIGHT,
    cssVar: {
      ...CSS_VARS,
      // 纸面：只混 6~8%，色偏要有，但不能把 --text 的对比度吃掉
      '--bgcolor': 'color-mix(in srgb, var(--amber-text) 8%, var(--bg))',
      '--main-bgcolor': 'color-mix(in srgb, var(--amber-text) 6%, var(--bg-raised))',
      '--main-bgcolor-transparent': 'color-mix(in srgb, var(--amber-text) 6%, var(--bg-raised))',
      '--main-border': '1px solid color-mix(in srgb, var(--amber-text) 34%, var(--border))',
      '--root-bgcolor': 'color-mix(in srgb, var(--amber-text) 88%, var(--text))',
      '--root-color': 'var(--accent-ink)',
      '--accent-color': 'var(--amber-text)',
      '--selected': 'color-mix(in srgb, var(--amber-text) 26%, transparent)',
      // 弹层（右键菜单 / 面板）跟着暖一档：否则暖色画面里弹出一个冷灰菜单，很跳
      '--panel-bgcolor': 'color-mix(in srgb, var(--amber-text) 5%, var(--bg-raised))',
      '--panel-border-color': 'color-mix(in srgb, var(--amber-text) 26%, var(--border))',
      // 舒展一档（接手原「经典圆弧」的间距，并再放宽一点）
      '--node-gap-x': '32px',
      '--node-gap-y': '11px',
      '--main-gap-x': '74px',
      '--main-gap-y': '46px',
      '--root-radius': '15px',
      '--main-radius': '13px',
    },
  };
}

/**
 * 「护眼绿」：纸面压一层绿，长时间看图不刺眼。
 * 颜色只用项目里真实存在的 token：底色用 color-mix 把 --success 混进 --bg / --bg-raised
 * （浅色得到浅绿纸、深色得到墨绿底，**两个主题自动跟随**，不必写死两套色值）；
 * 文字仍用 --text / --text-2，所以对比度不会比默认主题低。
 * 根节点用 --success 作填充 + --success-ink 作字色——项目里这本来就是
 * 「状态色填充 + 其上的文字」那一对（白字压 --success 只有 2.2:1，不达 AA，所以必须用它）。
 */
function eyeTheme(dark: boolean): Theme {
  return {
    name: dark ? 'knowlattice-eye-dark' : 'knowlattice-eye-light',
    type: dark ? 'dark' : 'light',
    palette: PALETTE,
    cssVar: {
      ...CSS_VARS,
      '--bgcolor': 'color-mix(in srgb, var(--success) 10%, var(--bg))',
      '--main-bgcolor': 'color-mix(in srgb, var(--success) 7%, var(--bg-raised))',
      '--main-bgcolor-transparent': 'color-mix(in srgb, var(--success) 7%, var(--bg-raised))',
      '--main-border': '1px solid color-mix(in srgb, var(--success) 42%, var(--border))',
      '--root-bgcolor': 'var(--success)',
      '--root-color': 'var(--success-ink)',
      '--accent-color': 'var(--success)',
      '--selected': 'color-mix(in srgb, var(--success) 30%, transparent)',
    },
  };
}

/**
 * 「纯文字大纲」的连线：主分支一条直线，子分支一条折线，不画曲线（「连线极简」）。
 * 生成器必须是普通函数（库按 `theme.generateSubBranch || fn` 取用，
 * 库自带的 fn 依赖 this.container 读 --node-gap-x，这里不需要这个信息，所以不声明 this）。
 */
function plainMainBranch({ pT, pL, pW, pH, cT, cL, cW, cH, direction }: MainLineParams): string {
  if (direction === 'down') return `M ${pL + pW / 2} ${pT + pH} L ${cL + cW / 2} ${cT}`;
  const x1 = direction === 'lhs' ? pL : pL + pW;
  const x2 = direction === 'lhs' ? cL + cW : cL;
  return `M ${x1} ${pT + pH / 2} L ${x2} ${cT + cH / 2}`;
}
function plainSubBranch({ pT, pL, pW, pH, cT, cL, cW, cH, direction }: SubLineParams): string {
  if (direction === 'down') return `M ${pL + pW / 2} ${pT + pH} L ${cL + cW / 2} ${cT}`;
  const x1 = direction === 'lhs' ? pL : pL + pW;
  const x2 = direction === 'lhs' ? cL + cW : cL;
  return `M ${x1} ${pT + pH} L ${x2} ${cT + cH / 2}`;
}

/** 「纯文字大纲」用的中性灰分支色（不引入第二种色相，线本身还会被 .mm-plain 的 CSS 再压细压淡） */
const PLAIN_PALETTE_LIGHT = ['#64748b', '#7b8794', '#5b6673', '#8b95a1'];
const PLAIN_PALETTE_DARK = ['#94a3b8', '#7d8b9c', '#a8b3c0', '#6b7a8c'];

/**
 * 「纯文字大纲」：纯下划线无边框，极度聚焦纯粹文字大纲。
 * 库只暴露了 --main-border / --root-border-color 两个边框出口，**没有** box-shadow 出口，
 * 所以这里负责「能通过变量表达的部分」（无边框、底色透明、间距收紧、直线连线），
 * 「无阴影 + 下划线 + 极细连线」这些盒子属性由 index.css 末尾的 .mm-plain 规则给
 * （容器类名在下面按主题切换）。
 */
function plainTheme(dark: boolean): Theme {
  return {
    name: dark ? 'knowlattice-plain-dark' : 'knowlattice-plain-light',
    type: dark ? 'dark' : 'light',
    palette: dark ? PLAIN_PALETTE_DARK : PLAIN_PALETTE_LIGHT,
    cssVar: {
      ...CSS_VARS,
      '--node-gap-x': '22px',
      '--node-gap-y': '5px',
      '--main-gap-x': '42px',
      '--main-gap-y': '22px',
      '--root-border-color': 'transparent',
      '--main-border': 'none',
      '--main-bgcolor': 'transparent',
      '--main-bgcolor-transparent': 'transparent',
      '--main-color': 'var(--text)',
      '--color': 'var(--text-2)',
      '--topic-padding': '0',
      '--main-radius': '0',
      '--root-radius': '0',
      '--root-color': 'var(--accent)',
      '--root-bgcolor': 'transparent',
      '--accent-color': 'var(--muted)',
    },
    generateMainBranch: plainMainBranch,
    generateSubBranch: plainSubBranch,
  };
}

/** 主题 id → 主题对象。dark 只在**应用主题这一刻**读一次：
 *  导图是全屏浮层（z-index 80，盖住整站），打开期间用户切不到应用主题，
 *  所以不需要监听 data-theme 变化；而 --token 类的值本来就会自动跟随。 */
export function themeFor(id: MindMapTheme, dark: boolean, line: MindMapLine = 'curve'): Theme {
  const base = id === 'warm'
    ? warmTheme(dark)
    : id === 'eye'
      ? eyeTheme(dark)
      : id === 'plain'
        ? plainTheme(dark)
        : knowlatticeTheme(dark);
  // 「连线样式」是独立于主题的一条轴：显式选了直角折线就覆盖主题自带的连线形状。
  // （只有「纯文字大纲」自带直线，其余主题本来交给库的贝塞尔曲线；changeTheme 在主题
  //  没给生成器时会**重置**成库默认值，所以从这里传下去等于「每次切都重新声明一次」。）
  return line === 'ortho' ? { ...base, generateMainBranch: orthoMainBranch, generateSubBranch: orthoSubBranch } : base;
}

/* ---------- 预设清单（文案对齐同类医学导图 App，并做到自解释） ---------- */

/**
 * 布局（方向）预设。
 * dir 一律用库的真实枚举常量：MindElixir.LEFT=0 / RIGHT=1 / SIDE=2 / DOWN=3
 * （出处 node_modules/mind-elixir/dist/types/const.d.ts），不写裸数字，
 * 免得将来库换了编号而这里静默画错方向。
 */
export const LAYOUTS: Array<{ id: MindMapDirection; label: string; hint: string; dir: 0 | 1 | 2 | 3 }> = [
  { id: 'side', label: '双向展开', hint: '主分支左右分摊，观感最平衡（默认）', dir: MindElixir.SIDE },
  { id: 'right', label: '大纲向右', hint: '所有分支都向右侧伸展，像读大纲一样自上而下扫', dir: MindElixir.RIGHT },
  { id: 'down', label: '纵向 · 组织结构', hint: '自上而下分层，适合分类树与流程', dir: MindElixir.DOWN },
  { id: 'left', label: '左向展开', hint: '所有分支都向左侧伸展', dir: MindElixir.LEFT },
];

export const THEMES: Array<{ id: MindMapTheme; label: string; hint: string }> = [
  { id: 'follow', label: '跟随应用', hint: '与本应用深浅色、极光靛蓝一致（默认）' },
  { id: 'warm', label: '暖阳纸页', hint: '暖色纸面 + 琥珀分支，节点带柔光、间距舒展' },
  { id: 'eye', label: '护眼绿', hint: '纸面压一层绿，久看不刺眼' },
  { id: 'plain', label: '纯文字大纲', hint: '纯下划线无边框，极度聚焦纯粹文字大纲' },
];

/* 缩放上下限 / 步长 / 滚轮换算统一在 core/mindmapZoom（纯函数、可单测）：库自己的 scale()
   不夹上下限，按钮与滚轮必须夹同一对常量，同源才不会出现「按钮能缩到 300%、滚轮一碰又跳档」。 */
/**
 * 自己解析 Markdown → 大纲树（标题/列表层级，保留 frontmatter 由调用方处理）。
 *
 * 两处正则与「空节点」有关，是**为了不丢内容**才放宽的（CommonMark 里都合法）：
 *   - 列表项允许「光杆标记」：`-`（没有内容）也是合法的空列表项；
 *   - ATX 标题允许没有内容：`#` 单独一行就是空标题。
 * 为什么必须放宽：treeToMd 写出的空节点/空标题到了磁盘上（编辑器、格式化、markdownRepair
 * 都会削掉尾随空白）只会剩下 `-` / `#`，旧正则要求标记后必须有空格，于是**整个节点消失**。
 */
export function parseOutline(md: string): TNode {
  const root: TNode = { id: nid(), content: '', children: [] };
  let gotTitle = false;
  const listStack: Array<{ node: TNode; indent: number }> = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/g, '');
    if (!line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})(?:[\t ]+(.*))?$/.exec(line))) {
      const level = m[1].length;
      const text = (m[2] ?? '').trim();
      const node: TNode = { id: nid(), content: text, children: [] };
      if (level === 1 && !gotTitle) { root.content = text; gotTitle = true; listStack.length = 0; }
      else { root.children.push(node); listStack.length = 0; listStack.push({ node, indent: -1 }); }
    } else if ((m = /^(\s*)[-*+](?:[\t ]+(.*))?$/.exec(line))) {
      const indent = m[1].replace(/\t/g, '  ').length;
      const node: TNode = { id: nid(), content: (m[2] ?? '').trim(), children: [] };
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
      const parent = listStack.length ? listStack[listStack.length - 1].node : root;
      parent.children.push(node);
      listStack.push({ node, indent });
    }
  }
  return root;
}

/**
 * 树 → 序列化回 Markdown（缩进规范：每层两个空格，`- ` 前缀）。
 * 这里是**唯一**的缩进规范出口：大纲视图显示/编辑的文本就是这个函数的输出，
 * 所以「文本框里的字」与「写回笔记的字」是同一份规范（parseOutline ∘ treeToMd 为恒等）。
 *
 * 空节点写成光杆 `-`（不是 `- `）：带尾空格的写法会被任何尾随空白清理削成 `-`，
 * 于是空节点在下次解析时消失；光杆 `-` 不怕被清理，且 parseOutline 认它。
 */
export function treeToMd(root: TNode): string {
  const title = root.content.trim();
  let s = title ? `# ${title}\n` : '#\n';
  const walk = (children: TNode[], depth: number) => {
    for (const c of children) {
      const body = c.content.trim();
      s += body ? `${'  '.repeat(depth)}- ${body}\n` : `${'  '.repeat(depth)}-\n`;
      walk(c.children, depth + 1);
    }
  };
  walk(root.children, 0);
  return s;
}
/** 转义正则元字符：查找替换吃的是「用户输入的字面量」，不能当正则模式解释 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 笔记正文 → 规范大纲 Markdown（剥 frontmatter）。解析用的就是上面同一个 parseOutline，
 *  因此「打开导图」「切到大纲视图」「保存回写」三条路径共用一套规则，不会各自漂移。 */
export function normalizeOutline(md: string): string {
  return treeToMd(parseOutline(md.replace(FM_RE, '')));
}

function toMind(t: TNode): unknown {
  return { topic: t.content, id: t.id, expanded: true, children: (t.children ?? []).map(toMind) };
}
/** 交给 mind-elixir `init()` 的根数据：字段就是库读的那几个（expanded 控制默认展开） */
export interface MindRootData {
  id: string;
  topic: string;
  expanded: boolean;
  children: unknown[];
}

export function mdToMind(md: string): { nodeData: MindRootData } {
  const root = parseOutline(md);
  // mind-elixir: init(data) 读取 data.nodeData，且 MindElixir.new() 也返回 { nodeData } 包装
  const nodeData = { id: 'root', topic: root.content || '笔记', expanded: true, children: (root.children ?? []).map(toMind) };
  return { nodeData };
}
export function mindToMd(data: { topic?: string; children?: unknown[] }): string {
  if (!data) return '';
  const rec = (n: MindNode): TNode => ({
    id: n.id ?? nid(),
    content: `${n.topic ?? ''}`.trim(),
    children: ((n.children ?? []) as MindNode[]).map(rec),
  });
  return treeToMd(rec(data));
}

