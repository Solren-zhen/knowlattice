/**
 * 实时预览（M1+M3）：
 * - 「属性: 内容」键值对属性名自动加粗（EasyTyping 思路）
 * - [[双链]] 可点击跳转；未创建的链接显示为灰色占位
 *
 * 安全策略：markdown-it 关闭 html 选项，用户笔记里的原始 HTML 一律按纯文本显示；
 * 属性键加粗与 wikilink 通过「占位标记 → 渲染后替换」实现，点击走事件委托，
 * 不再注入内联 onclick 和 window 全局函数。
 */
import { useEffect, useState } from 'react';
import { renderMarkdown } from '../core/markdown';
import { FORMAT_KEYS } from '../core/formatKeys';
import { IconFile, IconLink, IconSave, IconSearch } from './icons';

/** markdown-it 实例已移至 core/markdown.ts 懒加载（首屏入口包不含它） */

/** 四个行内格式键的展示文案，从 FORMAT_KEYS 推出来——键位只此一处定义，
 *  改键不会再漏改首页提示（mdFormat 的注释把「内置使用说明」也算在四处同源之内）。
 *  label 形如 'Alt+A'，取 '+' 后半段拼成 'A S Z X'。 */
const FORMAT_HINT = `Alt/⌥ + ${(['bold', 'highlight', 'italic', 'wiki'] as const)
  .map((k) => FORMAT_KEYS[k].label.split('+')[1])
  .join(' ')}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 预处理：属性键占位 + wikilink 内部协议 + 图片路径解析 */
function transformSegment(src: string): string {
  // 1. 属性键："- 定义: xxx" → "- %%定义%%: xxx"（渲染后替换为带样式的 <strong>）
  const out = src.replace(/^(\s*-\s*)([^:\n\s][^:\n]{0,11}?)(\s*):(\s|$)/gm, (m, indent, key, space, tail) => {
    if (/[[\]]/.test(key)) return m;
    return `${indent}%%${key}%%${space}:${tail}`;
  });

  // 2. [[目标]] 或 [[目标|别名]] → 内部协议链接（渲染后统一替换成可点击锚点）
  return out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    const label = (alias ?? t).trim();
    return `[${label}](mv-wikilink://${encodeURIComponent(t)})`;
  });
}

/** 预处理入口：围栏代码块与行内代码原样保留，其余段落做属性键/双链替换，
 *  避免代码里的 [[x]] 被改成链接语法后以原文形式显示。 */
function preprocess(src: string): string {
  return src
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : transformSegment(seg)))
    .join('');
}

/** 后处理：占位标记 → 真实 HTML。code 块内的内容不做替换 */
function postprocess(
  html: string,
  resolve: (name: string) => string | null
): string {
  return html
    .split(/(<code[\s\S]*?<\/code>)/g)
    .map((seg) => {
      if (seg.startsWith('<code')) return seg;
      return seg
        // 属性键加粗（markdown-it 已对文本做过转义，这里可安全包一层标签）
        .replace(/%%(.{1,24}?)%%/g, (_m, key: string) => `<strong class="prop-key">${key}</strong>`)
        // wikilink 锚点
        .replace(/href="mv-wikilink:\/\/([^"]*)"/g, (_m, enc: string) => {
          let t = enc;
          try { t = decodeURIComponent(enc); } catch { /* 保持原样 */ }
          const cls = resolve(t) !== null ? 'wikilink' : 'wikilink missing';
          return `href="javascript:void(0)" class="${cls}" data-mv-target="${escapeHtml(t)}"`;
        });
    })
    .join('');
}

interface Props {
  content: string | null;
  /** 解析链接名 → vault 路径（null 表示未创建） */
  resolve?: (name: string) => string | null;
  onOpenLink?: (name: string) => void;
  /** vault 相对路径 → 文件内容，用于图片渲染 */
  readFile?: (path: string) => string | undefined;
  /** 空状态 Hero 主 CTA */
  onSearch?: () => void;
  onGraph?: () => void;
}

export default function Preview({ content, resolve, onOpenLink, readFile, onSearch, onGraph }: Props) {
  // markdown-it 懒加载 → 异步渲染。保持上一份 html 直到新结果就绪（alive 守卫防竞态），
  // 避免切笔记时闪空白；content 为 null 时走 placeholder 分支，不消费 html
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (!content) return;
    let alive = true;
    // 剥离 frontmatter，元数据不进入正文渲染
    const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    let src = preprocess(stripped);
    // 图片：![](vault路径) → 用 vault 内容(dataURL)替换 src
    src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt: string, path: string) => {
      const data = readFile?.(path.trim());
      if (!data) return m;
      return `![${alt}](${data})`;
    });
    void renderMarkdown(src).then((raw) => {
      if (alive) setHtml(postprocess(raw, resolve ?? (() => null)));
    });
    return () => { alive = false; };
  }, [content, resolve, readFile]);

  // 事件委托：点击 wikilink 锚点 → onOpenLink(目标名)
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onOpenLink) return;
    const anchor = (e.target as HTMLElement).closest?.('a[data-mv-target]');
    if (anchor) {
      e.preventDefault();
      onOpenLink(anchor.getAttribute('data-mv-target') ?? '');
    }
  };

  if (content === null) {
    // 首页文案纪律：一行只说一件事，每条 ≤ 10 个字（断言在 previewHero.dom.test.tsx，
    // 长度按词计数、忽略分隔符）。原来最长的两条各 40+ 字，在两列网格里被撑成三行、
    // 右边缘参差，首屏被拉长。设计理由（为什么这四个键要挤在左手）属于 README，不属于首屏。
    return (
      <div className="preview placeholder">
        <div className="hero-badge">晶格 · KnowLattice</div>
        <h1 className="hero-title">你的知识库，从这里开始</h1>
        <p className="hero-sub">笔记沉淀知识 · 层级梳理思路 · 双链串联全局</p>
        <div className="hero-proof" aria-label="KnowLattice 特性">
          <span><IconSave /> 本地优先</span>
          <span><IconFile /> Markdown 存储</span>
          <span><IconLink /> 全库互联</span>
        </div>
        <div className="hero-cta">
          <button className="btn-primary hero-primary" onClick={onSearch}>
            <IconSearch /> 快速搜索 <kbd>Ctrl K</kbd>
          </button>
          <button className="btn hero-graph" onClick={onGraph}>知识图谱</button>
        </div>
        <div className="teach-steps">
          <div className="teach-step"><kbd>回车</kbd><span>续写下一条</span></div>
          <div className="teach-step"><kbd>Tab</kbd><span>缩进成子要点</span></div>
          <div className="teach-step"><kbd>[[</kbd><span>链接到其他笔记</span></div>
          <div className="teach-step wide format-hint"><kbd>{FORMAT_HINT}</kbd><span>加粗 / 高亮 / 斜体 / 双链</span></div>
          {/* 第 5 条跨两列：5 个格子在 2 列网格里必然剩一个孤儿格，索性让它整行 */}
          <div className="teach-step wide"><kbd>右键</kbd><span>打开 / 删除整篇笔记</span></div>
        </div>
        <p className="muted shortcut-hint">
          <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存 · <kbd>Alt</kbd>+<kbd>←→</kbd> 后退前进
        </p>
      </div>
    );
  }
  return (
    <div className="preview markdown-body" onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
