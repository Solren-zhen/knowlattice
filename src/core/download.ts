/**
 * 浏览器式文本下载：Blob + createObjectURL + `<a download>`。
 *
 * 为什么单独一个模块：这个函数原本写在 `core/anki` 里，但 anki 静态引了 sql.js
 * （约 1MB）。单词工坊只需要下载一段 Markdown，若从 anki 转出，会把 sql.js
 * 一起拖进它的懒加载 chunk。放在这里后两边共用同一份实现，不再各写一遍。
 */
export function downloadTextFile(
  name: string,
  content: string,
  type = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
