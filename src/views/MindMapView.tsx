/**
 * 思维导图：基于 Mind Elixir（MIT）—— 原生 XMind 式编辑：
 * 双击节点改字、Tab 加子级、Enter 加同级、Delete 删、拖拽调整、右键菜单、撤销/重做。
 * Markdown ↔ 思维导图树互转，保存时写回笔记（保留 frontmatter）。
 */
import { useEffect, useRef } from 'react';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';

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

function toMind(t: TNode): any {
  return { topic: t.content, id: t.id, expanded: true, children: (t.children ?? []).map(toMind) };
}
function mdToMind(md: string): any {
  const root = parseOutline(md);
  // mind-elixir: init(data) 读取 data.nodeData，且 MindElixir.new() 也返回 { nodeData } 包装
  const nodeData = { id: 'root', topic: root.content || '笔记', expanded: true, children: (root.children ?? []).map(toMind) };
  return { nodeData };
}
function mindToMd(data: any): string {
  if (!data) return '';
  const rec = (n: any): TNode => ({ id: n.id, content: `${n.topic ?? ''}`.trim(), children: (n.children ?? []).map(rec) });
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
      contextMenu: true,
      toolBar: true,
      keypress: true,
      overflowHidden: false,
      mouseSelectionButton: 0,
      theme: dark ? MindElixir.DARK_THEME : MindElixir.THEME,
    });
    const data = mdToMind(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''));
    mind.init(data).catch((e) => console.error('思维导图初始化失败：', e));
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
    const tree = (d && (d as any).nodeData) || d as any;
    const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? '';
    onSaveRef.current?.(fm + mindToMd(tree));
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
          ①点节点选中 → <b>Tab</b>=加子级（下一层）· <b>Enter</b>=加同级（再加一个分支）· <b>Delete</b>=删
          ②节点右上角「+」小工具栏 或 右键菜单也能增删
          ③空节点会随缩进成为上一级的子分支；改完点「保存并写回笔记」
        </div>
      </div>
    </div>
  );
}
