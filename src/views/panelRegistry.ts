/**
 * 面板注册表：**一张表描述所有面板**。
 *
 * 之前同一批面板被描述了四遍，加一个功能要同步改四处、漏一处就是线上 bug：
 *   ① `railCatalog.tsx`          —— 轨上有没有这个入口
 *   ② `featureRouting.RAIL_MODAL` —— 打开它要不要先关掉别的整屏面板
 *   ③ `Workspace.openFeature`     —— 点轨上按钮执行什么
 *   ④ `Workspace.modalClosers`    —— 切换面板时怎么把它关掉
 *
 * 现在只剩这一份。②④ 由 `MODAL_IDS` / `RAIL_MODAL` 派生，③ 由 `PANEL_BY_RAIL` 派生，
 * ① 仍归 railCatalog（它同时管分组、图标、文案，属于导航层的关注点）。
 *
 * 一致性由 `__tests__/panelRegistry.test.ts` 守着：轨上每个入口都必须有对应面板，
 * 注册表里每个 modal 也必须在 `MODAL_IDS` 里——两边对不上就红。
 */
import type { RailKey } from './railCatalog';

/**
 * 面板 id。命名沿用「遮罩层里那一块」的说法，与 `closeModals(keep)` 的键一一对应。
 *
 * `report` 与 `dash` 是两块不同的东西，别合并：
 *   - `dash`  = 学习报告页（Dashboard，数据汇总）
 *   - `report` = 单次学习报告面板（StudyReportPanel，按区间生成）
 */
export type PanelId =
  | 'search' | 'palette'
  | 'quiz' | 'exam' | 'review' | 'mistakes' | 'vocab' | 'words'
  | 'recite'
  | 'todos' | 'dash' | 'report'
  | 'graph' | 'mind' | 'tags' | 'medref' | 'import'
  | 'pdf' | 'convert' | 'history' | 'notice' | 'settings' | 'integrity'
  | 'pet'
  | 'anatomy' | 'brain' | 'imageLib'
  | 'ai' | 'agent' | 'draft' | 'video'
  | 'course'
  | 'matgen';

export interface PanelDef {
  id: PanelId;
  /**
   * 导航轨上的入口键。不填 = 只能从首页、命令面板或其他面板里进
   * （模拟考试、生词本、学习报告面板、图片库都属于这一类）。
   */
  rail?: RailKey;
  /**
   * true = 整屏模态面板：打开它先把别的模态关掉（同一时刻只该存在一个遮罩）。
   * false = 可与内容共存的浮层：目录侧栏、右侧 AI 栏、视频小窗。
   */
  modal: boolean;
  /**
   * 互斥组：同组互斥但不关别的面板。
   * `ai` 组 = 问答 / AI 笔记 / 智能草稿三合一——三者都锚在右边缘，同时打开会完全重叠。
   */
  group?: 'ai';
  /** 给注册表读者的说明（为什么它必须/不必是模态），不参与运行时逻辑 */
  note?: string;
}

export const PANELS: readonly PanelDef[] = [
  // ---- 整屏模态：笔记与检索 ----
  { id: 'search', rail: 'search', modal: true },
  { id: 'palette', modal: true, note: 'Ctrl+Shift+P 命令面板，z-index 与快速搜索同级' },
  { id: 'history', rail: 'history', modal: true },
  { id: 'notice', rail: 'notice', modal: true },
  { id: 'settings', rail: 'settings', modal: true },
  { id: 'integrity', modal: true, note: '从设置进入的数据自检；不占导航轨，避免低频维护功能挤进入口' },
  { id: 'pet', modal: true, note: '桌宠自定义：从设置里进入，不占导航轨——桌宠是陪伴，不是功能入口' },

  // ---- 整屏模态：练习与复习 ----
  { id: 'quiz', rail: 'quiz', modal: true },
  { id: 'exam', modal: true, note: '从题库列表进入，轨上没有独立入口' },
  { id: 'review', rail: 'review', modal: true },
  { id: 'recite', modal: true, note: '全屏背诵：从笔记分屏预览进去，轨上没有独立入口' },
  { id: 'mistakes', rail: 'mistakes', modal: true },
  { id: 'vocab', modal: true },
  // 单词工坊：跟打 / 听写 / 自测三块工作区要同时看到题目与错词本，整屏更合适
  { id: 'words', rail: 'words', modal: true },

  // ---- 整屏模态：统计与组织 ----
  { id: 'dash', rail: 'report', modal: true, note: '轨上「学习」入口打开的是这一块' },
  { id: 'report', modal: true, note: '单次学习报告，从学习报告页/首页进' },
  { id: 'todos', rail: 'todos', modal: true },
  { id: 'tags', rail: 'tags', modal: true },

  // ---- 整屏模态：资料 ----
  { id: 'graph', rail: 'graph', modal: true },
  { id: 'mind', rail: 'mind', modal: true },
  { id: 'medref', rail: 'medref', modal: true },
  { id: 'anatomy', rail: 'anatomy', modal: true },
  { id: 'brain', rail: 'brain', modal: true },
  { id: 'imageLib', modal: true },
  { id: 'import', rail: 'import', modal: true },
  { id: 'pdf', rail: 'pdf', modal: true },
  { id: 'convert', rail: 'convert', modal: true },

  // ---- 整屏模态：科研工具 ----
  // 课程工坊：输入 → 分P → 抓字幕 → 生成讲义/人格卡，整个流程要一块完整工作区
  { id: 'course', rail: 'course', modal: true },
  // 资料生成：素材导入 → AI 规划大纲 → 分节生成讲义，同课程工坊一样要一块完整工作区
  { id: 'matgen', rail: 'matgen', modal: true },

  // ---- 可共存的浮层 ----
  { id: 'video', rail: 'video', modal: false, note: '右侧小窗，与正文并存' },
  { id: 'ai', rail: 'ai', modal: false, group: 'ai', note: '轨上「AI」三合一，打开的是问答' },
  { id: 'agent', modal: false, group: 'ai', note: 'AI 笔记，与视频共用右栏' },
  { id: 'draft', modal: false, group: 'ai', note: '智能草稿' },
];

export const PANEL_INDEX: Record<PanelId, PanelDef> = Object.fromEntries(
  PANELS.map((p) => [p.id, p]),
) as Record<PanelId, PanelDef>;

/** 全部整屏模态面板的 id（`closeModals` 的遍历范围） */
export const MODAL_IDS: readonly PanelId[] = PANELS.filter((p) => p.modal).map((p) => p.id);

/** 导航轨入口 → 它打开的整屏模态面板。非模态的（tree / ai / video）不在表里 */
export const RAIL_MODAL: Partial<Record<RailKey, PanelId>> = Object.fromEntries(
  PANELS.filter((p): p is PanelDef & { rail: RailKey } => Boolean(p.rail) && p.modal)
    .map((p) => [p.rail, p.id]),
);

/** 导航轨入口 → 面板（含非模态）。Workspace 据此生成 `openFeature` 的默认分支 */
export const PANEL_BY_RAIL: Partial<Record<RailKey, PanelDef>> = Object.fromEntries(
  PANELS.filter((p): p is PanelDef & { rail: RailKey } => Boolean(p.rail))
    .map((p) => [p.rail, p]),
);

/** 同一互斥组里的其他面板（用于「打开 ai 时关掉 agent/draft」） */
export function siblingsOf(id: PanelId): PanelId[] {
  const group = PANEL_INDEX[id]?.group;
  if (!group) return [];
  return PANELS.filter((p) => p.group === group && p.id !== id).map((p) => p.id);
}
