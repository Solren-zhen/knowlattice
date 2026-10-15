/**
 * 思维导图：基于 Mind Elixir（MIT）—— 原生 XMind 式编辑：
 * 双击节点改字、Tab 加子级、Enter 加同级、Delete 删、拖拽调整、右键菜单、撤销/重做。
 * Markdown ↔ 思维导图树互转，保存时写回笔记（保留 frontmatter）。
 *
 * 外观与文案在这里收口：mind-elixir 默认是 Latte 主题（粉紫暖调）+ 全英文右键菜单，
 * 和本项目的极光靛蓝体系完全不搭。下面走官方的两条接口把它接进设计系统：
 *   theme  → 22 个 CSS 自定义属性；值一律写成 var(--token)，
 *            深浅色切换时由 :root 自动重解析，不必重建实例、也不丢编辑状态。
 *   locale → LangPack 12 条文案（库自带 cn，但这里要贴合笔记场景，所以自己写一份）。
 *
 * ── 本轮新增的「格式」＝ **呈现层**三组预设（对齐同类医学导图 App 的观感）──
 *   布局：双向展开 / 大纲向右 / 纵向 · 组织结构 / 左向展开
 *   主题：跟随应用（默认，改动前那套）/ 暖阳纸页 / 护眼绿 / 纯文字大纲
 *   视图：导图 ↔ 大纲（可编辑的纯文本缩进大纲）
 * 三条边界（为什么这么切）：
 *   ① **存储格式一个字不动**：笔记里的 Markdown 大纲仍是唯一真相——复习卡（`## 小节`）、
 *      复习队列、统计、Anki 导出、备份全读它。所以大纲视图保存时走
 *      parseOutline → treeToMd → 既有的 onSaveNote 回写，**复用同一个解析器**，
 *      不新写一套解析、更不把布局/主题/注解写进笔记（那等于让每一篇历史笔记在下次
 *      保存时都变一次字节，收益只是省一个键，见 core/mindmapPrefs 文件头）。
 *   ② **切预设不重建实例**：布局走 mind.direction + mind.refresh()，主题走 mind.changeTheme()，
 *      两者都只重排/重画，不碰 nodeData → 不丢当前编辑内容，也不清撤销栈。
 *   ③ **默认观感零变化**：第一次打开任何导图 = 双向展开 + 跟随应用 + 导图视图，与改动前一致。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import type { LangPack } from 'mind-elixir/i18n';
import type { MainLineParams, SubLineParams, Theme, Topic } from 'mind-elixir';
import type { QuoteSelection } from './AiAgentPanel';
import { IconChevron, IconClose, IconLink, IconSearch } from './icons';
import { toast } from '../core/feedback';
import {
  resolveMindMapPref,
  saveMindMapPref,
  type MindMapDirection,
  type MindMapLine,
  type MindMapNumbering,
  type MindMapTheme,
  type MindMapViewKind,
} from '../core/mindmapPrefs';
import {
  LINE_STYLES,
  NUMBERINGS,
  numberingVars,
  orthoMainBranch,
  orthoSubBranch,
} from '../core/mindmapStyles';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom, wheelZoomFactor } from '../core/mindmapZoom';
import { loadToolsOpen, saveToolsOpen } from '../core/mindmapToolbar';
import {
  NODE_STYLE_KEYS,
  STYLE_PRESETS,
  applyStoredStyles,
  collectNodeKeys,
  getNoteStyles,
  mergeStyle,
  nodePathKey,
  pruneNoteStyles,
  renameNodeStyle,
  setNodeStyle,
  type NodeStyle,
  type StylableNode,
} from '../core/mindmapNodeStyles';

interface Props {
  content: string;
  title: string;
  /**
   * 偏好按**笔记**定位（core/mindmapPrefs 的键）。
   * 可选：缺省时退回 title，这样其它调用点/单测不传也能工作；
   * 代价是「同名不同目录」的两篇笔记会共用一份偏好（Workspace 会传当前笔记路径，正常不会发生）。
   */
  noteKey?: string;
  onClose: () => void;
  /** 点击 [[双链]] 节点时回调（跳转对应笔记） */
  onOpenWiki?: (name: string) => void;
  /** 编辑完成后回调（传入写回的完整 Markdown，含 frontmatter） */
  onSaveNote?: (md: string) => void;
  /**
   * 把一段内容（可带一句要求）交给 AI 笔记面板——与复习卡/错题本/题库走的是同一个通道：
   * 面板收到后只**预填**问法、不自动发送，写回要用户在面板里点「应用」。
   * 不传就不渲染「AI 改写 / 改写这支 / 标签总结」这三个按钮（其它调用点与单测不受影响）。
   */
  onAskAi?: (quote: QuoteSelection) => void;
}
import {
  getNoteMarks,
  keyIndex,
  renameNodeMark,
  resolveMarks,
  serializeMarks,
  setNoteMarks,
  type MarkNode,
} from '../core/mindmapMarks';

type TNode = { id: string; content: string; children: TNode[] };
/** mind-elixir 的节点形状（只用到我们碰的那几个字段） */
type MindNode = {
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
const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/* ---------- 文案 ---------- */

/** mind-elixir 的右键菜单文案。库自带的 cn 是通用译法（「添加子节点」等），
 *  这里用更贴合笔记场景的说法。 */
const ZH: LangPack = {
  addChild: '加子级（Tab）',
  addParent: '加上级',
  addSibling: '加同级（Enter）',
  removeNode: '删除（Delete）',
  focus: '聚焦此分支',
  cancelFocus: '退出聚焦',
  moveUp: '上移',
  moveDown: '下移',
  link: '连线',
  linkBidirectional: '双向连线',
  clickTips: '请点击要连接的目标节点',
  summary: '概要',
};

/* ---------- 「问 AI」的三段要求（随引用一起送进 AI 面板；面板只预填，用户可改再发） ---------- */

/**
 * 三段都把**硬边界**写进要求里，而不是指望模型自觉：
 *   - 一律写回**同一篇**笔记、先给 diff 等确认（面板本身也拦一道）：改动多就 propose_note_edit
 *     （要求它把 frontmatter 原样抄回），只改几处就 propose_note_patch；
 *   - 正文里的属性键行（形如 `- 定义: …`）与复习卡约定不许动——复习队列、出题、统计都在读它们，
 *     改掉等于悄悄换了复习内容；
 *   - 不许补大纲之外的医学论断（导图只是索引，编出来的内容会直接进笔记）。
 */
const AI_ASKS = {
  full: [
    '下面给的是这篇笔记的思维导图大纲。请按它把笔记正文改写得更完整、更有条理，然后写回**同一篇**笔记（不要新建笔记）：',
    '- 层级与顺序沿用大纲；标题用 Markdown（## / ###），标题文字与大纲一致；',
    '- 只整理、展开大纲里已有的信息，**不要补大纲之外的医学论断**；拿不准的地方留 {{待补}} 标记；',
    '- 写法：改动遍布全文就用 propose_note_edit（**必须把 frontmatter 原样抄在开头**）；只改几处就用 propose_note_patch（find_text 从 read_note 返回的原文里原样复制，保证唯一）；',
    '- **原样保留** frontmatter 与每节的属性键行（形如 `- 定义: …`、`- 首选检查: …`），一个字都不要改；',
    '- 先给我看 diff，我确认后你再写。',
  ].join('\n'),
  subtree: (topic: string) =>
    `下面这段是思维导图里「${topic}」这一支。请把它扩写成通顺的笔记正文（保留原有信息、不新增未经确认的论断），然后用 propose_note_patch 把这段写回这篇笔记对应的位置（其它部分与 frontmatter 原样保留）。先给我看 diff，我确认后你再写。`,
  tags: [
    '给这篇笔记整理标签：先读正文与下面的大纲，看它到底讲了什么；再合并同义标签、去重，最后定 3-5 个，',
    '写进笔记开头 frontmatter 的 tags: 里（YAML 数组形式）。',
    '**正文一个字都不要改**。笔记可能还没有 tags: 行：那就把 frontmatter 那一段（第一行 --- 到闭合 ---）',
    '从 read_note 返回的原文里原样复制成 find_text，在里面补上 tags: 后整段作为 replace_text 用 propose_note_patch 换回去；',
    '已有 tags: 行就直接改那一行。先给我看 diff。',
  ].join('\n'),
};

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
function themeFor(id: MindMapTheme, dark: boolean, line: MindMapLine = 'curve'): Theme {
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
const LAYOUTS: Array<{ id: MindMapDirection; label: string; hint: string; dir: 0 | 1 | 2 | 3 }> = [
  { id: 'side', label: '双向展开', hint: '主分支左右分摊，观感最平衡（默认）', dir: MindElixir.SIDE },
  { id: 'right', label: '大纲向右', hint: '所有分支都向右侧伸展，像读大纲一样自上而下扫', dir: MindElixir.RIGHT },
  { id: 'down', label: '纵向 · 组织结构', hint: '自上而下分层，适合分类树与流程', dir: MindElixir.DOWN },
  { id: 'left', label: '左向展开', hint: '所有分支都向左侧伸展', dir: MindElixir.LEFT },
];

const THEMES: Array<{ id: MindMapTheme; label: string; hint: string }> = [
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
function parseOutline(md: string): TNode {
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
function treeToMd(root: TNode): string {
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
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 笔记正文 → 规范大纲 Markdown（剥 frontmatter）。解析用的就是上面同一个 parseOutline，
 *  因此「打开导图」「切到大纲视图」「保存回写」三条路径共用一套规则，不会各自漂移。 */
function normalizeOutline(md: string): string {
  return treeToMd(parseOutline(md.replace(FM_RE, '')));
}

function toMind(t: TNode): unknown {
  return { topic: t.content, id: t.id, expanded: true, children: (t.children ?? []).map(toMind) };
}
function mdToMind(md: string): { nodeData: unknown } {
  const root = parseOutline(md);
  // mind-elixir: init(data) 读取 data.nodeData，且 MindElixir.new() 也返回 { nodeData } 包装
  const nodeData = { id: 'root', topic: root.content || '笔记', expanded: true, children: (root.children ?? []).map(toMind) };
  return { nodeData };
}
function mindToMd(data: { topic?: string; children?: unknown[] }): string {
  if (!data) return '';
  const rec = (n: MindNode): TNode => ({
    id: n.id ?? nid(),
    content: `${n.topic ?? ''}`.trim(),
    children: ((n.children ?? []) as MindNode[]).map(rec),
  });
  return treeToMd(rec(data));
}

export default function MindMapView({ content, title, noteKey, onClose, onOpenWiki, onSaveNote, onAskAi }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixir | null>(null);
  const onSaveRef = useRef(onSaveNote);
  const onOpenWikiRef = useRef(onOpenWiki);
  useEffect(() => { onSaveRef.current = onSaveNote; }, [onSaveNote]);
  useEffect(() => { onOpenWikiRef.current = onOpenWiki; }, [onOpenWiki]);

  /** 偏好键：优先用当前笔记路径（Workspace 传），缺省退回标题 */
  const prefKey = noteKey || title;

  const [direction, setDirection] = useState<MindMapDirection>(() => resolveMindMapPref(prefKey).direction);
  const [themeId, setThemeId] = useState<MindMapTheme>(() => resolveMindMapPref(prefKey).theme);
  const [view, setView] = useState<MindMapViewKind>(() => resolveMindMapPref(prefKey).view);
  const [line, setLine] = useState<MindMapLine>(() => resolveMindMapPref(prefKey).line);
  const [numbering, setNumbering] = useState<MindMapNumbering>(() => resolveMindMapPref(prefKey).numbering);
  /** 大纲视图里的可编辑文本（缩进规范 = treeToMd 的输出） */
  const [outline, setOutline] = useState(() => normalizeOutline(content));
  /** 画布缩放倍数（由实例的 scale 事件同步；± 按钮与滚轮都会改它） */
  const [zoom, setZoom] = useState(1);
  /** 当前选中的节点数：>0 才能加同级/上级/子级/删除，>1 才能加概要 */
  const [selCount, setSelCount] = useState(0);
  /** 连线模式：进入后点两下（起点 → 终点），由库的 createArrow 落一条关系线 */
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  /** 查找替换条 */
  const [findOpen, setFindOpen] = useState(false);

  /**
   * 工具条展开 / 收起：默认展开（与加入本功能之前一致），选择**全局记住**
   * （见 core/mindmapToolbar：和深浅色 / 字体同一类界面偏好，不按笔记分、不进备份）。
   * 只影响这两条工具条的显隐，不碰实例、不碰笔记，也不碰任何偏好（除它自己这一个键）。
   */
  const [toolsOpen, setToolsOpen] = useState<boolean>(() => loadToolsOpen());
  const toggleTools = () => {
    const next = !toolsOpen;
    setToolsOpen(next);
    saveToolsOpen(next);
  };
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findHit, setFindHit] = useState(0);
  /** 改过节点文字后自增：匹配列表要跟着重算（getData 不是 React 能追踪的值） */
  const [editStamp, setEditStamp] = useState(0);
  /** 当前选中节点的样式（工具栏据此高亮 B/I/U/S 与各下拉的当前项） */
  const [curStyle, setCurStyle] = useState<NodeStyle | null>(null);
  /** 格式刷：取到样式后，下一次点节点就刷上去 */
  const [brush, setBrush] = useState<NodeStyle | null>(null);
  /**
   * 导图实例的输入（frontmatter 已剥）。
   * 用 ref 而不是 state：切视图时要先把「大纲文本框里刚编辑过的字」喂给即将重建的实例，
   * 而实例 effect 的依赖只有 [content, view]——读 ref 才能拿到**切换那一刻**的最新值，
   * 不会因为把 view 之外的值写进依赖而重建实例（那会丢编辑内容与撤销栈）。
   */
  const mapSourceRef = useRef(normalizeOutline(content));
  /** 格式刷里存着的样式（用 ref 读：点击监听器是在 effect 里挂的，拿不到最新的 state 闭包） */
  const brushRef = useRef<NodeStyle | null>(null);
  /** 应用样式的函数引用（同上：点击监听器需要它，但它在下面才定义） */
  const applyStyleRef = useRef<((node: MindNode, patch: Partial<Record<keyof NodeStyle, string | null>>) => void) | null>(null);

  // 换笔记（[[双链]] 跳转 / 关掉再打开另一篇）：按新笔记的偏好重置一次。
  // 值没变时 React 会跳过重渲染，所以首屏不产生额外渲染。
  useEffect(() => {
    const p = resolveMindMapPref(prefKey);
    setDirection(p.direction);
    setThemeId(p.theme);
    setView(p.view);
    setLine(p.line);
    setNumbering(p.numbering);
  }, [prefKey]);

  // 正文变化（换笔记、保存后 Workspace 回写 draft）：两个视图都重建成新正文。
  // 与改动前「content 一变就重建实例」是同一套语义，不引入第二个真相来源。
  useEffect(() => {
    const body = normalizeOutline(content);
    mapSourceRef.current = body;
    setOutline(body);
  }, [content]);

  // 导图实例：只在「正文变了」或「从大纲视图切回导图」时重建（见文件头 ②）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || view !== 'map') return;
    let disposed = false;
    let mind: MindElixir | null = null;
    el.innerHTML = '';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const data = mdToMind(mapSourceRef.current);
    // 打开时把**存下来的节点样式**贴回树：库对 node.style 是逐键赋值，所以第一帧就是对的
    // （不在存储里的节点保持 undefined = 用主题默认观感，与改动前逐字一致）。
    const noteStyles = getNoteStyles(prefKey);
    const treeData = (data as { nodeData: StylableNode }).nodeData;
    applyStoredStyles(treeData, noteStyles);
    // 顺手清掉树里已不存在的样式键（改名/拖动留下的孤儿）。没有孤儿时它什么都不写。
    pruneNoteStyles(prefKey, collectNodeKeys(treeData));
    // 本次渲染生效的预设（切预设本身不会走到这里：它只改实例字段 + 重排重画）
    const dir = LAYOUTS.find((l) => l.id === direction)?.dir ?? MindElixir.SIDE;
    const theme = themeFor(themeId, dark, line);

    const boot = () => {
      if (disposed) return;
      mind = new MindElixir({
        el,
        direction: dir,
        // 右键菜单：开聚焦/连线，并用上面的中文文案
        contextMenu: { focus: true, link: true, locale: ZH },
        // 关掉库自带的两个悬浮图标工具条：左上角那三个（左/右/双向）与我们工具栏的「布局」组重复，
        // 右下角那四个（全屏/居中/缩小/放大）与「画布」组重复——用户在画布上同时看到两套按钮。
        // 关掉之后功能一个没少：方向由「布局」组给（还多一个「纵向」，库那三个没有），
        // 缩放/居中/适应在「画布」组，库独有的「全屏」已补到同一组里。
        toolBar: false,
        keypress: true,
        overflowHidden: false,
        mouseSelectionButton: 0,
        // 缩放上下限与我们的 ± 按钮共用一对常量（滚轮缩放也夹在这两个值里）
        scaleMin: ZOOM_MIN,
        scaleMax: ZOOM_MAX,
        /**
         * 滚轮 = 缩放画布，且以**指针位置**为锚点（缩放在鼠标处发生，而不是画布中心）。
         *
         * 为什么自定义：库内置的滚轮是「普通滚轮平移、Ctrl/⌘+滚轮缩放」
         * （dist: `t.shiftKey ? e.move(-deltaY, 0) : e.move(-deltaX, -deltaY)`），
         * 和界面底部那句「滚轮 缩放」以及用户预期都对不上。
         * 传 handleWheel 会替换掉内置那套（dist: `typeof e.handleWheel == "function" ? e.handleWheel : 内置`）。
         * Shift+滚轮保留为横向平移：导图铺得很宽时这条比缩放常用；其余形态（含 Ctrl/⌘）一律缩放。
         */
        handleWheel: (e: WheelEvent) => {
          // 先吞掉事件：页面/父容器不跟着滚（监听挂在画布容器上，不是 passive，拦得住）
          e.stopPropagation();
          e.preventDefault();
          const cur = mindRef.current;
          if (!cur) return;
          if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
            cur.move(-e.deltaY, 0); // 横向平移：沿用库内置的映射
            return;
          }
          // deltaMode 归一 / 指数映射 / 夹上下限都在 core/mindmapZoom（那里有单测）
          const next = clampZoom(
            cur.scaleVal * wheelZoomFactor({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              viewportHeight: el.clientHeight || window.innerHeight,
            }),
          );
          if (next === cur.scaleVal) return; // 已到上下限：不动，免得在边界上抖动
          cur.scale(next, { x: e.clientX, y: e.clientY });
        },
        theme,
      });
      void mind.init(data as never)
        .then(() => {
          if (disposed) return;
          // 关系线/概要的重建必须等节点渲染出来：createArrowFrom / createSummaryFrom 内部用 findEle
          // 找节点元素，DOM 还没建时它会直接抛（dist 里那句 `FindEle: Node ... not found`）。
          const stored = resolveMarks(treeData as MarkNode, getNoteMarks(prefKey));
          for (const a of stored.arrows) {
            try { mind!.createArrowFrom(a as never); } catch { /* 端点被折叠/删除：这条不画 */ }
          }
          for (const s of stored.summaries) {
            try { mind!.createSummaryFrom(s as never); } catch { /* 父节点/子项对不上：这条不画 */ }
          }
        })
        .catch((e: unknown) => console.error('思维导图初始化失败：', e));
      mindRef.current = mind;
      // 新实例没有选中集：把按钮可用性同步回来
      if (!disposed) setSelCount(0);
      // 缩放百分比：滚轮 / 按钮 / 适应画布都会走实例的 scale，串到 state 只为了让读数跟着走
      mind.bus.addListener('scale', (s) => { if (!disposed) setZoom(s); });
      // 改名后把样式条目搬到新键（节点键就是文字路径，不搬就丢了）。
      // 库在编辑结束时发 finishEdit，payload 里带 origin = 改之前的文字。
      mind.bus.addListener('operation', (op) => {
        if (op.name !== 'finishEdit') return;
        const node = op.target as unknown as MindNode;
        const origin = (op as unknown as { origin?: string }).origin;
        if (typeof origin !== 'string' || origin === node?.topic) return;
        const trail: string[] = [];
        let cur = node?.parent;
        while (cur) {
          trail.unshift(`${cur.topic ?? ''}`);
          cur = cur.parent;
        }
        renameNodeStyle(prefKey, nodePathKey(trail, origin), nodePathKey(trail, `${node?.topic ?? ''}`));
        // 关系线/概要记的是**含祖先的完整路径**，所以这一次改名可能牵连整棵子树：
        // renameNodeMark 按前缀重写，并且只动这一篇的键（见 core/mindmapMarks 的文件头）。
        renameNodeMark(prefKey, nodePathKey(trail, origin), nodePathKey(trail, `${node?.topic ?? ''}`));
      });
      // 关系线/概要改动 → 立刻按节点文本路径存一份（下次打开这篇笔记时重建）。
      // 库每次这类改动都会发 operation 事件（创建/删除/改标签/拖控制点），所以这里订一处就够，
      // 也不会漏掉右键菜单、快捷键这些别的入口。
      const MARK_OPS = new Set([
        'createArrow', 'removeArrow', 'finishEditArrowLabel', 'reshapeArrow',
        'createSummary', 'removeSummary', 'finishEditSummary',
      ]);
      mind.bus.addListener('operation', (op) => {
        if (!MARK_OPS.has(op.name)) return;
        const tree = (mind!.getData() as { nodeData: MarkNode }).nodeData;
        // 端点 id → 文本路径：先在本地把整棵树的「id → 路径键」反表建一次（O(节点数)），
        // 之后每个端点都是 O(1) 查表。原来是把 keyOfId 交给 serializeMarks，每个端点各递归一整棵树
        // （O(端点数 × 节点数)，大图上每次连线都白扫好几遍）。
        // 存出来的键与那时**逐字相同**：keyIndex 复用同一个 nodePathKey、同一套深度优先“第一个命中”语义。
        const byId = keyIndex(tree);
        setNoteMarks(
          prefKey,
          serializeMarks({ arrows: mind!.arrows, summaries: mind!.summaries }, (id) => byId.get(id) ?? null),
        );
      });
    };
    // React StrictMode 会在同一批同步执行「挂载 → 销毁 → 再挂载」。
    // 而 mind-elixir 的 init 是 async：内部先 await document.fonts.ready，之后才建 this.map 并跑
    // linkDiv()。若实例在这之前被 destroy，它会把 map / el 置为 undefined，init 的尾巴继续执行
    // 就会抛「Cannot read properties of undefined (reading 'querySelector')」。
    // 把实例化推迟一个微任务：第一轮那个注定被丢弃的实例根本不会被创建，报错从根上消失。
    queueMicrotask(boot);

    return () => {
      disposed = true;
      if (mind) {
        mind.destroy();
        if (mindRef.current === mind) mindRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, view]);

  // Esc 退出。走全局 Esc 栈；焦点在思维导图节点里（contenteditable）时先退出编辑，
  // 再按一次才关面板——避免编辑到一半按 Esc 整张导图连同未保存内容一起消失。
  // 大纲视图的 <textarea> 走同一套：第一次 Esc 只是失焦，第二次才关。
  useEsc(escThenClose(onClose));

  // 点击 [[双链]] 节点 → 打开对应笔记（捕获阶段拦截，避免干扰 mind-elixir 的编辑选中）
  // 依赖里带 view：视图切换会把 .mindmap-elixir 这个节点整个换掉，不重新挂就监听不到新节点。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 取**被点的那个节点自己的**主题文本（.me-tpc 是每个节点的主题容器）。
      // 注意不能先 closest('.me-main')：整条分支的分组容器也带 .me-main（.me-main.lhs/.rhs/.down），
      // 那样再 querySelector('.me-tpc') 拿到的是该分支的**第一条**主题 —— 深层节点的 [[双链]]
      const topicEl = t?.closest?.('.me-tpc') as HTMLElement | null;
      const label = (topicEl?.textContent || '').trim();
      const m = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(label);
      if (m) {
        onOpenWikiRef.current?.((m[2] ?? m[1]).trim());
        e.stopPropagation();
        e.preventDefault();
      }
      // 选中数（决定「同级 / 子级 / 上级 / 删除 / 概要」是否可点）：库在**冒泡阶段**处理
      // 这次点击的选中，所以延到本任务末尾再读，否则读到的还是上一次的选中集。
      setTimeout(() => {
        const mind = mindRef.current;
        if (mind) setSelCount(mind.currentNodes?.length ?? 0);
        // 选中节点的样式 → 工具栏高亮；同时若手里有「格式刷」，这一下就刷上去
        const node = (mind?.currentNode as Topic | null | undefined)?.nodeObj as MindNode | undefined;
        setCurStyle((node?.style as NodeStyle | undefined) ?? null);
        const b = brushRef.current;
        if (mind && node && b) {
          setBrush(null);
          void applyStyleRef.current?.(node, b);
        }
      }, 0);
    };
    el.addEventListener('click', h, true);
    return () => el.removeEventListener('click', h, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, view]);

  /** 取当前导图实例里的树（还没保存的编辑也在里面） */
  const currentTree = (): MindNode | null => {
    const d = mindRef.current?.getData();
    const tree = (d && (d as { nodeData?: unknown }).nodeData) || d;
    return (tree as MindNode | undefined) ?? null;
  };

  /** 视图切换：先把手上的编辑搬到另一个视图，再切 */
  const switchView = (next: MindMapViewKind) => {
    if (next === view) return;
    if (next === 'outline') {
      // 导图 → 大纲：用实例里当前的树（含未保存的改动）生成同一套 Markdown 文本
      const tree = currentTree();
      setOutline(tree ? mindToMd(tree) : mapSourceRef.current);
    } else {
      // 大纲 → 导图：把（可能已编辑的）大纲文本当作实例输入，切回去不丢字
      mapSourceRef.current = outline;
    }
    setView(next);
    saveMindMapPref(prefKey, { view: next });
  };

  /** 布局切换：只改方向 + 重排重画，不重建实例（编辑内容与撤销栈都保住） */
  const applyDirection = (id: MindMapDirection) => {
    setDirection(id);
    saveMindMapPref(prefKey, { direction: id });
    const mind = mindRef.current;
    const dir = LAYOUTS.find((l) => l.id === id)?.dir ?? MindElixir.SIDE;
    if (!mind || mind.direction === dir) return;
    mind.direction = dir;
    // 只调 layout() 不够：layout() 重建节点 DOM（this.nodes.innerHTML = ''）却不重画连线 SVG，
    // 换向后会留下按旧几何算出来的一批线。refresh() = layout() + linkDiv()——
    // 库自己的 initLeft/initRight/initSide/initDown 就是这么干的——它同样不碰 nodeData。
    mind.refresh();
  };

  /** 主题切换：换 22 个 CSS 变量与两个曲线生成器，不碰 nodeData（changeTheme 默认带 refresh） */
  const applyTheme = (id: MindMapTheme) => {
    setThemeId(id);
    saveMindMapPref(prefKey, { theme: id });
    const mind = mindRef.current;
    if (!mind) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    mind.changeTheme(themeFor(id, dark, line));
  };


  /**
   * 连线样式切换：和主题同一招（changeTheme 会把两个连线生成器按新主题重设一次，
   * 所以这里要连主题对象一起重给），不碰 nodeData —— 编辑内容与撤销栈都保住。
   */
  const applyLine = (id: MindMapLine) => {
    setLine(id);
    saveMindMapPref(prefKey, { line: id });
    const mind = mindRef.current;
    if (!mind) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    mind.changeTheme(themeFor(themeId, dark, id));
  };

  /** 标题编号：纯 CSS 显示层（容器挂类 + CSS 变量），实例、数据、撤销栈一个都不动 */
  const applyNumbering = (id: MindMapNumbering) => {
    setNumbering(id);
    saveMindMapPref(prefKey, { numbering: id });
  };

  /* ---------- 节点样式（字体 / 形状 / 颜色；存储见 core/mindmapNodeStyles） ---------- */

  /**
   * 节点在树里的**文本路径键**：祖先主题（含根）+ 自己。
   * 必须与 core/mindmapNodeStyles 的 applyStoredStyles 用同一套算法，否则存下来的样式
   * 贴不回同一个节点——两处都调 nodePathKey，这里只负责把祖先收集齐。
   */
  const keyOfNode = (node: MindNode | undefined): string => {
    if (!node) return '';
    const trail: string[] = [];
    let cur = node.parent;
    while (cur) {
      trail.unshift(`${cur.topic ?? ''}`);
      cur = cur.parent;
    }
    return nodePathKey(trail, `${node.topic ?? ''}`);
  };

  /**
   * 应用样式补丁（键 → 值；null = 清掉这一项）。
   *
   * 两件事必须一起做：
   *   ① 元素上：库对 node.style 是**逐键赋值**（`for (let t in n) e.style[t] = n[t]`），
   *      它只覆盖「这次给了的键」，旧值会留在元素的行内样式上——所以这里把白名单里
   *      **没设的项显式写成空串**，让元素与存储严格一致；
   *   ② 存储里：按节点文本路径键写一份，下次打开这篇笔记时贴回来（applyStoredStyles）。
   * 撤销栈由库负责（reshapeNode 是一次正常操作）。
   */
  const applyStyleTo = async (node: MindNode, patch: Partial<Record<keyof NodeStyle, string | null>>) => {
    const mind = mindRef.current;
    if (!mind || !node.id) return null;
    const next = mergeStyle((node.style as NodeStyle | undefined) ?? null, patch);
    const forDom: Record<string, string> = {};
    for (const k of NODE_STYLE_KEYS) forDom[k] = (next?.[k] as string | undefined) ?? '';
    const tpc = mind.findEle(node.id, undefined) as Topic | undefined;
    if (tpc) await mind.reshapeNode(tpc, { style: forDom } as never);
    node.style = next ?? undefined;
    setNodeStyle(prefKey, keyOfNode(node), next);
    setCurStyle(next);
    return next;
  };

  /** 工具栏入口：作用于当前选中的节点 */
  const applyStyle = (patch: Partial<Record<keyof NodeStyle, string | null>>) => {
    const node = (mindRef.current?.currentNode as Topic | null | undefined)?.nodeObj as MindNode | undefined;
    if (!node) {
      toast('先在图上点一个节点，再设格式', 'info', 3600);
      return;
    }
    void applyStyleTo(node, patch);
  };

  /**
   * 把补丁应用到「该节点及所有子节点」。
   * 为什么走数据 + refresh 而不是逐个 findEle：折叠着的子孙**不在 DOM 里**，
   * 库的 findEle 会直接抛错（dist 里那句 `maybe it's collapsed`）。
   */
  const applyStyleSubtree = (patch: Partial<Record<keyof NodeStyle, string | null>>) => {
    const mind = mindRef.current;
    const root = (mind?.currentNode as Topic | null | undefined)?.nodeObj as MindNode | undefined;
    if (!mind || !root) {
      toast('先在图上点一个节点，再设格式', 'info', 3600);
      return;
    }
    let n = 0;
    const walk = (node: MindNode) => {
      const next = mergeStyle((node.style as NodeStyle | undefined) ?? null, patch);
      node.style = next ?? undefined;
      setNodeStyle(prefKey, keyOfNode(node), next);
      n++;
      for (const c of (node.children ?? []) as MindNode[]) walk(c);
    };
    walk(root);
    mind.refresh();
    setCurStyle((root.style as NodeStyle | undefined) ?? null);
    toast(`已应用到该节点及其 ${n - 1} 个子节点`, 'ok', 2800);
  };

  // 把最新的应用函数与格式刷样式交给 ref：点击监听器（effect 里挂的）只有这两个 ref 能读到最新值
  applyStyleRef.current = (node, patch) => { void applyStyleTo(node, patch); };
  brushRef.current = brush;

  /** 格式刷：取当前节点的样式，下一次点节点就刷上；再点一次按钮＝取消 */
  const pickBrush = () => {
    if (brush) { setBrush(null); return; }
    const node = (mindRef.current?.currentNode as Topic | null | undefined)?.nodeObj as MindNode | undefined;
    const style = (node?.style as NodeStyle | undefined) ?? null;
    if (!style) {
      toast('这个节点还没有格式可取：先给它设一下字体或颜色', 'info', 3600);
      return;
    }
    setBrush({ ...style });
    toast('格式刷已取样式：再点一个节点就会刷上去', 'info', 3200);
  };

  /** 格式作用范围：只当前节点 / 连子节点一起（对应右栏「颜色范围」那个下拉） */
  const [styleScope, setStyleScope] = useState<'node' | 'subtree'>('node');

  /** 统一入口：按范围分派（工具栏每一项都走它，避免每个按钮自己判断范围） */
  const apply = (patch: Partial<Record<keyof NodeStyle, string | null>>) => {
    if (styleScope === 'subtree') applyStyleSubtree(patch);
    else applyStyle(patch);
  };

  /** 下拉项 id → 样式补丁 */
  const formatById = (group: keyof typeof STYLE_PRESETS, id: string): Partial<Record<keyof NodeStyle, string | null>> =>
    STYLE_PRESETS[group].find((p) => p.id === id)?.patch ?? {};

  /** 当前节点样式 → 各下拉该选中的预设 id（按值反查；没有就落回第一项＝默认项） */
  const presetId = (group: keyof typeof STYLE_PRESETS, key: keyof NodeStyle): string => {
    const v = (curStyle as Record<string, string | undefined> | null | undefined)?.[key];
    if (v === undefined) return STYLE_PRESETS[group][0].id;
    return STYLE_PRESETS[group].find((p) => p.patch[key] === v)?.id ?? STYLE_PRESETS[group][0].id;
  };
  const fontFamilyId = presetId('fontFamily', 'fontFamily');
  const fontSizeId = presetId('fontSize', 'fontSize');
  const colorId = presetId('color', 'color');
  const backgroundId = presetId('background', 'background');
  const shapeId = presetId('shape', 'borderRadius');

  const bold = curStyle?.fontWeight === 'bold';
  const italic = curStyle?.fontStyle === 'italic';
  const deco = curStyle?.textDecoration ?? '';
  const underline = deco.includes('underline');
  const strike = deco.includes('line-through');

  /** 下划线 / 删除线是同一个 CSS 属性（textDecoration），所以要合着改，不能互相覆盖 */
  const toggleDecoration = (kind: 'underline' | 'line-through') => {
    const has = deco.includes(kind);
    const parts = deco.split(/\s+/).filter((p) => p && p !== 'none' && p !== kind);
    if (!has) parts.push(kind);
    apply({ textDecoration: parts.length ? parts.join(' ') : 'none' });
  };

  /**
   * 左键拖**空白处**平移整张导图（用户反馈：画面是固定的，拖不动）。
   *
   * 为什么库自己不做：mind-elixir 6 的 panHelper 只在「空格+左键」「右键」「触屏」时平移，
   * 而左键落在空白画布上会先被它自己的**框选**分支接走（dist 里 pointerdown 的第一个判断），
   * 于是「按住左键拖画面」这个最直觉的动作被吃掉。
   * 这里在容器**捕获阶段**接管左键：
   *   - 拖空白 = 平移（setPointerCapture + mind.move），光标变抓手；
   *   - Shift / Ctrl / Alt + 拖 = 放行给库做框选（多选照旧可用）；
   *   - 落在节点 / 展开圆点 / 右键菜单 / 库自带的工具条 / 输入框上的一律放行，
   *     所以拖节点换父级、双击改字、右键菜单、连线这些库的能力一个都没动；
   *   - 空格+左键、右键拖、触屏平移仍是库自己那套，两边互不干扰。
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || view !== 'map') return;
    let panning = false;
    let lastX = 0;
    let lastY = 0;

    /**
     * 指针是不是落在**空白画布**上（只有空白才接管为平移）。
     *
     * 这里必须把「库的可点元素」全部排除，否则按住它们会被我们当空白拖走、库自己的交互
     * 再也收不到事件——真实踩过的坑就是**连线的文字标签**：`.svg-label { pointer-events: auto }`
     * 是可点的（双击改文字），但一开始没进这份名单，于是「关系线文字改不了」。
     * 名单对应库的真实结构（源码 + 它自带的 CSS）：
     *   .me-tpc             节点主题（pointer-events: all）
     *   .me-epd / .circle   展开圆点、连接圆点（pointer-events: all）
     *   .svg-label          连线/概要的文字（pointer-events: auto）
     *   .topiclinks / .summary  箭头与概要只在各自的 > g 上 pointer-events: stroke，要放行
     *   #input-box          库就地编辑时的输入框（contenteditable=plaintext-only）
     */
    const onBlank = (t: EventTarget | null): boolean => {
      const n = t as HTMLElement | null;
      if (!n || typeof n.closest !== 'function') return false;
      return !n.closest(
        '.me-tpc, .circle, .me-epd, .context-menu, .mind-elixir-toolbar, input, textarea,'
        + ' [contenteditable="true"], [contenteditable="plaintext-only"], #input-box,'
        + ' .svg-label, .label-container, .topiclinks, .summary, .mind-elixir-ghost',
      );
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // 修饰键留给框选
      if (mindRef.current?.spacePressed) return;                   // 空格留给库自己的平移
      if (!onBlank(e.target)) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      el.classList.add('mm-panning');
      // 拦住同一次 pointerdown：否则库会把这次拖动当成框选，画面还是不动
      e.stopPropagation();
      e.preventDefault();
    };

    const move = (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (!dx && !dy) return;
      // smooth 必须给 false：库在 smooth=true 时会给容器加 `transition: transform 0.3s`，
      // 而且**动画期间的每一次 move 都被直接丢弃**（dist: `if (n && transition === "transform 0.3s") return !1`），
      // 拖动就变成「动一下、停 300ms」——用户反馈的「灵敏度太低、拖不动」正是这个。
      // false = 每次 pointermove 直接改写 transform，与光标 1:1 跟手。
      mindRef.current?.move(dx, dy, false);
      e.stopPropagation();
    };

    const up = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      el.classList.remove('mm-panning');
      const t = e.target as HTMLElement | null;
      if (t?.hasPointerCapture?.(e.pointerId)) t.releasePointerCapture(e.pointerId);
      e.stopPropagation();
    };

    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      el.classList.remove('mm-panning');
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /** 缩放到指定倍数：夹在 ZOOM_MIN / ZOOM_MAX（与库的 scaleMin/scaleMax 同一对常量） */
  const zoomTo = (v: number) => {
    const mind = mindRef.current;
    if (!mind) return;
    mind.scale(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)));
  };
  const zoomStep = (dir: 1 | -1) => {
    const mind = mindRef.current;
    if (mind) zoomTo(mind.scaleVal * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  };

  /* ---------- 节点操作（库已有的能力，这里只把它们搬到菜单上） ---------- */

  /**
   * 节点操作统一入口。**不传 el**：库的这几个方法都默认作用在 currentNode 上
   * （dist 里 `let n = e || this.currentNode; if (!n) return;`），没选中时本来就是安全空操作；
   * 按钮再按 selCount 禁用一次，用户就不会点出「怎么没反应」的疑惑。
   */
  const nodeOp = (op: (mind: MindElixir) => void) => () => {
    const mind = mindRef.current;
    if (mind) op(mind);
  };
  const addSibling = nodeOp((m) => { void m.insertSibling('after'); });
  const addChild = nodeOp((m) => { void m.addChild(); });
  const addParent = nodeOp((m) => { void m.insertParent(); });
  const removeNode = nodeOp((m) => { void m.removeNodes(m.currentNodes ?? []); });
  const doUndo = nodeOp((m) => m.undo());
  const doRedo = nodeOp((m) => m.redo());

  /* ---------- 关系线（两步：起点 → 终点） ---------- */

  /**
   * 关系线。库的 createArrow(from, to) 要两个节点元素，而「点一下起点、再点一下终点」
   * 比「先框选两个再点按钮」更顺手，所以走两步模式：第一次点起点（selectNode 给视觉反馈），
   * 第二次点终点 → createArrow。库自带右键菜单里的「连线」是同一套流程，两条入口结果一致。
   * 第二次点终点 → createArrow。库自带右键菜单里的「连线」是同一套流程，两条入口结果一致。
   *
   * 画完**立刻进入文字输入**（库的 editArrowLabel）：关系线不带字等于没说清「这两点是什么关系」，
   * 而库把「写标签」藏在「选中后按 F2 / 双击那条线」里，用户基本发现不了。所以新建后就地把
   * 输入框打开，直接打字即可；Enter/失焦完成，Esc 放弃。已有关系线双击也能改（库的能力）。
   */
  const startLink = () => {
    if (!mindRef.current) return;
    if (linkMode) { setLinkMode(false); setLinkFrom(null); return; }
    setLinkMode(true);
    setLinkFrom(null);
    toast('连线：点起点节点 → 再点终点节点（Esc 取消）', 'info', 3600);
  };

  useEffect(() => {
    if (!linkMode || view !== 'map') return;
    const el = containerRef.current;
    if (!el) return;
    const h = (e: MouseEvent) => {
      const tpc = (e.target as HTMLElement | null)?.closest?.('.me-tpc') as Topic | null;
      const mind = mindRef.current;
      if (!tpc || !mind) return;
      // 节点 id 取自有坑：库把 id 存在 `dataset.nodeid = "me" + nodeObj.id` 上，
      // DOM 的 id 是**空的**（dist 里 createTopic：`t.dataset.nodeid = "me" + e.id`）。
      // 所以这里读元素身上的 nodeObj（库自己也是这么认节点的），再交给 findEle 反查。
      const id = tpc.nodeObj?.id;
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      if (!linkFrom) {
        mind.selectNode(tpc); // 起点给一次选中反馈，否则用户不知道第一下点到了没
        setLinkFrom(id);
        return;
      }
      if (id === linkFrom) { toast('起点和终点不能是同一个节点', 'info'); return; }
      const from = mind.findEle(linkFrom);
      const to = mind.findEle(id);
      if (from && to) {
        mind.createArrow(from, to);
        // 新建的那条关系线：库把箭头数据按创建顺序 push 进 arrows，SVG 元素的 id 就是箭头 id
        // 库渲染箭头时把新建的那条挂到 currentArrow 上（源码：`e.arrows.push(r), e.currentArrow = y`），
        // 所以直接用它——**不要**自己拼 DOM id：箭头 <g> 的 id 是 `"a-" + arrow.id`（不是 arrow.id），
        // 拼错就永远取不到元素、输入框永远打不开（这正是「画完写不了文字」的第一个原因）。
        const created = mind.currentArrow;
        if (created) mind.editArrowLabel(created); // 就地打开标签输入框，直接打字
        else toast('关系线已连好：双击这条线（或选中后按 F2）可以给它写文字', 'info', 4200);
      }
      setLinkMode(false);
      setLinkFrom(null);
    };
    /**
     * Esc 取消连线。用**捕获阶段** + preventDefault：
     * core/escStack 的 window keydown 只认「没被 defaultPrevented」的事件（见该文件头），
     * 所以这里拦下之后，「Esc 关掉整张导图」那层不会跟着触发——一次 Esc 只做一件事。
     */
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setLinkMode(false);
      setLinkFrom(null);
    };
    el.addEventListener('click', h, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      el.removeEventListener('click', h, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [linkMode, linkFrom, view]);

  /** 概要：库按「当前选中的一批同级节点」算范围，所以至少要选中两个 */
  const addSummary = () => {
    const mind = mindRef.current;
    if (!mind) return;
    if ((mind.currentNodes?.length ?? 0) < 2) {
      toast('先在图上选中两个以上同级节点，再点「概要」', 'info', 4200);
      return;
    }
    mind.createSummary();
  };

  /* ---------- 查找替换（节点文字） ---------- */

  /** 命中列表：遍历实例里的实时树（含还没保存的编辑），只认节点文字 */
  const findMatches = (key: string): Array<{ id: string; topic: string }> => {
    const mind = mindRef.current;
    const k = key.trim().toLowerCase();
    if (!mind || !k) return [];
    const out: Array<{ id: string; topic: string }> = [];
    const walk = (n: MindNode) => {
      const topic = `${n.topic ?? ''}`;
      if (n.id && topic.toLowerCase().includes(k)) out.push({ id: n.id, topic });
      for (const c of (n.children ?? []) as MindNode[]) walk(c);
    };
    const data = mind.getData() as { nodeData?: MindNode } | undefined;
    if (data?.nodeData) walk(data.nodeData);
    return out;
  };

  /**
   * 匹配列表。getData() 不是 React 能追踪的值，所以用 editStamp（每次替换后自增）
   * 当重算的扳机——比在渲染里无脑重算便宜，也比把整棵树塞进 state 省事。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => (view === 'map' && findOpen ? findMatches(findText) : []), [findText, findOpen, view, editStamp]);
  /** 当前游标：替换会让列表变短，这里夹一下，避免下标越界 */
  const hitIndex = matches.length ? Math.min(findHit, matches.length - 1) : -1;
  /** 查找条上的读数：没输入 / 没命中 / 第几处，三种情况说清楚，不留空白让人猜 */
  const findStatus = !findText.trim()
    ? '输入要查找的文字'
    : matches.length === 0
      ? '没有匹配的节点'
      : `第 ${hitIndex + 1} / ${matches.length} 处`;


  const gotoHit = (step: 1 | -1) => {
    const mind = mindRef.current;
    if (!mind || matches.length === 0) return;
    const next = (Math.max(hitIndex, 0) + step + matches.length) % matches.length;
    setFindHit(next);
    const el = mind.findEle(matches[next].id);
    if (el) mind.scrollIntoView(el, true); // 居中，命中点不会停在画面角上
  };

  /** 替换单个命中（节点 id 不变，改完只需重算列表） */
  const replaceAt = async (hit: { id: string; topic: string }) => {
    const mind = mindRef.current;
    const key = findText.trim();
    if (!mind || !key) return;
    const el = mind.findEle(hit.id);
    if (!el) return;
    const next = hit.topic.replace(new RegExp(escapeRe(key), 'gi'), replaceText);
    if (next === hit.topic) return;
    await mind.setNodeTopic(el, next);
    setEditStamp((s) => s + 1);
  };

  const replaceOne = async () => {
    const hit = matches[hitIndex];
    if (!hit) return;
    await replaceAt(hit);
    const mind = mindRef.current;
    if (mind) { const el = mind.findEle(hit.id); if (el) mind.scrollIntoView(el, true); }
  };

  const replaceAll = async () => {
    const list = matches;
    if (list.length === 0) return;
    // 串行：setNodeTopic 是异步的，逐个 await 才能保证每一次都落进撤销栈、顺序也对
    for (const hit of list) await replaceAt(hit);
    setFindHit(0);
    toast(`已替换 ${list.length} 处`, 'ok', 3200);
  };


  /* ---------- 问 AI（复用 AI 面板的「引用」通道，不另造第二条 AI 通道） ---------- */

  /**
   * 把「整张导图 / 选中节点这一支 / 整理标签」交给 AI 笔记面板。
   *
   * 为什么只做「送进去」这一件事：改写要落到笔记正文上，而正文的写回只有面板那条链带闸门
   * （propose_note_patch → 先给 diff，用户点「应用」才写），模型、安全档位、历史版本也都在那边。
   * 面板收到后只**预填**要求、不自动发送（见 AiAgentPanel 的 quote 消费），所以点错也来得及改。
   *
   * 写回后导图会不会跟着变：面板「应用」→ Workspace 的 onSave → setDraft → 本组件的 content 变
   * → 实例按新正文重建（见文件头 ②）。编辑器里若还有未保存的手改，则有意不动它（那是在写的东西），
   * 这种情况面板与编辑器各自都会提示。
   */
  const askAi = (kind: 'full' | 'subtree' | 'tags') => {
    const mind = mindRef.current;
    if (!onAskAi || !mind) return;
    const self = kind === 'subtree'
      ? ((mind.currentNode as Topic | null | undefined)?.nodeObj as MindNode | undefined)
      : undefined;
    const topic = `${self?.topic ?? ''}`.trim();
    if (kind === 'subtree' && !self) {
      toast('先在图上点一个节点，再点「改写这支」', 'info', 3200);
      return;
    }
    const tree = kind === 'subtree' ? self : currentTree();
    const text = tree ? mindToMd(tree as { topic?: string; children?: unknown[] }) : '';
    if (!text.trim()) {
      toast('这张导图还没有内容：先加几个节点再交给 AI', 'info', 3200);
      return;
    }
    onAskAi({ text, path: prefKey, ask: kind === 'subtree' ? AI_ASKS.subtree(topic) : AI_ASKS[kind] });
    toast('已交给 AI 面板：点「应用」写回后导图会跟着刷新（编辑器里有未保存的手改时不会自动刷新）', 'ok', 5200);
  };

  const save = () => {
    const fm = content.match(FM_RE)?.[0] ?? '';
    let body: string;
    if (view === 'outline') {
      // 复用同一个 parseOutline 把文本解析回树，再用 treeToMd 规范序列化：
      // 与「导图视图保存」是同一条链路，所以笔记里的字节形状（含 `## 小节` 复习卡）一字不变。
      body = treeToMd(parseOutline(outline));
    } else {
      const tree = currentTree();
      // 实例还没起来（极端时序）：宁可不动，也不要把笔记写空
      if (!tree) return;
      body = mindToMd(tree);
    }
    // 把两个视图的缓冲都对齐到刚写回的那份：否则用户在文本框里看到的还是旧缩进/旧层级，
    // 会以为「保存没生效」
    mapSourceRef.current = body;
    setOutline(body);
    onSaveRef.current?.(fm + body);
  };

  return (
    <div className="panel panel--full mindmap-overlay">
      <div className="mindmap-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mindmap-header">
          <span className="panel__title mindmap-title">思维导图 · {title}</span>
          <div className="mindmap-actions">
            {/* 视图：导图 ↔ 大纲。状态直接写在按钮上（文案 + aria-pressed），不另造开关控件 */}
            <button
              className="btn-small"
              aria-pressed={view === 'outline'}
              onClick={() => switchView(view === 'map' ? 'outline' : 'map')}
            >
              {view === 'map' ? '大纲视图' : '导图视图'}
            </button>
            <button className="btn-small" onClick={save}>保存并写回笔记</button>
            <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
          </div>
        </div>
        {/* 工具条收纳：收起后只剩这一条 30px 细条——它在画布**上方**的正常流里，
            所以任何时候都不覆盖画布；收起时画布直接多出工具条那几行的高度。
            为什么用条件渲染而不是 CSS 隐藏：隐藏的按钮仍会进 Tab 顺序、仍会被读屏念出来，
            而「不占空间」用「根本不渲染」表达最直白。 */}
        {view === 'map' && (
          <button
            type="button"
            className={`mindmap-tools-toggle${toolsOpen ? ' on' : ''}`}
            aria-expanded={toolsOpen}
            aria-controls="mm-tools mm-tools-format"
            title={toolsOpen ? '收起工具条（画布更高，做笔记时不被挡视线）' : '展开工具条'}
            onClick={toggleTools}
          >
            <IconChevron open={toolsOpen} />
            <span className="mindmap-tools-toggle__label">工具</span>
            <span className="mindmap-tools-toggle__hint">{toolsOpen ? '收起' : '展开'}</span>
          </button>
        )}
        {view === 'map' && toolsOpen && (
          <div className="mindmap-toolbar" id="mm-tools">
            {/* 画布：拖空白处平移（见上面的 pointerdown 拦截），这里是缩放与归位 */}
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">画布</span>
              <button className="chip mm-btn-sm" onClick={() => zoomStep(-1)} aria-label="缩小" title="缩小">−</button>
              <button className="chip mm-zoom-readout" onClick={() => zoomTo(1)} title="回到 100%">{Math.round(zoom * 100)}%</button>
              <button className="chip mm-btn-sm" onClick={() => zoomStep(1)} aria-label="放大" title="放大">＋</button>
              <button className="chip" onClick={() => mindRef.current?.scaleFit()} title="缩放到刚好放下整张导图">适应</button>
              <button className="chip" onClick={() => mindRef.current?.toCenter()} title="把根节点移回画面中央">居中</button>
              {/* 全屏：库自带的图标工具条里有这一个，我们关掉了那条（消除重复），所以补到这里 */}
              <button
                className="chip"
                onClick={() => {
                  const box = containerRef.current?.closest('.mindmap-overlay') as HTMLElement | null;
                  if (!box) return;
                  if (document.fullscreenElement) void document.exitFullscreen?.();
                  else void box.requestFullscreen?.();
                }}
                title="全屏显示（再点一次退出，Esc 也能退出）"
              >
                全屏
              </button>
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            {/* 节点：库的方法默认作用在当前选中节点上；没选中时按钮禁用，避免点出「没反应」 */}
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">节点</span>
              <button className="chip" disabled={!selCount} onClick={addSibling} title="在选中节点后面加一个同级节点（Enter）">同级</button>
              <button className="chip" disabled={!selCount} onClick={addChild} title="在选中节点下加子节点（Tab）">子级</button>
              <button className="chip" disabled={!selCount} onClick={addParent} title="给选中节点套一层上级（Ctrl+Enter）">上级</button>
              <button className="chip" disabled={!selCount} onClick={removeNode} title="删除选中的节点（Delete）">删除</button>
              <span className="mindmap-toolbar__sep" aria-hidden="true" />
              <button className="chip" onClick={doUndo} title="撤销（Ctrl+Z）">撤销</button>
              <button className="chip" onClick={doRedo} title="重做（Ctrl+Y）">重做</button>
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">插入</span>
              <button
                className={`chip${linkMode ? ' on' : ''}`}
                aria-pressed={linkMode}
                onClick={startLink}
                title="在两个节点之间拉一条关系线：点起点，再点终点"
              >
                <IconLink size={13} /> 关系线
              </button>
              <button className="chip" disabled={selCount < 2} onClick={addSummary} title="给选中的多个同级节点加一个概要括号">概要</button>
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">工具</span>
              <button
                className={`chip${findOpen ? ' on' : ''}`}
                aria-pressed={findOpen}
                onClick={() => setFindOpen((v) => !v)}
                title="查找 / 替换节点文字"
              >
                <IconSearch size={13} /> 查找替换
              </button>
              {/* 问 AI：只把内容与要求送进 AI 面板（不传 onAskAi 的调用点不渲染这三个按钮）。
                  改写最终落在这篇笔记的正文上，写回由面板那条链把关（propose_note_patch → 先 diff 再应用）。 */}
              {onAskAi && (
                <>
                  <button
                    className="chip"
                    onClick={() => askAi('full')}
                    title="把整张导图交给 AI 面板，按它改写这篇笔记的正文（在面板里确认才写回）"
                  >
                    AI 改写
                  </button>
                  <button
                    className="chip"
                    disabled={!selCount}
                    onClick={() => askAi('subtree')}
                    title="把选中节点这一支交给 AI 面板，扩写成正文（在面板里确认才写回）"
                  >
                    改写这支
                  </button>
                  <button
                    className="chip"
                    onClick={() => askAi('tags')}
                    title="让 AI 读这篇笔记，整理 3-5 个标签写进 frontmatter（正文一个字不动）"
                  >
                    标签总结
                  </button>
                </>
              )}
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            {/* 连线：与方向正交的第二条轴（直角 = 同类 App 的「逻辑图 / 组织结构」那一路） */}
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">连线</span>
              {LINE_STYLES.map((l) => (
                <button
                  key={l.id}
                  className={`chip${line === l.id ? ' on' : ''}`}
                  title={l.hint}
                  onClick={() => applyLine(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            {/* 编号：纯显示层（CSS 计数器），选完立刻在节点左侧看到号，不动一个字的内容 */}
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">编号</span>
              <select
                className="mindmap-select"
                aria-label="标题编号"
                value={numbering}
                onChange={(e) => applyNumbering(e.target.value as MindMapNumbering)}
              >
                {NUMBERINGS.map((n) => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
            </div>
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">布局</span>
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  className={`chip${direction === l.id ? ' on' : ''}`}
                  title={l.hint}
                  onClick={() => applyDirection(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">主题</span>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`chip${themeId === t.id ? ' on' : ''}`}
                  title={t.hint}
                  onClick={() => applyTheme(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 格式条：字体 / 字号 / 粗斜下删 / 字色 / 底色 / 对齐 / 形状 / 范围 / 格式刷。
            选中节点后每一项都作用在它身上（范围选「含子节点」则整棵子树），
            样式存 localStorage 并按节点文本路径命名（见 core/mindmapNodeStyles），笔记字节不动。 */}
        {view === 'map' && toolsOpen && (
          <div className="mindmap-toolbar mindmap-toolbar--format" id="mm-tools-format">
            <div className="mindmap-toolbar__group">
              <span className="mindmap-toolbar__label">格式</span>
              <select
                className="mindmap-select"
                aria-label="字体"
                disabled={!selCount}
                value={fontFamilyId}
                onChange={(e) => apply(formatById('fontFamily', e.target.value))}
              >
                {STYLE_PRESETS.fontFamily.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select
                className="mindmap-select"
                aria-label="字号"
                disabled={!selCount}
                value={fontSizeId}
                onChange={(e) => apply(formatById('fontSize', e.target.value))}
              >
                {STYLE_PRESETS.fontSize.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button
                className={`chip mm-fmt${bold ? ' on' : ''}`}
                disabled={!selCount}
                aria-pressed={bold}
                aria-label="粗体"
                title="粗体"
                onClick={() => apply({ fontWeight: bold ? null : 'bold' })}
              >
                <b>B</b>
              </button>
              <button
                className={`chip mm-fmt${italic ? ' on' : ''}`}
                disabled={!selCount}
                aria-pressed={italic}
                aria-label="斜体"
                title="斜体"
                onClick={() => apply({ fontStyle: italic ? null : 'italic' })}
              >
                <i>I</i>
              </button>
              <button
                className={`chip mm-fmt${underline ? ' on' : ''}`}
                disabled={!selCount}
                aria-pressed={underline}
                aria-label="下划线"
                title="下划线"
                onClick={() => toggleDecoration('underline')}
              >
                <u>U</u>
              </button>
              <button
                className={`chip mm-fmt${strike ? ' on' : ''}`}
                disabled={!selCount}
                aria-pressed={strike}
                aria-label="删除线"
                title="删除线"
                onClick={() => toggleDecoration('line-through')}
              >
                <s>S</s>
              </button>
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            <div className="mindmap-toolbar__group">
              <select
                className="mindmap-select"
                aria-label="字色"
                disabled={!selCount}
                value={colorId}
                onChange={(e) => apply(formatById('color', e.target.value))}
              >
                {STYLE_PRESETS.color.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select
                className="mindmap-select"
                aria-label="底色"
                disabled={!selCount}
                value={backgroundId}
                onChange={(e) => apply(formatById('background', e.target.value))}
              >
                {STYLE_PRESETS.background.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select
                className="mindmap-select"
                aria-label="形状"
                disabled={!selCount}
                value={shapeId}
                onChange={(e) => apply(formatById('shape', e.target.value))}
              >
                {STYLE_PRESETS.shape.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button
                className={`chip${curStyle?.textAlign === 'left' ? ' on' : ''}`}
                disabled={!selCount}
                aria-label="左对齐"
                title="左对齐"
                onClick={() => apply({ textAlign: curStyle?.textAlign === 'left' ? null : 'left' })}
              >
                ⇤
              </button>
              <button
                className={`chip${curStyle?.textAlign === 'center' ? ' on' : ''}`}
                disabled={!selCount}
                aria-label="居中"
                title="居中"
                onClick={() => apply({ textAlign: curStyle?.textAlign === 'center' ? null : 'center' })}
              >
                ⇥
              </button>
              <button
                className={`chip${curStyle?.textAlign === 'right' ? ' on' : ''}`}
                disabled={!selCount}
                aria-label="右对齐"
                title="右对齐"
                onClick={() => apply({ textAlign: curStyle?.textAlign === 'right' ? null : 'right' })}
              >
                ⇨
              </button>
            </div>
            <span className="mindmap-toolbar__sep" aria-hidden="true" />
            <div className="mindmap-toolbar__group">
              <label className="mindmap-toolbar__label" htmlFor="mm-style-scope">范围</label>
              <select
                id="mm-style-scope"
                className="mindmap-select"
                aria-label="格式范围"
                value={styleScope}
                onChange={(e) => setStyleScope(e.target.value as 'node' | 'subtree')}
              >
                <option value="node">该节点</option>
                <option value="subtree">该节点及所有子节点</option>
              </select>
              <button
                className={`chip${brush ? ' on' : ''}`}
                disabled={!selCount && !brush}
                aria-pressed={!!brush}
                onClick={pickBrush}
                title="取当前节点的样式，再点别的节点即可刷上；再点一次取消"
              >
                格式刷
              </button>
              <button
                className="chip"
                disabled={!selCount}
                onClick={() => apply(
                  Object.fromEntries(NODE_STYLE_KEYS.map((k) => [k, null])) as Partial<Record<keyof NodeStyle, null>>,
                )}
                title="清掉该节点的全部格式，回到主题默认"
              >
                清除格式
              </button>
            </div>
          </div>
        )}
        {view === 'map' && findOpen && (
          <div className="mindmap-findbar">
            <IconSearch size={14} />
            <input
              className="mindmap-findbar__input"
              placeholder="查找节点文字"
              aria-label="查找"
              value={findText}
              onChange={(e) => { setFindText(e.target.value); setFindHit(0); }}
              onKeyDown={(e) => { if (e.key === 'Enter') gotoHit(e.shiftKey ? -1 : 1); }}
            />
            <input
              className="mindmap-findbar__input"
              placeholder="替换为"
              aria-label="替换为"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
            />
            <span className="mindmap-findbar__count muted" data-testid="mm-find-count">{findStatus}</span>
            <button className="btn-small" disabled={!matches.length} onClick={() => gotoHit(-1)}>上一个</button>
            <button className="btn-small" disabled={!matches.length} onClick={() => gotoHit(1)}>下一个</button>
            <button className="btn-small" disabled={!matches.length} onClick={() => void replaceOne()}>替换</button>
            <button className="btn-small" disabled={!matches.length} onClick={() => void replaceAll()}>全部替换</button>
            <button className="btn-icon" onClick={() => setFindOpen(false)} aria-label="关闭查找"><IconClose /></button>
          </div>
        )}
        {view === 'map' && linkMode && (
          <div className="mindmap-linkhint" role="status">
            <IconLink size={13} /> {linkFrom ? '已选起点，再点终点节点完成连线' : '点一个节点作为起点'}；Esc 或再点一次「关系线」取消
          </div>
        )}
        <div className="panel__body mindmap-body">
          {view === 'map' ? (
            // mm-plain / mm-warm 是两个主题的 CSS 钩子：库只给了 --main-border / --root-border-color
            // 两个边框出口，box-shadow 与下划线没有对应变量——「下划线」（plain）与「柔光阴影 + 暖纸画布」（warm）
            // 只能由 index.css 末尾那两组规则按类名给；
            // mm-num 是「标题编号」的钩子，编号内容随 style 上的 --mm-num* 一起给（见 core/mindmapStyles）。
            <div
              ref={containerRef}
              className={`mindmap-elixir${themeId === 'plain' ? ' mm-plain' : ''}${themeId === 'warm' ? ' mm-warm' : ''}${numbering !== 'none' ? ' mm-num' : ''}`}
              style={numberingVars(numbering)}
            />
          ) : (
            <textarea
              className="mindmap-outline"
              value={outline}
              spellCheck={false}
              aria-label="导图大纲文本"
              onChange={(e) => setOutline(e.target.value)}
            />
          )}
        </div>
        <div className="mindmap-hint muted">
          <span><b>拖空白</b> 平移画布</span>
          <span><b>Shift+拖</b> 框选多个</span>
          <span><b>滚轮</b> 缩放</span>
          <span><b>Shift+滚轮</b> 横向平移</span>
          <span><b>Tab</b> 加子级</span>
          <span><b>Enter</b> 加同级</span>
          <span><b>双击</b> 改字</span>
          <span><b>双击关系线</b> 写文字（F2）</span>
          <span><b>右键</b> 更多操作</span>
          <span className="mindmap-hint__tip">改完点「保存并写回笔记」</span>
        </div>
      </div>
    </div>
  );
}
