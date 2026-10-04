/**
 * 页码锚点：教材导入（PDF 文本层 / OCR）时按页写入的行内标记 `<!--kb:P182-->`，
 * 让「这段文字来自第几页」成为可检索、可核验的坐标，而不是只在摘录时手写一句来源。
 *
 * 存储保留标记，展示与检索前用 stripPageAnchors 剥掉：
 * 本库两套渲染器都是 html:false，注释不会被当 HTML 吃掉，会原样显示成文字，
 * 所以渲染入口必须先剥离。锚点独占一行，剥离后不留残字。
 */

/** 生成一页的锚点标记 */
export const pageAnchor = (page: number): string => `<!--kb:P${page}-->`;

/** 独占一行的锚点（切分段落时按「页标记」跳过） */
export const PAGE_ANCHOR_LINE_RE = /^[ \t]*<!--\s*kb:P\d+\s*-->[ \t]*$/;

/** 整行锚点（含换行）或残留的行内锚点一并剥掉 */
export function stripPageAnchors(src: string): string {
  return src
    .replace(/^[ \t]*<!--\s*kb:P\d+\s*-->[ \t]*\r?\n/gm, '')
    .replace(/<!--\s*kb:P\d+\s*-->/g, '');
}

export interface PageAnchorHit {
  /** 印刷/物理页码 */
  page: number;
  /** 标记在原文中的字符下标 */
  index: number;
}

/** 按出现顺序取出全部页码锚点 */
export function pageAnchors(src: string): PageAnchorHit[] {
  const out: PageAnchorHit[] = [];
  const re = /<!--\s*kb:P(\d+)\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ page: Number(m[1]), index: m.index });
  return out;
}

/** 是否含页码锚点 */
export function hasPageAnchors(src: string): boolean {
  return /<!--\s*kb:P\d+\s*-->/.test(src);
}
