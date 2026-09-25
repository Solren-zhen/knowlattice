import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderPathwaySvg, updatePathwaySvgEdges } from '../core/pathway';
import { makePathwayMarkdown, type PathwayBuilderEdge as EdgeRow, type PathwayBuilderGroup as GroupRow, type PathwayBuilderNode as NodeRow, type PathwayBuilderRelation as Relation } from '../core/pathwayBuilder';
import { toast } from '../core/feedback';
import { loadPathwayHistory, removePathwayHistory, savePathwayHistory, type PathwayHistoryItem } from '../core/pathwayHistory';
import { duplicatePathwayTemplate, listPathwayTemplates, removePathwayTemplate, renamePathwayTemplate, savePathwayTemplate, type PathwayTemplate } from '../core/pathwayTemplates';

interface Snapshot { title: string; groups: GroupRow[]; nodes: NodeRow[]; edges: EdgeRow[]; quickText: string }
interface QuickError { line: number; text: string; reason: string }
interface Props { onInsert: (markdown: string) => boolean | void; onClose: () => void }

const COLORS = ['#d64545', '#2f9e44', '#1c7ed6', '#e8590c', '#7048e8', '#0ca678'];
const relationArrow = (r: Relation) => r === 'reversible' ? '⇄' : r === 'inhibit' ? '⊣' : r === 'promote' ? '⟶' : '→';
function parseHistory(item: PathwayHistoryItem) {
  const body = item.markdown.replace(/^```pathway\n?/, '').replace(/\n?```\s*$/, '');
  const lines = body.split(/\r?\n/); const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || item.title;
  const groups: GroupRow[] = []; let current = '通路';
  for (const line of lines) if (/^##\s+/.test(line)) { const p = line.replace(/^##\s+/, '').split('|').map((x) => x.trim()); current = p[0] || `分组 ${groups.length + 1}`; groups.push({ name: current, color: /^#/.test(p[1] ?? '') ? p[1] : COLORS[groups.length % COLORS.length], note: p.slice(/^#/.test(p[1] ?? '') ? 2 : 1).join(' | ') }); }
  if (!groups.length) groups.push({ name: '通路', color: COLORS[0], note: '' });
  const nodes = new Map<string, NodeRow>(); const edges: EdgeRow[] = []; current = groups[0].name;
  for (const line of lines) {
    if (/^##\s+/.test(line)) { current = line.replace(/^##\s+/, '').split('|')[0].trim() || current; continue; }
    const position = /^@\s+(.*?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)$/.exec(line);
    if (position) { nodes.set(position[1].trim(), { name: position[1].trim(), group: current, x: Number(position[2]), y: Number(position[3]) }); continue; }
    const declaration = /^@\s+(.+)$/.exec(line); if (declaration) { nodes.set(declaration[1].trim(), { name: declaration[1].trim(), group: current }); continue; }
    const m = /^(.+?)\s+(<->|->|→|⇌)\s+(.+?)(?:\s*:\s*(.*))?$/.exec(line); if (!m) continue;
    const raw = m[4] ?? ''; const relation: Relation = raw.startsWith('促进') ? 'promote' : raw.startsWith('抑制') ? 'inhibit' : m[2] === '<->' || m[2] === '⇌' ? 'reversible' : 'convert';
    const from = m[1].trim(); const to = m[3].trim(); nodes.set(from, nodes.get(from) ?? { name: from, group: current }); nodes.set(to, nodes.get(to) ?? { name: to, group: current });
    edges.push({ from, to, label: raw.replace(/^(促进|抑制|转化|可逆)(?:\s*[·:]\s*)?/, ''), relation, group: current });
  }
  return { title, groups, nodes: [...nodes.values()], edges };
}

function download(name: string, content: BlobPart, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function MedicalPathwayBuilder({ onInsert, onClose }: Props) {
  const [title, setTitle] = useState('糖代谢通路');
  const [groups, setGroups] = useState<GroupRow[]>([{ name: '代谢过程', color: COLORS[0], note: '可补充关键酶和临床意义' }]);
  const [nodes, setNodes] = useState<NodeRow[]>([{ name: '葡萄糖', group: '代谢过程' }, { name: '6-磷酸葡萄糖', group: '代谢过程' }, { name: '丙酮酸', group: '代谢过程' }]);
  const [edges, setEdges] = useState<EdgeRow[]>([{ from: '葡萄糖', to: '6-磷酸葡萄糖', label: '己糖激酶', relation: 'convert', group: '代谢过程' }, { from: '6-磷酸葡萄糖', to: '丙酮酸', label: '糖酵解', relation: 'convert', group: '代谢过程' }]);
  const [quickText, setQuickText] = useState('葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶\n6-磷酸葡萄糖 -> 丙酮酸 : 糖酵解\n丙酮酸 -> 乳酸, 乙酰CoA : 分支');
  const [quickErrors, setQuickErrors] = useState<QuickError[]>([]); const [advancedOpen, setAdvancedOpen] = useState(false); const [zoom, setZoom] = useState(1); const [stage, setStage] = useState({ w: 0, h: 0 }); const [nodeSearch, setNodeSearch] = useState('');
  const [history, setHistory] = useState<PathwayHistoryItem[]>(() => loadPathwayHistory()); const [templates, setTemplates] = useState<PathwayTemplate[]>([]); const [templateQuery, setTemplateQuery] = useState(''); const [undoStack, setUndoStack] = useState<Snapshot[]>([]); const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const [branchFrom, setBranchFrom] = useState('丙酮酸'); const [branchA, setBranchA] = useState('乳酸'); const [branchB, setBranchB] = useState('乙酰CoA');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const editSnapshotRef = useRef<Snapshot | null>(null);
  /** 方向键连续微调的时间窗：700ms 内同一节点的按键合并为一次撤销 */
  const lastNudgeRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const dialogRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void listPathwayTemplates().then(setTemplates).catch(() => setTemplates([])); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[hidden], [inert]') &&
        (element.tagName === 'SUMMARY' || !element.closest('details:not([open])')));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);
  const defaultGroup = groups[0]?.name || '通路';
  const snapshot = (): Snapshot => ({ title, groups, nodes, edges, quickText });
  const applySnapshot = (s: Snapshot) => { setTitle(s.title); setGroups(s.groups); setNodes(s.nodes); setEdges(s.edges); setQuickText(s.quickText); };
  const remember = () => { setUndoStack((xs) => [...xs, snapshot()].slice(-50)); setRedoStack([]); };
  const beginEdit = () => { if (!editSnapshotRef.current) editSnapshotRef.current = snapshot(); };
  const commitEdit = () => {
    const previous = editSnapshotRef.current;
    editSnapshotRef.current = null;
    if (!previous || JSON.stringify(previous) === JSON.stringify(snapshot())) return;
    setUndoStack((xs) => [...xs, previous].slice(-50));
    setRedoStack([]);
  };
  const undo = () => { const s = undoStack.at(-1); if (!s) return; setRedoStack((xs) => [...xs, snapshot()]); setUndoStack((xs) => xs.slice(0, -1)); applySnapshot(s); };
  const redo = () => { const s = redoStack.at(-1); if (!s) return; setUndoStack((xs) => [...xs, snapshot()]); setRedoStack((xs) => xs.slice(0, -1)); applySnapshot(s); };
  const updateNode = (i: number, patch: Partial<NodeRow>) => {
    const current = nodes[i];
    if (!current) return;
    if (typeof patch.name === 'string' && current.name.trim() && patch.name.trim() !== current.name.trim()) {
      const previous = current.name.trim();
      setEdges((xs) => xs.map((edge) => ({
        ...edge,
        from: edge.from.trim() === previous ? patch.name! : edge.from,
        to: edge.to.trim() === previous ? patch.name! : edge.to,
      })));
      if (selectedNode === previous) setSelectedNode(patch.name.trim());
    }
    setNodes((xs) => xs.map((x, j) => j === i ? { ...x, ...patch } : x));
  };
  const updateEdge = (i: number, patch: Partial<EdgeRow>) => setEdges((xs) => xs.map((x, j) => j === i ? { ...x, ...patch } : x));
  const markdown = useMemo(() => makePathwayMarkdown(title, groups, nodes, edges), [title, groups, nodes, edges]);
  const preview = useMemo(() => renderPathwaySvg(markdown.slice('```pathway\n'.length, -'\n```'.length)), [markdown]);
  useLayoutEffect(() => {
    const box = previewRef.current?.querySelector('svg')?.viewBox.baseVal;
    if (box?.width && box.height) setStage({ w: box.width, h: box.height });
  }, [preview]);
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    root.querySelectorAll('.pw-node').forEach((node) => node.classList.remove('pw-node-selected'));
    if (!selectedNode) return;
    [...root.querySelectorAll<SVGGElement>('.pw-node')]
      .find((node) => node.getAttribute('data-pw-key') === selectedNode)?.classList.add('pw-node-selected');
  }, [selectedNode, preview]);
  const warnings = useMemo(() => { const names = nodes.map((n) => n.name.trim()).filter(Boolean); const connected = new Set(edges.flatMap((e) => [e.from.trim(), e.to.trim()])); return [...new Set(names.filter((n, i) => names.indexOf(n) !== i).map((n) => `节点“${n}”出现多次，请确认是否为同一节点`)), ...nodes.filter((n) => n.name.trim() && !connected.has(n.name.trim())).map((n) => `节点“${n.name.trim()}”尚未连接`), ...edges.filter((e) => e.from.trim() && e.to.trim() && !e.label.trim()).map((e) => `关系“${e.from.trim()} → ${e.to.trim()}”缺少说明`)]; }, [nodes, edges]);

  const applyQuickText = () => {
    const nextEdges: EdgeRow[] = []; const nextNodes = new Set<string>(); const errors: QuickError[] = [];
    quickText.split(/\r?\n/).forEach((raw, index) => { const line = raw.trim(); if (!line || line.startsWith('#')) return; const match = /^(.+?)\s*(?:->|→|⇄|<->)\s*(.+?)(?:\s*:\s*(.*))?$/.exec(line); if (!match) { errors.push({ line: index + 1, text: raw, reason: '应写成“起点 -> 终点 : 说明”' }); return; } const from = match[1].trim(); const targets = match[2].split(/[，,、+]/).map((v) => v.trim()).filter(Boolean); if (!from || !targets.length) { errors.push({ line: index + 1, text: raw, reason: '起点和终点不能为空' }); return; } const rawLabel = (match[3] ?? '').trim(); const relation: Relation = /促进/.test(rawLabel) ? 'promote' : /抑制/.test(rawLabel) ? 'inhibit' : /⇄|<->/.test(line) ? 'reversible' : 'convert'; const label = rawLabel.replace(/^(促进|抑制|转化|可逆)(?:\s*[·:]\s*)?/, ''); nextNodes.add(from); for (const to of targets) { nextNodes.add(to); if (!nextEdges.some((e) => e.from === from && e.to === to)) nextEdges.push({ from, to, label, relation, group: defaultGroup }); } });
    setQuickErrors(errors); if (!nextEdges.length) return; remember(); setNodes([...nextNodes].map((name) => ({ name, group: defaultGroup }))); setEdges(nextEdges);
  };
  const addBranch = () => { const from = branchFrom.trim(); const to = [branchA.trim(), branchB.trim()].filter(Boolean); if (!from || to.length !== 2 || to[0] === to[1]) return; remember(); setNodes((xs) => { const names = new Set(xs.map((x) => x.name.trim())); return [...xs, ...[from, ...to].filter((x) => x && !names.has(x)).map((name) => ({ name, group: defaultGroup }))]; }); setEdges((xs) => { const old = new Set(xs.map((x) => `${x.from}\u0000${x.to}`)); return [...xs, ...to.filter((x) => !old.has(`${from}\u0000${x}`)).map((x) => ({ from, to: x, label: '', relation: 'convert' as const, group: defaultGroup }))]; }); };
  const loadItem = (item: PathwayHistoryItem) => { remember(); const x = parseHistory(item); setTitle(x.title); setGroups(x.groups); setNodes(x.nodes); setEdges(x.edges); setQuickText(''); setQuickErrors([]); };
  const removeNode = (i: number) => { const name = nodes[i]?.name.trim(); remember(); setNodes((xs) => xs.filter((_, j) => j !== i)); if (name) setEdges((xs) => xs.filter((e) => e.from.trim() !== name && e.to.trim() !== name)); if (name === selectedNode) setSelectedNode(null); };
  const removeGroup = (i: number) => {
    if (groups.length < 2) return;
    remember();
    const old = groups[i].name;
    const fallback = groups.find((_, j) => j !== i)?.name || '通路';
    setGroups((xs) => xs.filter((_, j) => j !== i));
    setNodes((xs) => xs.map((x) => x.group === old ? { ...x, group: fallback } : x));
    setEdges((xs) => xs.map((x) => x.group === old ? { ...x, group: fallback } : x));
  };
  /** 节点当前画布坐标：手动定位优先，否则读自动布局写进 data-pw-x/y 的渲染结果 */
  const renderedNodePos = (key: string): { x: number; y: number } | null => {
    const row = nodes.find((n) => n.name.trim() === key);
    if (row && Number.isFinite(row.x) && Number.isFinite(row.y)) return { x: row.x!, y: row.y! };
    const el = [...(previewRef.current?.querySelectorAll<SVGGElement>('.pw-node[data-pw-key]') ?? [])]
      .find((g) => g.getAttribute('data-pw-key') === key);
    const x = Number(el?.getAttribute('data-pw-x'));
    const y = Number(el?.getAttribute('data-pw-y'));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };

  /** 方向键微调：连续按键只在开头留一条撤销记录（整段位移一次撤销） */
  const nudgeNode = (dx: number, dy: number) => {
    if (!selectedNode) return;
    const base = renderedNodePos(selectedNode);
    if (!base) return;
    const now = Date.now();
    const continuing = lastNudgeRef.current.key === selectedNode && now - lastNudgeRef.current.at < 700;
    if (!continuing) remember();
    lastNudgeRef.current = { key: selectedNode, at: now };
    const key = selectedNode;
    setNodes((xs) => xs.map((x) => x.name.trim() === key
      ? { ...x, x: Math.max(60, Math.round(base.x + dx)), y: Math.max(60, Math.round(base.y + dy)) }
      : x));
  };

  /** 清除选中节点的手动定位：回到按流向自动分层 */
  const clearNodePosition = () => {
    if (!selectedNode) return;
    remember();
    lastNudgeRef.current = { key: '', at: 0 };
    const key = selectedNode;
    setNodes((xs) => xs.map((x) => x.name.trim() === key ? { name: x.name, group: x.group } : x));
  };

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const node = (e.target as Element).closest<SVGGElement>('.pw-node[data-pw-key]');
    const key = node?.getAttribute('data-pw-key') ?? null;
    setSelectedNode(key);
    e.currentTarget.focus();
    // 拖拽：拖动中直接改 SVG 节点 transform 并实时重排连线（updatePathwaySvgEdges），
    // 不走 React 重渲；松手才把坐标写回 state，成为 `@ 节点 | x | y` 手动定位。
    // 注意：上面的 setSelectedNode 会让 React 重写 preview 的 innerHTML（实测 19.x 对
    // 相同的 dangerouslySetInnerHTML 字符串也重建 DOM），pointerdown 时拿到的元素引用
    // 随即失效——所以每次 move 都按 data-pw-key 重新查询当前文档里的节点与 svg。
    if (!node || !key) return;
    const base = renderedNodePos(key);
    if (!base) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const canvas = e.currentTarget;
    const before = snapshot(); // 真拖动了才进撤销栈（finish 里判断）
    canvas.classList.add('is-dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch { /* jsdom：无指针捕获 */ }

    const liveNode = (): { svg: SVGSVGElement; el: SVGGElement } | null => {
      const svg = getPreviewSvg();
      const el = [...(svg?.querySelectorAll<SVGGElement>('.pw-node[data-pw-key]') ?? [])]
        .find((g) => g.getAttribute('data-pw-key') === key);
      return svg && el ? { svg, el } : null;
    };
    const posOf = (clientX: number, clientY: number) => {
      const rect = liveNode()?.svg.getBoundingClientRect();
      const scale = rect && rect.width > 0 ? rect.width / Math.max(1, stage.w) : 1;
      return {
        x: Math.max(60, Math.round(base.x + (clientX - startX) * scale)),
        y: Math.max(60, Math.round(base.y + (clientY - startY) * scale)),
      };
    };
    const onMove = (ev: PointerEvent) => {
      const live = liveNode();
      if (!live) return;
      const p = posOf(ev.clientX, ev.clientY);
      live.el.setAttribute('data-pw-x', String(p.x));
      live.el.setAttribute('data-pw-y', String(p.y));
      live.el.setAttribute('transform', `translate(${p.x} ${p.y})`);
      updatePathwaySvgEdges(live.svg);
    };
    const finish = (ev: PointerEvent) => {
      canvas.classList.remove('is-dragging');
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* 同上 */ }
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', finish);
      canvas.removeEventListener('pointercancel', finish);
      if (ev.type === 'pointercancel') return; // 取消：DOM 改动会被重渲覆盖，不写 state
      const p = posOf(ev.clientX, ev.clientY);
      if (p.x === base.x && p.y === base.y) return; // 只是点选，没拖
      setUndoStack((xs) => [...xs, before].slice(-50));
      setRedoStack([]);
      setNodes((xs) => xs.map((x) => x.name.trim() === key ? { ...x, x: p.x, y: p.y } : x));
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  };

  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (!selectedNode) return;
    const index = nodes.findIndex((node) => node.name.trim() === selectedNode);
    if (index < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeNode(index); return; }
    if (e.key === 'Escape') { e.preventDefault(); setSelectedNode(null); return; }
    if (e.key === 'Enter') { e.preventDefault(); clearNodePosition(); return; }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeNode(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeNode(step, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeNode(0, -step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeNode(0, step); }
  };

  /** 双击节点 → 展开左侧面板并聚焦该节点的名称输入框（改名后连线随之更新） */
  const onCanvasDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const node = (e.target as Element).closest<SVGGElement>('.pw-node[data-pw-key]');
    if (!node) return;
    const key = node.getAttribute('data-pw-key');
    setSelectedNode(key);
    const index = nodes.findIndex((n) => n.name.trim() === key);
    if (index < 0) return;
    setAdvancedOpen(true);
    requestAnimationFrame(() => {
      previewRef.current?.closest('.pathway-builder-body')
        ?.querySelectorAll<HTMLInputElement>('.pathway-rows input[aria-label^="节点 "]')[index]
        ?.focus();
    });
  };
  const getPreviewSvg = () => previewRef.current?.querySelector<SVGSVGElement>('svg') ?? null;
  const serializePreviewSvg = (svg: SVGSVGElement) => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const styleProperties = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'vector-effect', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'paint-order', 'opacity', 'filter'];
    const originalNodes = [svg, ...svg.querySelectorAll('*')];
    const clonedNodes = [clone, ...clone.querySelectorAll('*')];
    originalNodes.forEach((node, index) => {
      const computed = getComputedStyle(node);
      const inline = styleProperties.map((property) => `${property}:${computed.getPropertyValue(property)}`).filter((rule) => !rule.endsWith(':')).join(';');
      if (inline) (clonedNodes[index] as SVGElement).setAttribute('style', inline);
    });
    return new XMLSerializer().serializeToString(clone);
  };
  const exportSvg = () => { const svg = getPreviewSvg(); if (svg) { download(`${title || '医学通路'}.svg`, serializePreviewSvg(svg), 'image/svg+xml'); toast('SVG 已导出', 'ok'); } else toast('当前没有可导出的通路图', 'info'); };
  const exportPng = () => { const svg = getPreviewSvg(); if (!svg) { toast('当前没有可导出的通路图', 'info'); return; } const url = URL.createObjectURL(new Blob([serializePreviewSvg(svg)], { type: 'image/svg+xml' })); const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth * 2; canvas.height = image.naturalHeight * 2; const ctx = canvas.getContext('2d'); if (!ctx) { URL.revokeObjectURL(url); toast('PNG 导出失败：无法创建画布', 'err'); return; } ctx.scale(2, 2); ctx.drawImage(image, 0, 0); canvas.toBlob((blob) => { URL.revokeObjectURL(url); if (blob) { download(`${title || '医学通路'}.png`, blob, 'image/png'); toast('PNG 已导出', 'ok'); } else toast('PNG 导出失败：图片尺寸超出浏览器限制', 'err'); }); }; image.onerror = () => { URL.revokeObjectURL(url); toast('PNG 导出失败，请先导出 SVG', 'err'); }; image.src = url; };
  const locateNode = () => { const query = nodeSearch.trim().toLowerCase(); if (!query) return; const all = [...(previewRef.current?.querySelectorAll<SVGGElement>('.pw-node') ?? [])]; all.forEach((node) => node.classList.remove('pw-node-hit')); const hit = all.find((node) => (node.querySelector('.pw-label')?.textContent ?? '').toLowerCase().includes(query)); if (hit) { setSelectedNode(hit.getAttribute('data-pw-key') ?? null); hit.classList.add('pw-node-hit'); hit.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); } else toast(`未找到节点“${nodeSearch.trim()}”`, 'info'); };

  /** 拖拽/方向键微调过的节点数（供「回到自动布局」按钮显示与禁用） */
  const pinnedCount = useMemo(() => nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)).length, [nodes]);
  const clearAllPositions = () => { remember(); lastNudgeRef.current = { key: '', at: 0 }; setNodes((xs) => xs.map((x) => ({ name: x.name, group: x.group }))); };

  const saveTemplate = async () => {
    try {
      setTemplates(await savePathwayTemplate(title, markdown));
      setHistory(savePathwayHistory(title, markdown));
      toast('通路模板已保存', 'ok');
    } catch (error) {
      toast(`保存模板失败：${(error as Error).message}`, 'err');
    }
  };
  const saveAndInsert = () => {
    setHistory(savePathwayHistory(title, markdown));
    try {
      if (onInsert(markdown) !== false) { toast('通路已插入当前笔记', 'ok'); onClose(); }
    } catch (error) {
      toast(`插入通路失败：${(error as Error).message}`, 'err');
    }
  };
  const insertSavedPathway = (source: string) => {
    try {
      if (onInsert(source) !== false) toast('通路已插入当前笔记', 'ok');
    } catch (error) {
      toast(`插入通路失败：${(error as Error).message}`, 'err');
    }
  };

  return <div className="pathway-builder-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section ref={dialogRef} className="pathway-builder" role="dialog" aria-modal="true" aria-labelledby="pathway-builder-title">
    <header className="pathway-builder-head"><div><h2 id="pathway-builder-title">医学通路工作区</h2><p>先用一行一条关系快速起稿，再在画布中整理节点。</p></div><button className="btn-icon" onClick={onClose} aria-label="返回工作区">×</button></header>
    <div className="pathway-toolbar"><button className="btn-small" onClick={undo} disabled={!undoStack.length}>↶ 撤销</button><button className="btn-small" onClick={redo} disabled={!redoStack.length}>↷ 重做</button><button className="btn-small" onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}>放大</button><button className="btn-small" onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.1) * 10) / 10))}>缩小</button><span className="pathway-zoom">{Math.round(zoom * 100)}%</span><button className="btn-small" onClick={() => setZoom(1)}>适配</button><button className="btn-small" onClick={clearAllPositions} disabled={!pinnedCount} title="清掉所有手动坐标，节点回到按流向自动分层">回到自动布局{pinnedCount ? `（${pinnedCount}）` : ''}</button><span className="pathway-toolbar-spacer" /><button className="btn-small" onClick={exportSvg}>导出 SVG</button><button className="btn-small" onClick={exportPng}>导出 PNG</button></div>
    <div className="pathway-builder-body"><div className="pathway-builder-form" onFocus={beginEdit} onBlur={commitEdit}><div className="pathway-quick-start"><div className="pathway-quick-title"><b>快速绘制</b><span className="muted">一行一条关系；逗号表示一对多</span></div><label>图标题<input value={title} onChange={(e) => setTitle(e.target.value)} /></label><textarea aria-label="快速描述通路" value={quickText} onChange={(e) => { setQuickText(e.target.value); setQuickErrors([]); }} rows={5} placeholder="例如：葡萄糖 -> 丙酮酸 : 糖酵解" /><div className="pathway-quick-actions"><button className="btn-small primary" onClick={applyQuickText}>生成预览</button><span className="muted">支持 →、⇄、促进和抑制</span></div>{quickErrors.length > 0 && <div className="pathway-input-errors" role="alert"><b>有 {quickErrors.length} 行未识别</b>{quickErrors.map((error) => <div key={`${error.line}-${error.text}`}><strong>第 {error.line} 行</strong>：{error.reason}<code>{error.text}</code></div>)}</div>}</div>
      <details className="pathway-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}><summary>编辑节点、关系和历史</summary><div className="pathway-advanced-body">
      <div className="pathway-builder-section-head"><b>分组 / 泳道</b><button className="btn-small" onClick={() => { remember(); setGroups((xs) => [...xs, { name: `分组 ${xs.length + 1}`, color: COLORS[xs.length % COLORS.length], note: '' }]); }}>+ 添加分组</button></div><div className="pathway-group-list">{groups.map((g, i) => <div className="pathway-group-card" key={`${g.name}-${i}`}><input aria-label={`分组 ${i + 1} 名称`} value={g.name} onChange={(e) => { const old = g.name; const name = e.target.value; setGroups((xs) => xs.map((x, j) => j === i ? { ...x, name } : x)); setNodes((xs) => xs.map((x) => x.group === old ? { ...x, group: name } : x)); setEdges((xs) => xs.map((x) => x.group === old ? { ...x, group: name } : x)); }} /><input aria-label={`分组 ${i + 1} 说明`} placeholder="分组说明（可选）" value={g.note} onChange={(e) => setGroups((xs) => xs.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} /><div className="pathway-swatches">{COLORS.map((color) => <button type="button" key={color} className={`pathway-swatch ${g.color === color ? 'selected' : ''}`} style={{ background: color }} onClick={() => setGroups((xs) => xs.map((x, j) => j === i ? { ...x, color } : x))} aria-label={`分组 ${i + 1} 颜色 ${color}`} />)}</div>{groups.length > 1 && <button className="btn-icon" onClick={() => removeGroup(i)} aria-label={`删除分组 ${i + 1}`}>×</button>}</div>)}</div>
      <div className="pathway-builder-section-head"><b>节点</b><button className="btn-small" onClick={() => { remember(); setNodes((xs) => [...xs, { name: '', group: defaultGroup }]); }}>+ 添加节点</button></div><div className="pathway-rows">{nodes.map((n, i) => <div className="pathway-row" key={i}><input aria-label={`节点 ${i + 1}`} placeholder="如：乳酸" value={n.name} onChange={(e) => updateNode(i, { name: e.target.value })} /><select aria-label={`节点 ${i + 1} 分组`} value={n.group} onChange={(e) => updateNode(i, { group: e.target.value })}>{groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</select><button className="btn-icon" onClick={() => removeNode(i)} aria-label={`删除节点 ${i + 1}`}>×</button></div>)}</div>
      <div className="pathway-builder-section-head"><b>关系和箭头</b><button className="btn-small" onClick={() => { remember(); setEdges((xs) => [...xs, { from: '', to: '', label: '', relation: 'convert', group: defaultGroup }]); }}>+ 添加关系</button></div><div className="pathway-rows">{edges.map((e, i) => <div className="pathway-edge-row" key={i}><div className="pathway-edge-main"><input aria-label={`关系 ${i + 1} 起点`} placeholder="起点" value={e.from} onChange={(x) => updateEdge(i, { from: x.target.value })} /><span className="pathway-edge-arrow">{relationArrow(e.relation)}</span><input aria-label={`关系 ${i + 1} 终点`} placeholder="终点" value={e.to} onChange={(x) => updateEdge(i, { to: x.target.value })} /><select aria-label={`关系 ${i + 1} 类型`} value={e.relation} onChange={(x) => updateEdge(i, { relation: x.target.value as Relation })}><option value="convert">转化 →</option><option value="promote">促进 ⟶</option><option value="inhibit">抑制 ⊣</option><option value="reversible">可逆 ⇄</option></select><select aria-label={`关系 ${i + 1} 分组`} value={e.group} onChange={(x) => updateEdge(i, { group: x.target.value })}>{groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</select><button className="btn-icon" onClick={() => { remember(); setEdges((xs) => xs.filter((_, j) => j !== i)); }} aria-label={`删除关系 ${i + 1}`}>×</button></div><input className="pathway-edge-label" aria-label={`关系 ${i + 1} 说明`} placeholder="酶 / 条件（可选）" value={e.label} onChange={(x) => updateEdge(i, { label: x.target.value })} /></div>)}</div>
      <div className="pathway-branch-box"><div className="pathway-builder-section-head"><b>一对多分支</b><span className="muted">一个节点同时走两条路</span></div><div className="pathway-branch-row"><input aria-label="分支起点" placeholder="起点" value={branchFrom} onChange={(e) => setBranchFrom(e.target.value)} /><span className="pathway-edge-arrow">→</span><input aria-label="分支终点一" placeholder="并列终点 1" value={branchA} onChange={(e) => setBranchA(e.target.value)} /><span className="pathway-edge-arrow">＋</span><input aria-label="分支终点二" placeholder="并列终点 2" value={branchB} onChange={(e) => setBranchB(e.target.value)} /><button className="btn-small" onClick={addBranch}>生成分支</button></div></div>
      <div className="pathway-history-box"><div className="pathway-builder-section-head"><b>最近使用</b><span className="muted">自动保留最近 30 条</span></div>{history.length === 0 ? <div className="muted pathway-history-empty">还没有最近使用的通路</div> : <div className="pathway-history-list">{history.map((item) => <div className="pathway-history-item" key={item.id}><button className="pathway-history-name" onClick={() => loadItem(item)}>{item.title}</button><button className="btn-small" onClick={() => insertSavedPathway(item.markdown)}>插入</button><button className="btn-icon" onClick={() => setHistory(removePathwayHistory(item.id))} aria-label={`删除历史通路 ${item.title}`}>×</button></div>)}</div>}</div>
      <div className="pathway-history-box"><div className="pathway-builder-section-head"><b>通路模板</b><span className="muted">可重复插入，不会修改模板</span></div><input aria-label="搜索通路模板" placeholder="搜索模板" value={templateQuery} onChange={(e) => setTemplateQuery(e.target.value)} />{templates.length === 0 ? <div className="muted pathway-history-empty">还没有保存的模板</div> : <div className="pathway-history-list">{templates.filter((item) => item.title.toLowerCase().includes(templateQuery.trim().toLowerCase())).map((item) => <div className="pathway-history-item" key={item.id}><button className="pathway-history-name" onClick={() => loadItem(item)}>{item.title}</button><button className="btn-small" onClick={() => insertSavedPathway(item.markdown)}>插入</button><button className="btn-small" onClick={() => { const next = window.prompt('重命名通路模板', item.title); if (next?.trim()) void renamePathwayTemplate(item.id, next).then(setTemplates).catch((error) => toast(`重命名模板失败：${(error as Error).message}`, 'err')); }}>改名</button><button className="btn-small" onClick={() => { void duplicatePathwayTemplate(item.id).then(setTemplates).catch((error) => toast(`复制模板失败：${(error as Error).message}`, 'err')); }}>复制</button><button className="btn-icon" onClick={() => { void removePathwayTemplate(item.id).then(setTemplates).catch((error) => toast(`删除模板失败：${(error as Error).message}`, 'err')); }} aria-label={`删除通路模板 ${item.title}`}>×</button></div>)}</div>}</div>
    </div></details></div><div className="pathway-builder-preview"><div className="pathway-preview-top"><span className="pathway-preview-label">拖动节点手动定位 · 未定位的按流向自动分层 · 一对多自动并排成子分支</span><label className="pathway-node-search">查找节点<input value={nodeSearch} onChange={(e) => setNodeSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') locateNode(); }} placeholder="输入名称" /><button className="btn-small" onClick={locateNode}>定位</button></label></div><div ref={previewRef} className="pathway-preview-canvas" tabIndex={0} aria-label="医学通路画布：拖动节点可手动定位，选中后方向键微调（Shift 加速）、Enter 清除定位、Delete 删除" style={{ ['--pw-w' as string]: stage.w ? `${Math.round(stage.w * zoom)}px` : undefined, ['--pw-h' as string]: stage.h ? `${Math.round(stage.h * zoom)}px` : undefined }} onPointerDown={onCanvasPointerDown} onKeyDown={onCanvasKeyDown} onDoubleClick={onCanvasDoubleClick} dangerouslySetInnerHTML={{ __html: preview }} />{(warnings.length > 0 || quickErrors.length > 0) && <div className="pathway-structure-notice"><b>结构提醒</b>{warnings.slice(0, 6).map((warning) => <div key={warning}>{warning}</div>)}</div>}<details><summary>查看生成的 Markdown</summary><pre>{markdown}</pre></details></div></div>
    <footer className="pathway-builder-foot"><span className="muted">通路插入当前光标处，可用 Ctrl+Z 撤销。</span><div><button className="btn-small" onClick={onClose}>返回工作区</button><button className="btn-small" onClick={() => void saveTemplate()}>保存模板</button><button className="btn-small primary" onClick={saveAndInsert}>保存并插入</button></div></footer>
  </section></div>;
}
