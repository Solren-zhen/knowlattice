/**
 * 思维导图的**呈现层预设**：连线样式与标题编号。
 *
 * 为什么单独一个模块（而不是继续堆在 views/MindMapView.tsx 里）：
 *   ① 这两样都是**纯数据 + 纯函数**——连线生成器只吃几何参数、编号只产出 CSS 内容串，
 *      没有任何 DOM / 实例依赖，放 core 里可以直接单测（几何算错了单测立刻红）；
 *   ② 视图文件已经负责实例生命周期、Markdown 互转、工具栏，把「样式清单」再塞进去只会
 *      让它继续膨胀；改一个编号方案不该动一个千行组件。
 *
 * 与 core/mindmapPrefs 的分工：那边管「这篇笔记选了哪一项」（存储与白名单），这里管
 * 「每一项到底是什么」（几何与 CSS 值）。两边的 id 一一对应，白名单在 prefs 里。
 *
 * 层级结构备忘（下面编号用的选择器链全靠它，已由真实渲染核对过）：
 *   `.me-nodes > .me-main > .me-wrapper > .me-parent > .me-tpc`
 *   `.me-nodes > .me-main > .me-wrapper > .me-children > .me-wrapper > .me-parent > .me-tpc`
 *   `.me-nodes > .me-main > .me-wrapper > .me-children > .me-wrapper > .me-children > .me-wrapper > .me-parent > .me-tpc`
 * 也就是**子级是纯 `.me-wrapper` 循环**，`.me-main` 只出现在第一条主分支上；根是 `.me-root`。
 */
import type { MainLineParams, SubLineParams } from 'mind-elixir';
import type { MindMapLine, MindMapNumbering } from './mindmapPrefs';

/* ---------- 连线样式（与「方向」正交的第二个轴） ---------- */

/**
 * 直角折线（同类 App 里的「逻辑图 / 组织结构」连线）：横 → 竖 → 横，收在节点边缘。
 * 为什么自己写生成器：库自带的是贝塞尔曲线，而「逻辑图」要横平竖直；库的 theme 正好
 * 暴露了 generateMainBranch / generateSubBranch 两个出口（「纯文字大纲」主题也在用同一条路）。
 */
export function orthoPath(g: BranchGeom, fromBottom: boolean): string {
  const { pT, pL, pW, pH, cT, cL, cW, cH, direction } = g;
  // 纵向布局：竖 → 横 → 竖
  if (direction === 'down') {
    const x1 = pL + pW / 2;
    const y1 = pT + pH;
    const x2 = cL + cW / 2;
    const y2 = cT;
    const mid = y1 + (y2 - y1) / 2;
    return `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`;
  }
  // 横向布局（lhs = 向左侧展开）：横 → 竖 → 横
  const lhs = direction === 'lhs';
  const x1 = lhs ? pL : pL + pW;
  const x2 = lhs ? cL + cW : cL;
  // 主分支从父节点竖直中点出发；子分支从父节点下缘出发，更像逻辑图里「从父节点挂下来」
  const y1 = fromBottom ? pT + pH : pT + pH / 2;
  const y2 = cT + cH / 2;
  const mid = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
}

/**
 * 直角折线只需要这九个字段（库给主分支的参数还多一个 containerHeight，子分支没有），
 * 所以取这九项的交集而不是写死 MainLineParams——否则 SubLineParams 传不进来
 * （TS 会判「两种类型不重叠」）。
 */
export type BranchGeom = Pick<
  MainLineParams,
  'pT' | 'pL' | 'pW' | 'pH' | 'cT' | 'cL' | 'cW' | 'cH' | 'direction'
>;

export function orthoMainBranch(p: MainLineParams): string {
  return orthoPath(p, false);
}
export function orthoSubBranch(p: SubLineParams): string {
  return orthoPath(p, true);
}

export const LINE_STYLES: Array<{ id: MindMapLine; label: string; hint: string }> = [
  { id: 'curve', label: '曲线', hint: '库自带的平滑贝塞尔连线（默认）' },
  { id: 'ortho', label: '直角', hint: '横平竖直的折线——同类 App 的「逻辑图 / 组织结构」用的就是这一路' },
];

/* ---------- 标题编号 ---------- */

/**
 * 七种编号方案 + 不编号，对齐同类 App 右栏「标题编号」那一组。
 *
 * 每项的 `vars` 是三层的 CSS `content` 值（第 1/2/3 层各一条），里面用 CSS 计数器
 * mml1/mml2/mml3——它们的自增与重置由 index.css 里那三条 depth 规则负责，两边靠
 * 计数器名对齐。多层之间用「.」连接、末尾按方案补收尾符（`.` / `、` / 括号 / 圈码）。
 *
 * 为什么用 CSS 计数器而不是把编号写进节点文字：写进文字＝改笔记正文，用户点一下编号
 * 整篇笔记的字节就变了（保存链、外部同步、复习卡解析全跟着动），和「存储格式一个字不动」
 * 的既有边界冲突；显示层编号天然可逆——换方案、清除编号都不碰数据。
 */
export const NUMBERINGS: Array<{
  id: MindMapNumbering;
  label: string;
  vars: [string, string, string] | null;
}> = [
  { id: 'none', label: '不编号', vars: null },
  {
    id: 'dot',
    label: '1. 2. 3.',
    vars: [
      'counter(mml1) "."',
      'counter(mml1) "." counter(mml2)',
      'counter(mml1) "." counter(mml2) "." counter(mml3)',
    ],
  },
  {
    id: 'comma',
    label: '1、2、3、',
    vars: [
      'counter(mml1) "、"',
      'counter(mml1) "." counter(mml2) "、"',
      'counter(mml1) "." counter(mml2) "." counter(mml3) "、"',
    ],
  },
  {
    id: 'paren',
    label: '(1) (2)',
    vars: [
      '"(" counter(mml1) ")"',
      '"(" counter(mml1) "." counter(mml2) ")"',
      '"(" counter(mml1) "." counter(mml2) "." counter(mml3) ")"',
    ],
  },
  {
    id: 'cn-dot',
    label: '一、二、',
    vars: [
      'counter(mml1, cjk-ideographic) "、"',
      'counter(mml1, cjk-ideographic) "." counter(mml2, cjk-ideographic) "、"',
      'counter(mml1, cjk-ideographic) "." counter(mml2, cjk-ideographic) "." counter(mml3, cjk-ideographic) "、"',
    ],
  },
  {
    id: 'cn-paren',
    label: '(一) (二)',
    vars: [
      '"(" counter(mml1, cjk-ideographic) ")"',
      '"(" counter(mml1, cjk-ideographic) "." counter(mml2, cjk-ideographic) ")"',
      '"(" counter(mml1, cjk-ideographic) "." counter(mml2, cjk-ideographic) "." counter(mml3, cjk-ideographic) ")"',
    ],
  },
  {
    id: 'alpha',
    label: 'A. B. C.',
    vars: [
      'counter(mml1, upper-alpha) "."',
      'counter(mml1, upper-alpha) "." counter(mml2, upper-alpha)',
      'counter(mml1, upper-alpha) "." counter(mml2, upper-alpha) "." counter(mml3, upper-alpha)',
    ],
  },
  {
    id: 'circled',
    label: '①②③',
    vars: [
      'counter(mml1, circled-decimal)',
      'counter(mml1, circled-decimal) counter(mml2, circled-decimal)',
      'counter(mml1, circled-decimal) counter(mml2, circled-decimal) counter(mml3, circled-decimal)',
    ],
  },
];

/**
 * 编号方案 → 容器上的 CSS 变量。`--mm-num*` 由 index.css 的 `content: var(...)` 消费。
 * 末尾统一补一个空格字符串，编号与节点文字之间才有间距（节点自己的 padding 管不到 ::before）。
 * 不编号 → 空对象（容器也就不会带上那些变量）。
 */
export function numberingVars(id: MindMapNumbering): Record<string, string> {
  const vars = NUMBERINGS.find((n) => n.id === id)?.vars;
  if (!vars) return {};
  return {
    '--mm-num1': `${vars[0]} " "`,
    '--mm-num2': `${vars[1]} " "`,
    '--mm-num3': `${vars[2]} " "`,
  };
}
