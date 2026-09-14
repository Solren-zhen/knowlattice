/**
 * 思维导图：基于 Mind Elixir（MIT）—— 原生 XMind 式编辑：
 * 双击节点改字、Tab 加子级、Enter 加同级、Delete 删、拖拽调整、右键菜单、撤销/重做。
 * Markdown ↔ 思维导图树互转，保存时写回笔记（保留 frontmatter）。
 *
 * 外观与文案在这里收口：mind-elixir 默认是 Latte 主题（粉紫暖调）+ 全英文右键菜单，
 * 和本项目的极光靛蓝体系完全不搭。下面走官方的两条接口把它接进设计系统：
 *   theme  → 22 个 CSS 自定义属性；值一律写成 var(--token)，
 *            深浅色切换时由 :root 自动重解析，不必重建实例、也不丢编辑状态。
 *   locale → LangPack 12 条文案（库自带 cn，但这里要贴合笔记场景，所以自己写一份）。
 */
import { useEffect, useRef } from 'react';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import type { LangPack } from 'mind-elixir/i18n';

interface Props {
  content: string;
  title: string;
  onClose: () => void;
  /** 点击 [[双链]] 节点时回调（跳转对应笔记） */
  onOpenWiki?: (name: string) => void;
  /** 编辑完成后回调（传入写回的完整 Markdown，含 frontmatter） */
  onSaveNote?: (md: string) => void;
}

type TNode = { id: string; content: string; children: TNode[] };
let seq = 0;
const nid = () => `mn${++seq}`;

/* ---------- 文案 ---------- */

/** mind-elixir 的右键菜单文案。库自带的 cn 是通用译法（「添加子节点」等），
 *  这里改成笔记场景更好懂的说法。 */
const ZH: LangPack = {
  addChild: '加子级（Tab）',
  addParent: '加上级',
  addSibling: '加同级（Enter）',
  removeNode: '删除（Delete）',
  focus: '聚焦此分支',
  cancelFocus: '退出聚焦',
  moveUp: '上移',
  moveDown: '下移',
  link: '连线',
  linkBidirectional: '双向连线',
  clickTips: '请点击要连接的目标节点',
  summary: '概要',
};

/* ---------- 主题 ---------- */

/**
 * 主分支配色：取自应用背景极光图的同一组色相（靛蓝 → 青 → 紫 → 蓝绿），
 * 保证脑图和整体视觉同源，而不是随便挑一组鲜艳颜色。
 */
const PALETTE = ['#4f46e5', '#0891b2', '#7c3aed', '#0d9488', '#2563eb', '#c026d3', '#0ea5e9', '#a855f7'];

/**
 * 把 mind-elixir 的 22 个 CSS 变量接到本项目的设计 token 上。
 * 关键点：**全部写成 var(--token)**，不写死颜色——
 * 深色主题在 [data-theme='dark'] 里重定义了这些 token，
 * 于是切换主题时变量自动重解析，脑图即时跟随，不需要重建实例。
 */
const CSS_VARS = {
  '--node-gap-x': '26px',
  '--node-gap-y': '9px',
  '--main-gap-x': '58px',
  '--main-gap-y': '40px',
  '--root-radius': '11px',
  '--main-radius': '9px',
  '--root-color': 'var(--accent-ink)',
  '--root-bgcolor': 'var(--accent)',
  '--root-border-color': 'transparent',
  '--main-border': '1px solid var(--border)',
  '--main-color': 'var(--text)',
  '--main-bgcolor': 'var(--bg-raised)',
  '--main-bgcolor-transparent': 'var(--bg-raised)',
  '--topic-padding': '2px',
  '--color': 'var(--muted)',
  '--bgcolor': 'var(--bg)',
  '--selected': 'var(--accent-ring)',
  '--accent-color': 'var(--accent)',
  '--panel-color': 'var(--text)',
  '--panel-bgcolor': 'var(--bg-raised)',
  '--panel-border-color': 'var(--border)',
  '--map-padding': '56px 72px',
} as const;

function medvaultTheme(dark: boolean) {
  return {
    name: dark ? 'medvault-dark' : 'medvault-light',
    type: (dark ? 'dark' : 'light') as 'dark' | 'light',
    palette: PALETTE,
    cssVar: { ...CSS_VARS },
  };
}

/* ---------- Markdown ↔ 树 ---------- */

/** 自己解析 Markdown → 大纲树（标题/列表层级，保留 frontmatter 由调用方处理） */
function parseOutline(md: string): TNode {
  const root: TNode = { id: nid(), content: '', children: [] };
  let gotTitle = false;
  const listStack: Array<{ node: TNode; indent: number }> = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/g, '');
    if (!line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = m[1].length;
      const node: TNode = { id: nid(), content: m[2].trim(), children: [] };
      if (level === 1 && !gotTitle) { root.content = m[2].trim(); gotTitle = true; listStack.length = 0; }
      else { root.children.push(node); listStack.length = 0; listStack.push({ node, indent: -1 }); }
    } else if ((m = /^(\s*)[-*+][\t ]+(.*)$/.exec(line))) {
      const indent = m[1].replace(/\t/g, '  ').length;
      const node: TNode = { id: nid(), content: m[2].trim(), children: [] };
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
      const parent = listStack.length ? listStack[listStack.length - 1].node : root;
      parent.children.push(node);
      listStack.push({ node, indent });
    }
  }
  return root;
}

/** 树 → 序列化回 Markdown */
function treeToMd(root: TNode): string {
  let s = `# ${root.content.trim()}\n`;
  const walk = (children: TNode[], depth: number) => {
    for (const c of children) { s += `${'  '.repeat(depth)}- ${c.content}\n`; walk(c.children, depth + 1); }
  };
  walk(root.children, 0);
  return s;
}

function toMind(t: TNode): unknown {
  return { topic: t.content, id: t.id, expanded: true, children: (t.children ?? []).map(toMind) };
}
function mdToMind(md: string): { nodeData: unknown } {
  const root = parseOutline(md);
  // mind-elixir: init(data) 读取 data.nodeData，且 MindElixir.new() 也返回 { nodeData } 包装
  const nodeData = { id: 'root', topic: root.content || '笔记', expanded: true, children: (root.children ?? []).map(toMind) };
  return { nodeData };
}
function mindToMd(data: { topic?: string; children?: unknown[] }): string {
  if (!data) return '';
  const rec = (n: { id?: string; topic?: string; children?: unknown[] }): TNode => ({
    id: n.id ?? nid(),
    content: `${n.topic ?? ''}`.trim(),
    children: ((n.children ?? []) as Array<{ id?: string; topic?: string; children?: unknown[] }>).map(rec),
  });
  return treeToMd(rec(data));
}

export default function MindMapView({ content, title, onClose, onOpenWiki, onSaveNote }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixir | null>(null);
  const onSaveRef = useRef(onSaveNote);
  const onOpenWikiRef = useRef(onOpenWiki);
  useEffect(() => { onSaveRef.current = onSaveNote; }, [onSaveNote]);
  useEffect(() => { onOpenWikiRef.current = onOpenWiki; }, [onOpenWiki]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = '';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const mind = new MindElixir({
      el,
      direction: MindElixir.SIDE,
      // 右键菜单：开聚焦/连线，并用上面的中文文案
      contextMenu: { focus: true, link: true, locale: ZH },
      toolBar: true,
      keypress: true,
      overflowHidden: false,
      mouseSelectionButton: 0,
      theme: medvaultTheme(dark),
    });
    const data = mdToMind(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''));
    mind.init(data as never).catch((e: unknown) => console.error('思维导图初始化失败：', e));
    mindRef.current = mind;
    return () => { mind.destroy(); mindRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // 点击 [[双链]] 节点 → 打开对应笔记（捕获阶段拦截，避免干扰 mind-elixir 的编辑选中）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // mind-elixir 节点元素是 .me-main，双链文本在 .me-tpc（内层 .text）
      const nodeEl = t?.closest?.('.me-main') as HTMLElement | null;
      if (!nodeEl) return;
      const label = (nodeEl.querySelector('.me-tpc')?.textContent || nodeEl.textContent || '').trim();
      const m = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(label);
      if (m) {
        onOpenWikiRef.current?.((m[2] ?? m[1]).trim());
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el.addEventListener('click', h, true);
    return () => el.removeEventListener('click', h, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const save = () => {
    const d = mindRef.current?.getData();
    const tree = (d && (d as { nodeData?: unknown }).nodeData) || d;
    const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? '';
    onSaveRef.current?.(fm + mindToMd(tree as { topic?: string; children?: unknown[] }));
  };

  return (
    <div className="panel panel--full mindmap-overlay">
      <div className="mindmap-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mindmap-header">
          <span className="panel__title mindmap-title">思维导图 · {title}</span>
          <div className="mindmap-actions">
            <button className="btn-small" onClick={save}>保存并写回笔记</button>
            <button className="btn-icon" onClick={onClose} aria-label="关闭">✕</button>
          </div>
        </div>
        <div className="panel__body mindmap-body">
          <div ref={containerRef} className="mindmap-elixir" />
        </div>
        <div className="mindmap-hint muted">
          <span><b>Tab</b> 加子级</span>
          <span><b>Enter</b> 加同级</span>
          <span><b>Delete</b> 删除</span>
          <span><b>双击</b> 改字</span>
          <span><b>右键</b> 更多操作</span>
          <span className="mindmap-hint__tip">改完点「保存并写回笔记」</span>
        </div>
      </div>
    </div>
  );
}
