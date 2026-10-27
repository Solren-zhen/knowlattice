/**
 * 命令面板的注册表与匹配（纯函数，零依赖）。
 *
 * 为什么不把命令写死在面板里：命令的**所有者**是 Workspace（视图开关、保存、导出都在它的作用域里），
 * 面板只负责渲染与键盘。匹配逻辑留在这里，单测才好覆盖——中文命令的匹配规则一旦写错
 * （比如按子串匹配「题」把「导出题库」排到「题库练习」前面），面板就退化成「翻列表」。
 */
export interface CommandDef {
  id: string;
  /** 主标题：用户在面板里看到并搜索的那一行 */
  title: string;
  /** 分组，仅用于右侧提示（视图 / 笔记 / 题库 / 工具） */
  group?: string;
  /** 别名：口语说法、英文、旧名字都能搜到（不进 UI） */
  aliases?: string[];
}

/**
 * 匹配规则：
 * - 空查询 → 按注册顺序取前 limit 条（注册顺序就是重要性顺序，不另排）
 * - 空格分词，**每个词都必须命中**标题/别名/分组里的某一处（AND 语义，避免「导出 题」把全部题库命令翻出来）
 * - 首词命中标题开头者优先：敲「题」时想要「题库练习」，不想先看到「导出题库备份」
 */
export function matchCommands<T extends CommandDef>(all: readonly T[], query: string, limit = 12): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ c: T; rank: number }> = [];
  for (const c of all) {
    const hay = `${c.title} ${(c.aliases ?? []).join(' ')} ${c.group ?? ''}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    scored.push({ c, rank: c.title.toLowerCase().startsWith(tokens[0]) ? 0 : 1 });
  }
  // sort 是稳定的：同一档内保持注册顺序，不因输入变化而乱跳
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.c);
}
