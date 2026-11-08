/** HTML 文本/属性转义：拼字符串生成 HTML 的地方（打印页、图片 alt、链接）共用。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
