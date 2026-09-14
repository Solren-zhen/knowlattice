/**
 * markdown-it 懒加载渲染：首屏入口包不含 markdown-it，
 * 第一次渲染笔记预览时才下载对应 chunk（实例全局缓存）。
 * 注意：类型一律走 `typeof import(...)`，静态 import 会把 markdown-it 重新拖回主包。
 * 安全策略与原 Preview 一致：html:false，用户笔记里的原始 HTML 按纯文本显示。
 */

type MdInstance = InstanceType<(typeof import('markdown-it'))['default']>;

let mdPromise: Promise<MdInstance> | null = null;

function getMd(): Promise<MdInstance> {
  mdPromise ??= import('markdown-it').then((m) => new m.default({ html: false, linkify: true, breaks: true }));
  return mdPromise;
}

export async function renderMarkdown(src: string): Promise<string> {
  return (await getMd()).render(src);
}
