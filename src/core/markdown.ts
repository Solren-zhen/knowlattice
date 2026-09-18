/**
 * markdown-it 懒加载渲染：首屏入口包不含 markdown-it，
 * 第一次渲染笔记预览时才下载对应 chunk（实例全局缓存）。
 * 注意：类型一律走 `typeof import(...)`，静态 import 会把 markdown-it 重新拖回主包。
 * 安全策略与原 Preview 一致：html:false，用户笔记里的原始 HTML 按纯文本显示。
 *
 * 数学公式（KaTeX）：**只有真正出现公式的文档才付这份代价**。
 * katex.min.css 24 kB，另带 60 个数学字体合计约 1 MB——绝不能进首屏，
 * 也不该让每篇不含公式的笔记都去下载数学字体。
 */

import { isPathwayLang, renderPathwaySvg } from './pathway';

type MdInstance = InstanceType<(typeof import('markdown-it'))['default']>;

let plainPromise: Promise<MdInstance> | null = null;
let mathPromise: Promise<MdInstance> | null = null;

/**
 * 粗判是否含数学公式语法。宁可多判一点也不能漏——漏判的后果是公式按纯文本显示。
 * 支持 $$...$$、\(...\)、\[...\] 与行内 $...$（排除 \$ 转义）。
 */
export function hasMathSyntax(src: string): boolean {
  return (
    /\$\$[\s\S]+?\$\$/.test(src) ||
    /\\\([\s\S]+?\\\)/.test(src) ||
    /\\\[[\s\S]+?\\\]/.test(src) ||
    /(^|[^\\$])\$[^$\n]+\$/.test(src)
  );
}

async function build(withMath: boolean): Promise<MdInstance> {
  const m = await import('markdown-it');
  const md = new m.default({ html: false, linkify: true, breaks: true });
  if (withMath) {
    const [pluginMod] = await Promise.all([
      import('@vscode/markdown-it-katex'),
      // 动态 import CSS：Vite 会把它拆成独立 chunk，命中公式时才注入
      import('katex/dist/katex.min.css'),
    ]);
    // CJS 互操作：类型声明里 default 直接是函数，Vite 运行时却包了一层 { default: fn }
    const wrapper = pluginMod as unknown as { default?: unknown };
    const inner = wrapper.default as { default?: unknown } | undefined;
    const plugin = inner?.default ?? wrapper.default;
    md.use(plugin as never);
  }
  const fenceRule = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const info = (tokens[idx].info || '').trim().split(/\s+/)[0];
    if (isPathwayLang(info)) return renderPathwaySvg(tokens[idx].content);
    return fenceRule
      ? fenceRule(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
  return md;
}

function instance(withMath: boolean): Promise<MdInstance> {
  if (withMath) return (mathPromise ??= build(true));
  return (plainPromise ??= build(false));
}

export async function renderMarkdown(src: string): Promise<string> {
  return (await instance(hasMathSyntax(src))).render(src);
}
