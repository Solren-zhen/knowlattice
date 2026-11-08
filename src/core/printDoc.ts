/**
 * 打印 / 存 PDF：把一篇笔记（或一份题目导出的 markdown）渲染成可打印页面。
 *
 * 为什么不用 `window.print()` 直接打当前窗口：应用是深色主题 + 面板布局，
 * 打印出来会带上侧栏、工具栏、暗底白字，页面上一堆按钮也没法去掉。
 * 所以另开一个隐藏 iframe，只塞「内容 + 一份打印样式」，走系统打印对话框
 * （在对话框里选「另存为 PDF」就是导出 PDF，不必再引一个 pdf 生成库）。
 *
 * 用 iframe 而不是 window.open：弹窗会被拦截，且会把当前编辑状态留在另一个窗口里。
 */
import { renderMarkdown } from './markdown';
import { escapeHtml } from './htmlEscape';

export { escapeHtml };

/** 打印样式：白底黑字、A4 页边距、图片不溢出、标题不孤儿、表格有边框 */
const PRINT_CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  html, body { background: #fff; color: #111; }
  body {
    margin: 0; font-family: "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif;
    font-size: 11.5pt; line-height: 1.75;
  }
  h1, h2, h3, h4 { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.35; margin: 1.1em 0 .5em; }
  h1 { font-size: 20pt; }
  h2 { font-size: 16pt; }
  h3 { font-size: 13.5pt; }
  p, li { orphans: 3; widows: 3; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; }
  table { border-collapse: collapse; width: 100%; page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  pre { background: #f6f6f6; border: 1px solid #ddd; padding: 8px 10px; overflow: auto; page-break-inside: avoid; }
  code { font-family: Consolas, "Courier New", monospace; font-size: .92em; }
  blockquote { margin: .8em 0; padding: .2em 0 .2em 12px; border-left: 3px solid #bbb; color: #333; }
  .print-head { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid #ccc; padding-bottom: 6px; margin-bottom: 14px; }
  .print-head b { font-size: 13pt; }
  .print-head span { color: #666; font-size: 9pt; }
  .print-foot { margin-top: 18px; border-top: 1px solid #ddd; padding-top: 6px; color: #888; font-size: 9pt; }
  @media print { a { color: inherit; text-decoration: none; } }
`;

export interface PrintableDoc {
  title: string;
  /** 正文 HTML（通常来自 renderMarkdown） */
  bodyHtml: string;
  /** 页眉右侧的小字，例如「张三 · 2026-10-23」；不用时留空 */
  meta?: string;
}

/** 拼一份完整的、可打印的 HTML 文档 */
export function printableHtml(doc: PrintableDoc): string {
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>${escapeHtml(doc.title)}</title>
<style>${PRINT_CSS}</style></head>
<body>
<div class="print-head"><b>${escapeHtml(doc.title)}</b><span>${escapeHtml(doc.meta ?? '')}</span></div>
<article>${doc.bodyHtml}</article>
<div class="print-foot">${escapeHtml(stamp)} · 晶格笔记</div>
</body></html>`;
}

/**
 * 把渲染后的 HTML 里的 `<img src>` 换成可解析的地址。
 *
 * 附件在 markdown 里写的是 `_attachments/x.png` 这种 vault 相对路径，
 * 打印用的 iframe 是 about:blank，相对路径没有基址 → 图全变裂图。
 * 所以逐个交给调用方的 resolve 换成 blob: 或 data: 地址；解析不出来的原样保留
 * （宁可裂一张，也不要静默删掉用户的内容）。
 */
export function rewriteImageSrc(html: string, resolve: (src: string) => string | undefined): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (all, head: string, src: string, tail: string) => {
    if (/^(https?:|data:|blob:)/i.test(src)) return all;
    const next = resolve(decodeURI(src)) ?? resolve(src);
    return next ? `${head}${next}${tail}` : all;
  });
}

/** 在隐藏 iframe 里打印；返回 false 表示环境不支持（例如测试环境没有 print） */
export function printHtml(html: string): boolean {
  if (typeof document === 'undefined') return false;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', '打印预览');
  // 尺寸为 0 的 iframe 在某些浏览器里不渲染内容 → 打印出来是空白页。
  // 放到屏幕外、给 1px 尺寸更稳；用户看不到，也不占布局。
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;';
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    return false;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => {
    // 等打印对话框关闭再移除：Safari 在 print() 后立刻移除 iframe 会取消打印
    setTimeout(() => frame.remove(), 1500);
  };
  try {
    win.focus();
    win.print();
  } catch {
    frame.remove();
    return false;
  }
  cleanup();
  return true;
}

/**
 * markdown → 可打印页面。`resolveImage` 用来把附件相对路径换成能显示的地址。
 * 注意：这条路径不走 Preview 组件的双链/脚注高亮，打印要的是「干净的文章」。
 */
export async function printMarkdown(
  title: string,
  markdown: string,
  opts: { meta?: string; resolveImage?: (src: string) => string | undefined } = {}
): Promise<boolean> {
  const rendered = await renderMarkdown(markdown);
  const body = opts.resolveImage ? rewriteImageSrc(rendered, opts.resolveImage) : rendered;
  return printHtml(printableHtml({ title, bodyHtml: body, meta: opts.meta }));
}
