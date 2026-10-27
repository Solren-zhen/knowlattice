/**
 * 导航轨的去处表：功能入口的**唯一**清单。
 *
 * 单独一个文件（不放 Rail.tsx）有两个原因：
 *   - Rail.tsx 只导出组件，常量搬走后 Fast Refresh 才能整块换掉而不丢状态（oxlint 的 only-export-components）；
 *   - 首页「最近使用」要按 key 取 label / icon，从这张表取，就不会长出第二份文案和第二套分组名。
 *
 * 加一个功能 = 这里加一行，再去 Workspace 的 openFeature 补一个处理器（漏了编译不过）。
 */
import type { ReactNode } from 'react';
import {
  IconAi, IconBody, IconBook, IconBrain, IconCards, IconChart, IconConvert,
  IconFolderIn, IconGraph, IconHistory, IconInfo, IconPathway, IconQuiz,
  IconSearch, IconTag, IconTarget, IconTodo, IconTree, IconVideo,
} from './icons';

/** 去处的键：与 Workspace 的 railActions 一一对应（那边漏一个键会编译失败） */
export type RailKey =
  | 'tree' | 'search'
  | 'quiz' | 'review' | 'mistakes' | 'report' | 'todos' | 'video'
  | 'graph' | 'anatomy' | 'brain' | 'mind' | 'pathway' | 'tags' | 'medref'
  | 'import' | 'pdf' | 'convert' | 'history' | 'notice'
  | 'ai' | 'settings';

export interface Entry {
  key: RailKey;
  label: string;
  icon: ReactNode;
  /** 每天都在用的那几处：首页还没有使用记录时默认露出它们 */
  primary?: boolean;
  /**
   * 浮层类入口（如视频笔记）：窄屏抽屉点完**先别收**。
   * 抽屉一收，同一个浮层想再点一次收起就得先把抽屉重新展开——那正是「开关语义」失效的地方。
   * 全屏面板不设这个标记：它们遮住整屏，点完就收抽屉才是对的。
   */
  keepDrawer?: boolean;
}
/** 一个母主题 */
export interface RailGroup {
  title: string;
  /**
   * 母主题的图标。收起态只露这五个图标，所以它必须自己说明「这一类装的是什么」——
   * 而不是五个形状差不多的方块。
   */
  icon: ReactNode;
  entries: Entry[];
}

/** 分组的依据是「用户想干什么」，不是「什么时候开发的」。这张表是功能入口的**唯一**清单：
 *  首页「最近使用」的文案与图标也从这里取（RAIL_INDEX），不另写一份。 */
export const RAIL_GROUPS: RailGroup[] = [
  {
    title: '工作区',
    icon: <IconTree />,
    entries: [
      { key: 'tree', label: '目录', icon: <IconTree />, primary: true },
      { key: 'search', label: '搜索', icon: <IconSearch />, primary: true },
    ],
  },
  {
    title: '学习',
    icon: <IconQuiz />,
    entries: [
      { key: 'quiz', label: '题库练习', icon: <IconQuiz />, primary: true },
      { key: 'review', label: '间隔复习', icon: <IconCards />, primary: true },
      { key: 'ai', label: 'AI 助手', icon: <IconAi />, primary: true },
      // keepDrawer：视频是浮层不是整屏面板，点完别收抽屉，否则「再点一次收起」要重新展开
      { key: 'video', label: '视频笔记', icon: <IconVideo />, keepDrawer: true },
      { key: 'mistakes', label: '错题本', icon: <IconTarget />, primary: true },
      { key: 'report', label: '学习报告', icon: <IconChart /> },
      { key: 'todos', label: '待办', icon: <IconTodo /> },
    ],
  },
  {
    title: '资料',
    icon: <IconBook />,
    entries: [
      { key: 'graph', label: '知识图谱', icon: <IconGraph /> },
      { key: 'anatomy', label: '3D 解剖', icon: <IconBody /> },
      { key: 'brain', label: '脑图谱', icon: <IconBrain /> },
      { key: 'pathway', label: '医学通路', icon: <IconPathway />, primary: true },
      { key: 'tags', label: '标签', icon: <IconTag /> },
      { key: 'medref', label: '医学速查', icon: <IconBook /> },
    ],
  },
  {
    title: '工具',
    icon: <IconConvert />,
    entries: [
      { key: 'import', label: '导入', icon: <IconFolderIn /> },
      { key: 'convert', label: '格式转换', icon: <IconConvert /> },
      { key: 'history', label: '历史版本', icon: <IconHistory /> },
    ],
  },
  {
    title: '系统',
    icon: <IconInfo />,
    entries: [
      { key: 'settings', label: '设置', icon: <IconInfo />, primary: true },
      { key: 'notice', label: '安全与隐私', icon: <IconInfo /> },
    ],
  },
];

/**
 * 扁平索引：按 key 取 label / icon。首页「最近使用」用它渲染，避免第二份文案与第二套分组名。
 *
 * Partial 是故意的：RailKey 是「能打开的去处」，比这张菜单表大——思维导图与 PDF 拆分
 * 已从导轨下架（仍能从命令面板和笔记工具条打开）。取用前必须判空，写死了会在
 * 首页「最近使用」里读到旧 localStorage 残留键时崩。
 */
export const RAIL_INDEX: Partial<Record<RailKey, Entry>> = Object.fromEntries(
  RAIL_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.key, entry])),
);

/** 首页没有使用记录时默认露出的去处（导轨本身不再用它过滤：五个母主题两态一致） */
export const RAIL_PRIMARY_KEYS: RailKey[] = RAIL_GROUPS.flatMap((group) =>
  group.entries.filter((entry) => entry.primary).map((entry) => entry.key),
);
