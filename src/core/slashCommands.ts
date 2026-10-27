/**
 * 编辑器里的 `/` 斜杠命令：在光标处敲 `/`，弹出一张命令表，选中就插入。
 *
 * 为什么要有：这些插入能力本来都在工具栏或右键菜单里（表格、待办、公式、双链、脚注……），
 * 但「想插入什么」时手已经在键盘上了，去右上角找按钮是从写作里被拽出来一次。
 * 斜杠命令把「我要插 X」压缩成两个键，是 Obsidian/Notion 里最不值钱也最常用的那个功能。
 *
 * 设计取舍：
 * - 只做**纯文本插入**。需要交互的动作（打开图片库、给本段加块引用 id）留给工具栏与命令面板：
 *   斜杠菜单一旦能「顺手改别处的状态」，就会出现「我按了 Esc 但它已经改了文档」这类问题。
 * - 匹配是「包含」而不是前缀：中文输入习惯里常先想内容（`表格`），前缀匹配会逼用户背英文 id。
 */
export interface SlashCommand {
  id: string;
  /** 菜单里显示的名字 */
  label: string;
  /** 右侧的灰色说明：写清楚插入的是什么，避免选错 */
  hint: string;
  /** 要插入的文本 */
  insert: string;
  /** 光标落在插入文本的第几个字符处（默认插到末尾）；用在 `[[]]`、`$$$$` 这类要往里填的地方 */
  cursorOffset?: number;
  /** 另外参与匹配的别名（英文、拼音首字母等） */
  aliases?: string[];
}

/** 今天日期，`YYYY-MM-DD` */
export function todayStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 命令表。顺序即重要度：用户按 `/` 之后第一眼看到的就是前几条。
 * 每条都必须「插完就能继续写」——不需要再回来点一次别的地方。
 */
export function slashCommands(now = new Date()): SlashCommand[] {
  return [
    {
      id: 'table',
      label: '表格 3×3',
      hint: '插入一张 3 列 3 行的空表',
      insert: '\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n',
      aliases: ['biaoge', 'table'],
    },
    {
      id: 'todo',
      label: '待办',
      hint: '插入一条待办项',
      insert: '- [ ] ',
      aliases: ['todo', 'task', 'daiban'],
    },
    {
      id: 'wiki',
      label: '双链',
      hint: '插入 [[ ]] 并把光标放进括号里',
      insert: '[[]]',
      // 光标落在两个 `[` 之后、`]]` 之前：双链的价值就在「立刻打名字」
      cursorOffset: 2,
      aliases: ['wiki', 'link', 'shuanglian'],
    },
    {
      id: 'math',
      label: '公式块',
      hint: '插入 $$ … $$ 并把光标放进中间',
      insert: '$$\n\n$$',
      cursorOffset: 3,
      aliases: ['math', 'gongshi', 'katex'],
    },
    {
      id: 'code',
      label: '代码块',
      hint: '插入 ``` 代码块',
      insert: '\n```\n\n```\n',
      cursorOffset: 5,
      aliases: ['code', 'daima'],
    },
    {
      id: 'quote',
      label: '引用',
      hint: '插入引用行（> ）',
      insert: '> ',
      aliases: ['quote', 'yinyong'],
    },
    {
      id: 'footnote',
      label: '脚注',
      hint: '插入 [^1] 引用；定义行在工具栏「[^]」里一起写',
      insert: '[^1]',
      aliases: ['footnote', 'jiaozhu'],
    },
    {
      id: 'hr',
      label: '分隔线',
      hint: '插入一条 --- 分隔线',
      insert: '\n---\n',
      aliases: ['hr', 'divider', 'fenge'],
    },
    {
      id: 'date',
      label: '今天的日期',
      hint: '插入 YYYY-MM-DD',
      insert: todayStamp(now),
      aliases: ['date', 'riqi', 'today'],
    },
  ];
}

/**
 * 匹配：空查询返回前 `limit` 条（一按 `/` 就先看到常用项）；
 * 否则按「标签前缀 → 标签包含 → 别名包含」排序，同一档内保持表内顺序。
 */
export function matchSlash(query: string, all = slashCommands(), limit = 8): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const scored: Array<{ cmd: SlashCommand; rank: number }> = [];
  for (const cmd of all) {
    const label = cmd.label.toLowerCase();
    const aliasHit = (cmd.aliases ?? []).some((a) => a.toLowerCase().includes(q));
    let rank = -1;
    if (label.startsWith(q)) rank = 0;
    else if (label.includes(q)) rank = 1;
    else if (aliasHit) rank = 2;
    if (rank >= 0) scored.push({ cmd, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((x) => x.cmd);
}

/**
 * 从「光标前的一行」里认出斜杠触发。
 *
 * 只认行首（允许前面有空格与引用/列表标记）：不然 `1/2` `见附录/A` 这种正常文字
 * 也会在打字途中突然弹菜单。
 * 返回 `from`/`to` 是 `/query` 在文档里的绝对区间——选中命令后整段替换掉。
 */
export function detectSlash(
  lineText: string,
  lineStart: number,
  caret: number
): { query: string; from: number; to: number } | null {
  const before = lineText.slice(0, Math.max(0, caret - lineStart));
  const m = /(?:^|[\s>*-])?\/([^\s/]*)$/.exec(before);
  if (!m) return null;
  // 只允许出现在「行的有效开头」附近：`正文/斜杠` 里的斜杠不算
  const slashAt = before.lastIndexOf('/');
  const prefix = before.slice(0, slashAt);
  if (prefix.replace(/[\s>*-]/g, '').length > 0) return null;
  return { query: m[1] ?? '', from: lineStart + slashAt, to: caret };
}
