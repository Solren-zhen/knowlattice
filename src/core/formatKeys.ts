/**
 * 四个格式命令的键位定义——唯一来源。
 *
 * 工具栏提示、右键菜单、内置使用说明、编辑器快捷键四处都写着同一组键，各写一遍必然漂移
 * （改了绑定、提示还写着旧键），所以集中在这里，换键只改这一处。
 *
 * 为什么单独一个文件（而不是留在 mdFormat.ts 里）：mdFormat 带着 toggleMark / wikiLink 的
 * 成对标记查找逻辑，它只被懒加载的编辑器分块引用；而首页（Preview）在入口包里，只为读这张
 * 键位表就得把整个 mdFormat 拖进首屏。键位表是叶子数据、没有依赖，放这里两边都干净。
 *
 * 为什么是 Alt + A/S/Z/X：四个键都落在左手基准位（A/S 就是基准键，Z/X 在正下方一行），
 * 拇指按住左 Alt、其余手指原地按，一只手完成，不必像 UIOP 那样跨到键盘右边。
 *
 * 为什么不是别的组合（逐个在 Chrome 里查过官方快捷键表）：
 * - Ctrl+A / S / F 是全选 / 保存 / 查找，占用它们会毁掉更常用的操作；
 * - Alt+D 是浏览器地址栏、Alt+F 是 Chrome 菜单，这类浏览器级快捷键网页拦不住；
 * - Ctrl+数字 是切换标签页，同样拦不住，故数字键只能配 Alt；
 * - macOS 上 Option+字母打出的是特殊字符（å / ß / Ω / ≈），故 mac 走 ⌘+⌥。
 */
export interface FormatKey {
  /** CodeMirror 键名（Windows / Linux） */
  cm: string;
  /** CodeMirror 键名（macOS） */
  cmMac: string;
  /** 界面展示：右键菜单这类窄处 */
  label: string;
  /** 界面展示：提示语，带上 mac 写法 */
  labelMac: string;
}

export const FORMAT_KEYS: Record<'bold' | 'highlight' | 'italic' | 'wiki', FormatKey> = {
  bold: { cm: 'Alt-a', cmMac: 'Mod-Alt-a', label: 'Alt+A', labelMac: 'Alt/⌥+A' },
  highlight: { cm: 'Alt-s', cmMac: 'Mod-Alt-s', label: 'Alt+S', labelMac: 'Alt/⌥+S' },
  italic: { cm: 'Alt-z', cmMac: 'Mod-Alt-z', label: 'Alt+Z', labelMac: 'Alt/⌥+Z' },
  wiki: { cm: 'Alt-x', cmMac: 'Mod-Alt-x', label: 'Alt+X', labelMac: 'Alt/⌥+X' },
};
