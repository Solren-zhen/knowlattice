/**
 * 知识图谱：全库笔记为节点、已解析 [[双链]] 为边的力导向网络。
 * 基于 force-graph（MIT）：内建 d3-force 物理引擎 + 拖拽/缩放/平移/点击回调，稳定且省维护。
 * 节点颜色 = 一级章节；节点大小 = 连接度；单击打开笔记。
 *
 * 观感打磨（小图场景）：
 *  - 悬停高亮邻域：相关节点与连线保持点亮，其余淡出——看关系一目了然；
 *  - 连线微弧度 + 柔和透明度，避免“接线板”感；
 *  - 节点数 ≤ 200 时在节点下方常显标签（大图自动退回悬停提示）；
 *  - 少节点时加大斥力，让布局舒展不拥挤。
 * 错题热力：收录进错题本的节点向危险红渐变 + 放大（可开关）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph from 'force-graph';
import { parseFrontmatter } from '../core/parser';
import { loadMistakes } from '../core/mistakes';
import type { LinkIndex } from '../core/linkIndex';

const PALETTE = ['#0e76f7', '#3a6ea8', '#b26a2e', '#7c3aed', '#b23a2e', '#0e7490', '#8a8478', '#3b82f6', '#a8577e', '#5a67d8'];
const TAG_COLOR = '#d97706';
const DANGER = '#ff5f57';
/** 标签节点：至少出现的笔记数 & 最多展示的标签数（防大库爆炸） */
const TAG_MIN_NOTES = 3;
const TAG_MAX_NODES = 80;
/** 小图阈值：节点数在该值以下时加大斥力让布局舒展 */
const SMALL_LIMIT = 200;

/** 混色：把 heat 覆盖到章节色上（越靠近危险红 = 越弱） */
function hexRGB(h: string): number[] {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function blend(a: string, b: string, t: number): string {
  const pa = hexRGB(a), pb = hexRGB(b);
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

interface Props {
  docs: Map<string, string>;
  linkIndex: LinkIndex;
  resolveLink: (name: string) => string | null;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

interface GNode { id: string; path: string; label: string; color: string; deg: number; isTag: boolean; chapter: string; heat: number }
interface GLink { source: string; target: string }

type FG = any;

export default function GraphView({ docs, linkIndex, resolveLink, onOpenPath, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<FG | null>(null);
  const [showTags, setShowTags] = useState(true);
  const [showHeat, setShowHeat] = useState(true);
  const showHeatRef = useRef(showHeat);
  useEffect(() => { showHeatRef.current = showHeat; }, [showHeat]);
  /** 悬停高亮：相关节点/边集合（空 = 无悬停，全图正常亮度） */
  const hlRef = useRef<{ nodes: Set<unknown>; links: Set<unknown> }>({ nodes: new Set(), links: new Set() });

  // 回调经 ref 转发：Workspace 的回调每次渲染都是新引用，
  // 若直接放进初始化 effect 依赖，任何无关重渲染都会把整个力导向图销毁重建
  const openRef = useRef(onOpenPath);
  const closeRef = useRef(onClose);
  useEffect(() => { openRef.current = onOpenPath; }, [onOpenPath]);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  // ---------- 图数据：节点 + 去重边 + 章节图例 + 错题热力 ----------
  const graph = useMemo(() => {
    const paths = [...docs.keys()].filter((p) => p.endsWith('.md'));
    const mistakes = loadMistakes();
    const maxMistake = Math.max(1, ...Object.values(mistakes).map((m) => m.count));
    const idx = new Map<string, number>();
    const chapterColor = new Map<string, string>();
    const nodes: GNode[] = paths.map((p, i) => {
      idx.set(p, i); // 用 map 索引，避免初始化中引用 nodes 触 TDZ
      const { title, meta } = parseFrontmatter(docs.get(p) ?? '');
      const chapter = (meta.chapter || '未分类').split('/')[0];
      if (!chapterColor.has(chapter)) chapterColor.set(chapter, PALETTE[chapterColor.size % PALETTE.length]);
      const mk = mistakes[p];
      const heat = mk ? Math.min(1, mk.count / maxMistake) : 0;
      return {
        id: p,
        path: p,
        label: title || p.replace(/\.md$/, '').split('/').pop()!,
        color: chapterColor.get(chapter)!,
        deg: 0,
        isTag: false,
        chapter,
        heat,
      };
    });
    const seen = new Set<string>();
    const links: GLink[] = [];
    for (const p of paths) {
      for (const t of linkIndex.outgoing.get(p) ?? []) {
        const target = resolveLink(t);
        if (!target || target === p || !idx.has(target)) continue;
        const key = p < target ? `${p}|${target}` : `${target}|${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: p, target });
        nodes[idx.get(p)!].deg++;
        nodes[idx.get(target)!].deg++;
      }
    }

    // ---------- 标签节点：#标签 聚合 ----------
    if (showTags) {
      const tagNotes = new Map<string, string[]>();
      for (const p of paths) {
        const { meta } = parseFrontmatter(docs.get(p) ?? '');
        for (const t of meta.tags) {
          if (!tagNotes.has(t)) tagNotes.set(t, []);
          tagNotes.get(t)!.push(p);
        }
      }
      const tags = [...tagNotes.entries()]
        .filter(([, ps]) => ps.length >= TAG_MIN_NOTES)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, TAG_MAX_NODES);
      for (const [tag, ps] of tags) {
        const id = `tag:${tag}`;
        nodes.push({ id, path: id, label: `#${tag} · ${ps.length} 篇`, color: TAG_COLOR, deg: 0, isTag: true, chapter: '#标签', heat: 0 });
        const ni = nodes.length - 1;
        for (const p of ps) {
          links.push({ source: p, target: id });
          nodes[ni].deg++;
          const pi = idx.get(p);
          if (pi !== undefined) nodes[pi].deg++;
        }
      }
    }

    const legend = [...chapterColor.entries()]
      .map(([name, color]) => ({ name, color, count: nodes.filter((n) => n.chapter === name && !n.isTag).length }))
      .sort((a, b) => b.count - a.count);
    const hasHeat = nodes.some((n) => n.heat > 0);
    return { nodes, links, legend, hasHeat };
  }, [docs, linkIndex, resolveLink, showTags]);

  // 初始化后：Esc 快捷退出
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---------- 初始化 force-graph ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const small = graph.nodes.length <= SMALL_LIMIT; // 小图：更舒展的斥力
    const dark = () => document.documentElement.getAttribute('data-theme') === 'dark';

    const fg = (ForceGraph as any)()(el)
      .width(el.clientWidth)
      .height(el.clientHeight)
      .graphData(graph)
      .nodeId('id')
      .nodeLabel((n: GNode) => {
        const c = dark() ? '#e7edf6' : '#1c1f23';
        const esc = n.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const heat = showHeatRef.current && n.heat > 0 ? `<span style="color:${DANGER}"> · 错 ${Math.round(n.heat * 100)} 弱</span>` : '';
        return `<span style="color:${c};display:inline-block">${esc}${heat}</span>`;
      })
      .nodeColor((n: GNode) => {
        const hl = hlRef.current;
        const dimmed = hl.nodes.size > 0 && !hl.nodes.has(n);
        const base = showHeatRef.current && n.heat > 0 ? blend(n.color, DANGER, 0.7 * n.heat) : n.color;
        return dimmed ? (dark() ? 'rgba(140, 150, 168, 0.18)' : 'rgba(120, 125, 140, 0.15)') : base;
      })
      .nodeVal((n: GNode) => {
        const base = n.isTag ? 1.5 + Math.sqrt(n.deg * 2) : 1 + Math.sqrt(n.deg * 3);
        return base * (1 + (showHeatRef.current ? n.heat * 0.7 : 0)); // 错题放大
      })
      .nodeRelSize(5)
      .linkColor((l: GLink) => {
        const hl = hlRef.current;
        if (hl.nodes.size > 0) {
          if (hl.links.has(l)) return dark() ? 'rgba(167, 139, 250, 0.75)' : 'rgba(108, 92, 231, 0.7)';
          return dark() ? 'rgba(140, 150, 168, 0.08)' : 'rgba(120, 125, 140, 0.07)';
        }
        return dark() ? 'rgba(150, 160, 180, 0.22)' : 'rgba(120, 130, 150, 0.25)';
      })
      .linkWidth((l: GLink) => (hlRef.current.links.has(l) ? 2 : 1))
      .linkCurvature(0.08)
      .cooldownTicks(350)
      .onNodeHover((n: GNode | null) => {
        el.style.cursor = n && !n.isTag ? 'pointer' : n ? 'default' : 'grab';
        // 悬停高亮邻域：本节点 + 直接相连的节点与边，其余淡出
        const hl = hlRef.current;
        hl.nodes.clear();
        hl.links.clear();
        if (n) {
          hl.nodes.add(n);
          for (const nb of (n as any).neighbors ?? []) hl.nodes.add(nb);
          for (const l of fgRef.current?.graphData()?.links ?? []) {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            if (s === n.id || t === n.id) hl.links.add(l);
          }
        }
      })
      .onNodeClick((n: GNode) => { if (!n.isTag) openRef.current(n.path); })
      .nodeCanvasObject((n: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const hl = hlRef.current;
        const dimmed = hl.nodes.size > 0 && !hl.nodes.has(n);
        const hovered = hl.nodes.has(n) && hl.nodes.size > 1;
        const nd = n as any; // d3 运行时会挂 x/y 坐标
        const val = (n.isTag ? 1.5 + Math.sqrt(n.deg * 2) : 1 + Math.sqrt(n.deg * 3))
          * (1 + (showHeatRef.current ? n.heat * 0.7 : 0));
        const r = 5 * Math.sqrt(val) * (hovered ? 1.2 : 1); // 悬停轻微放大
        // 柔和描边增加层次；悬停换品牌紫粗描边
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, 2 * Math.PI, false);
        ctx.fillStyle = (showHeatRef.current && n.heat > 0 ? blend(n.color, DANGER, 0.7 * n.heat) : n.color);
        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.fill();
        ctx.globalAlpha = dimmed ? 0.2 : 1;
        ctx.lineWidth = (hovered ? 2.4 : 1) / globalScale;
        ctx.strokeStyle = hovered
          ? (dark() ? '#c3adfd' : '#6c5ce7')
          : (dark() ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.14)');
        ctx.stroke();
        ctx.globalAlpha = 1;
      }) as FG;
    // 少节点时加大斥力，让布局舒展不拥挤（默认 -30 偏挤）
    const charge = fg.d3Force('charge');
    if (small && charge && typeof charge.strength === 'function') charge.strength(-80);

    fgRef.current = fg;
    const ro = new ResizeObserver(() => {
      fg.width(el.clientWidth).height(el.clientHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      // force-graph 无公开销毁 API，移除 DOM 让 GC 回收
      fgRef.current = null;
    };
  }, [graph]);

  return (
    <div className="panel panel--full graph-overlay">
      <div className="panel__head graph-header">
        <button className="btn-small" onClick={onClose}>← 返回</button>
        <span className="panel__title graph-title">知识图谱</span>
        <span className="muted">
          {graph.nodes.filter((n) => !n.isTag).length} 笔记 · {graph.links.length} 链接 · 拖拽布局 · 滚轮缩放 · 单击打开笔记
        </span>
        <button
          className={`btn-small ${showHeat ? 'saved' : ''}`}
          onClick={() => setShowHeat((v) => !v)}
          title="把收录进错题本的笔记染成红色、放大，直观看出薄弱章节"
        >
          错题热力 {showHeat ? '开' : '关'}
        </button>
        <button
          className={`btn-small ${showTags ? 'saved' : ''}`}
          onClick={() => setShowTags((v) => !v)}
          title="把 #标签 聚合为琥珀色节点（仅显示被 3 篇以上笔记使用的标签）"
        >
          # 标签节点 {showTags ? '开' : '关'}
        </button>
      </div>
      <div className="panel__body graph-stage">
        {graph.nodes.length === 0 ? (
          <div className="graph-empty">
            <p>还没有可显示的笔记</p>
            <p className="muted">创建笔记并用 [[双链]] 或 #标签 互相关联，图谱会自动生长</p>
          </div>
        ) : (
          <div ref={containerRef} className="graph-canvas" />
        )}
        {graph.legend.length > 1 && (
          <div className="graph-legend">
            {showTags && (
              <span className="lg-item">
                <i style={{ background: TAG_COLOR }} /> #标签
              </span>
            )}
            {showHeat && graph.hasHeat && (
              <span className="lg-item">
                <i style={{ background: DANGER }} /> 错题热力
              </span>
            )}
            {graph.legend.slice(0, 8).map((l) => (
              <span key={l.name} className="lg-item">
                <i style={{ background: l.color }} /> {l.name} · {l.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
