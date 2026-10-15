/**
 * 思维导图工具条：展开 / 收起（全局 UI 偏好）。
 *
 * 为什么是**全局**、而不是像 core/mindmapPrefs 那样按笔记：
 *   工具条挡不挡视线是**工作习惯**，不是某一篇笔记的呈现方式——每换一篇笔记都要重新收一次，
 *   等于没做这个功能。
 * 为什么不进整包备份：
 *   和深浅色（knowlattice-theme）、字体（knowlattice-font）同一类，属于「这台机器上的人怎么看
 *   界面」，不是笔记内容。恢复别人的备份时不该把对方的界面习惯一起带过来。
 * 存法沿用本项目的单键 localStorage：只认 '1'/'0'，认不得就当没存过（回默认=展开）；
 *   写失败静默忽略（隐私模式存不上，只影响下次打开，不影响这次会话）。
 */
export const TOOLS_OPEN_DEFAULT = true;

const KEY = 'knowlattice-mindmap-tools';

/** 读偏好：任何异常（隐私模式 / 脏值）都回默认，绝不抛错打断打开导图 */
export function loadToolsOpen(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return TOOLS_OPEN_DEFAULT;
  } catch {
    return TOOLS_OPEN_DEFAULT;
  }
}

/** 写偏好：存不上也不报错（组件 state 已经是新值，本次会话照常工作） */
export function saveToolsOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? '1' : '0');
  } catch {
    /* 隐私模式等拿不到存储：忽略 */
  }
}
