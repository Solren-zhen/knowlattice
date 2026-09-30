/** 清理 PDF 文本层选区中的排版空白，不改动英文单词之间的必要空格。 */
const CJK_RE = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';

export function normalizePdfSelection(value: string): string {
  return value
    .replace(/\u00ad/g, '')
    // 零宽不换行符(BOM)是纯产物直接删；零宽空格是词边界信号，与全角空格、
    // 各类排版空格一并折算成普通空格——中文 PDF 的缩进/对齐大量使用它们，
    // 是「复制出来一堆空格」的主要来源
    .replace(/\ufeff/g, '')
    .replace(/[\u3000\u2000-\u200b\u202f\u205f\u1680]/g, ' ')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/([A-Za-z])-[ \t]*\n[ \t]*([a-z])/g, '$1$2')
    .replace(/\n{2,}/g, '\u0001')
    .replace(/[\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(new RegExp(`(${CJK_RE}) +(?=${CJK_RE})`, 'g'), '$1')
    .replace(new RegExp(` +(?=${CJK_RE})`, 'g'), '')
    .replace(new RegExp(`(${CJK_RE}) +(?=[A-Za-z0-9])`, 'g'), '$1')
    .replace(/ +([，。；：！？、）》〉」』”’,.!?;:)\]])/g, '$1')
    .replace(/([，。；：！？、）》〉」』”’,.!?;:)\]]) +(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g, '$1')
    .replace(/([（《〈「『“‘[(]) +/g, '$1')
    .replace(/\u0001/g, '\n\n')
    .trim();
}
