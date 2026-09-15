/**
 * 章节树面板（M1）：目录镜像 + 新建笔记 + 批量删除。
 *
 * 布局重构：原先堆在侧栏顶部与底部的功能入口已全部迁移到左侧导航轨（rail），
 * 本组件现在只负责「目录」这一件事——新建 + 目录树 + 批量删除 + 数据操作菜单。
 * 性能：
 * - 树行组件 memo（勾选/删除只重渲染受影响行）；展开态提升到顶层；
 * - 目录文件数/路径列表按树一次性建表（dirFiles），不再每次渲染递归 collectDir；
 * - 虚拟滚动：5227 篇也只渲染视口附近的行（配合 .tree-row 固定 26px 行高）。
 * - 批量删除走一次状态更新（removeMany），避免逐篇触发全树与全索引重建。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '../core/vault';
import { NOTE_TYPE_LABELS, type NoteType } from '../core/parser';
import { IconPlus, IconBackup, IconRestore, IconChevron, IconFolder, IconFolderIn, IconBatch, IconMore } from './icons';
import { toast, confirmBox } from '../core/feedback';
import { clickable } from './a11y';

interface Props {
  tree: TreeNode[];
  currentPath: string | null;
  onOpen: (path: string) => void;
  onCreate: (dir: string, title: string, type?: NoteType) => void;
  onExport: () => Promise<void>;
  onExportFolder: () => Promise<number>;
  onImport: (text: string) => Promise<number>;
  /** 导入 md 文件夹（webkitdirectory 选择目录，相对路径入库） */
  onImportMd: (files: Array<{ path: string; content: string }>) => Promise<number>;
  /** 批量删除选中的笔记 */
  onRemove: (paths: string[]) => void;
}

/** 虚拟滚动行高 —— 与 index.css 的 .tree-row 固定高度保持一致 */
const ROW_H = 26;
/** 视口上下各多渲染的行数 */
const OVERSCAN = 8;

interface FlatRow {
  node: TreeNode;
  depth: number;
  open: boolean;
  /** 目录：其下笔记数（文件为 0） */
  count: number;
}

/** 单行（memo：仅当本行涉及的状态变化时才重渲染） */
const Row = memo(function Row({
  node, depth, count, currentPath, batchMode, sel, open, onOpen, onPickDir, onToggle,
}: {
  node: TreeNode;
  depth: number;
  /** 目录：其下笔记数 */
  count: number;
  currentPath: string | null;
  batchMode: boolean;
  /** 文件：是否已勾选；目录：整目录是否已勾选 */
  sel: boolean;
  /** 目录：是否展开（非目录传 false） */
  open: boolean;
  onOpen: (p: string) => void;
  onPickDir: (p: string) => void;
  onToggle: (node: TreeNode) => void;
}) {
  if (node.type === 'file') {
    const name = node.name.replace(/\.md$/, '');
    const label = batchMode
      ? `${sel ? '取消选择' : '选择'}：${name}`
      : `打开笔记：${name}`;
    return (
      <div
        className={`tree-row file ${currentPath === node.path ? 'active' : ''}`}
        style={{ paddingLeft: depth * 14 + 12 }}
        onClick={() => (batchMode ? onToggle(node) : onOpen(node.path))}
        {...clickable(label)}
      >
        {batchMode && <span className={`ck ${sel ? 'on' : ''}`}>✓</span>}
        {name}
      </div>
    );
  }
  return (
    <div
      className="tree-row dir"
      style={{ paddingLeft: depth * 14 }}
      onClick={() => {
        if (batchMode) { onToggle(node); return; }
        onPickDir(node.path);
        onToggle(node); // 非批量时 onToggle 仅用于切换展开
      }}
      {...clickable(
        batchMode
          ? `${sel ? '取消选择' : '选择'}：${node.name}`
          : `${open ? '收起' : '展开'}目录：${node.name}`,
      )}
    >
      {batchMode && <span className={`ck ${sel ? 'on' : ''}`}>✓</span>}
      <IconChevron open={open} /> {node.name} <span className="dir-count">{count}</span>
    </div>
  );
});

export default function ChapterTree({ tree, currentPath, onOpen, onCreate, onExport, onExportFolder, onImport, onImportMd, onRemove }: Props) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  /** 新建笔记的目标目录：点击目录行时设为该目录，可点提示取消 */
  const [targetDir, setTargetDir] = useState('');
  /** 笔记类型向导：决定生成的骨架 */
  const [noteType, setNoteType] = useState<NoteType>('concept');
  /** 批量删除模式 */
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 备份 / 导出 / 导入 / 批量删除 收纳菜单（低频数据操作） */
  const [moreOpen, setMoreOpen] = useState(false);
  const jsonRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  /** 目录展开态（默认展开前两层） */
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const treeKey = useRef('');
  useEffect(() => {
    const key = tree.map((n) => n.path).join('|');
    if (key === treeKey.current) return;
    treeKey.current = key;
    const base = new Set<string>();
    const walk = (nodes: TreeNode[], depth: number) => {
      if (depth >= 2) return;
      for (const n of nodes) {
        if (n.type === 'dir') { base.add(n.path); walk(n.children ?? [], depth + 1); }
      }
    };
    walk(tree, 0);
    setOpenDirs((prev) => {
      const next = new Set(base);
      prev.forEach((p) => { if (base.has(p)) next.add(p); });
      return next;
    });
  }, [tree]);

  /** 目录路径 → 其下全部笔记路径（按树一次性建表，替代每次渲染递归收集） */
  const dirFiles = useMemo(() => {
    const map = new Map<string, string[]>();
    const walk = (nodes: TreeNode[]): string[] => {
      const out: string[] = [];
      for (const n of nodes) {
        if (n.type === 'dir') {
          const files = walk(n.children ?? []);
          map.set(n.path, files);
          out.push(...files);
        } else {
          out.push(n.path);
        }
      }
      return out;
    };
    walk(tree);
    return map;
  }, [tree]);

  const toggleDirOpen = useCallback((node: TreeNode) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  }, []);

  const toggleNode = useCallback((node: TreeNode) => {
    const paths = node.type === 'dir' ? dirFiles.get(node.path) ?? [] : [node.path];
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = paths.every((p) => next.has(p));
      if (allIn) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  }, [dirFiles]);

  const allPaths = useMemo(() => [...dirFiles.values()].flat(), [dirFiles]);

  const del = () => {
    if (selected.size === 0) return;
    void confirmBox({
      title: `删除选中的 ${selected.size} 篇笔记？`,
      detail: '此操作不可恢复，建议先备份；最近的历史快照仍可在「历史版本」中找回。',
      danger: true,
      okText: '删除',
    }).then((ok) => {
      if (!ok) return;
      onRemove([...selected]);
      setSelected(new Set());
    });
  };

  // ---------- 虚拟滚动：扁平化可见行 + 只渲染视口窗口 ----------
  const treeRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        const open = n.type === 'dir' && openDirs.has(n.path);
        rows.push({ node: n, depth, open, count: n.type === 'dir' ? dirFiles.get(n.path)?.length ?? 0 : 0 });
        if (open) walk(n.children ?? [], depth + 1);
      }
    };
    walk(tree, 0);
    return rows;
  }, [tree, openDirs, dirFiles]);

  const total = flatRows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  /** 读取选中的 md 文件夹（webkitRelativePath 去顶层目录）并入库 */
  const onFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    const list: Array<{ path: string; content: string }> = [];
    for (const file of Array.from(files)) {
      if (!/\.md$/i.test(file.name)) continue;
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
      const path = rel.replace(/^[^/]+\//, ''); // 去掉顶层文件夹名
      list.push({ path, content: await file.text() });
    }
    try {
      const n = await onImportMd(list);
      toast(`已导入 ${n} 篇笔记（md 文件夹）`, 'ok');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err');
    }
    e.target.value = '';
  };

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(targetDir, t, noteType);
    setTitle('');
    setNoteType('concept');
    setCreating(false);
  };

  /** 导出 md 文件夹：先收起菜单，再等导出完成并回报篇数 */
  const exportFolder = async () => {
    setMoreOpen(false);
    const n = await onExportFolder();
    toast(`已导出 ${n} 篇笔记为 md 文件夹(.zip)，可直接用 Obsidian 打开`, 'ok');
  };

  return (
    <aside className="tree-panel">
      <div className="sidebar-header">
        <div className="header-actions">
          <button
            className="new-btn"
            onClick={() => setCreating(!creating)}
            data-tip="新建原子笔记（先选类型，骨架自动生成）"
            aria-label="新建笔记"
          >
            <IconPlus /> 新建
          </button>
          <div className="more-wrap">
            <button
              className={`btn-icon ${moreOpen ? 'on' : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              data-tip="备份 / 导出 / 导入 / 批量删除"
              aria-label="更多操作"
            >
              <IconMore />
            </button>
            {moreOpen && (
              <div
                className="import-menu more-menu"
                onMouseLeave={() => setMoreOpen(false)}
                onKeyDown={(e) => { if (e.key === 'Escape') setMoreOpen(false); }}
              >
                <div onClick={() => { setMoreOpen(false); void onExport(); }} {...clickable()}>
                  <IconBackup /> 备份到 .json
                </div>
                <div onClick={() => void exportFolder()} {...clickable()}>
                  <IconFolder /> 导出 md 文件夹 (.zip)
                </div>
                <div onClick={() => { jsonRef.current?.click(); setMoreOpen(false); }} {...clickable()}>
                  <IconRestore /> 从备份 .json 恢复
                </div>
                <div onClick={() => { folderRef.current?.click(); setMoreOpen(false); }} {...clickable()}>
                  <IconFolderIn /> 导入 md 文件夹
                </div>
                <div className="menu-danger" onClick={() => { setBatchMode((v) => !v); setSelected(new Set()); setMoreOpen(false); }} {...clickable()}>
                  <IconBatch /> {batchMode ? '批量删除（进行中 · 点此退出）' : '批量删除'}
                </div>
              </div>
            )}
          </div>
          <input
            ref={jsonRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = async () => {
                try {
                  const n = await onImport(reader.result as string);
                  toast(`已恢复 ${n} 篇笔记`, 'ok');
                } catch (err) {
                  toast((err as Error).message, 'err');
                }
              };
              reader.readAsText(file);
              e.target.value = '';
            }}
          />
          <input
            ref={folderRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => void onFolder(e)}
            {...({ webkitdirectory: '' } as Record<string, string>)}
          />
        </div>
      </div>
      {creating && (
        <div className="new-note">
          {targetDir && (
            <div className="new-note-dir" title="点击取消目录选择" onClick={() => setTargetDir('')} {...clickable('取消目录选择')}>
              {targetDir} <span className="muted">✕</span>
            </div>
          )}
          <div className="new-note-types">
            {NOTE_TYPE_LABELS.map((t) => (
              <button
                key={t.key}
                className={`type-chip ${noteType === t.key ? 'on' : ''}`}
                onClick={() => setNoteType(t.key)}
                title={t.key === 'blank' ? '只建标题，自己写' : `自动生成${t.label}骨架`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="new-note-row">
            <input
              autoFocus
              placeholder={targetDir ? `保存到「${targetDir}」，输入标题` : '笔记标题，如：氧解离曲线'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <button className="btn-small" onClick={submit}>
              创建
            </button>
          </div>
        </div>
      )}
      <div
        className="tree"
        ref={treeRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {total === 0 ? (
          <div className="tree-empty">还没有笔记，点 ＋ 创建第一篇</div>
        ) : (
          <>
            <div style={{ height: start * ROW_H }} aria-hidden />
            {flatRows.slice(start, end).map(({ node, depth, open, count }) => (
              <Row
                key={node.path}
                node={node}
                depth={depth}
                count={count}
                currentPath={currentPath}
                batchMode={batchMode}
                sel={
                  node.type === 'file'
                    ? selected.has(node.path)
                    : (dirFiles.get(node.path)?.length ?? 0) > 0 &&
                      (dirFiles.get(node.path) ?? []).every((p) => selected.has(p))
                }
                open={open}
                onOpen={onOpen}
                onPickDir={setTargetDir}
                onToggle={node.type === 'dir' ? toggleDirOpen : toggleNode}
              />
            ))}
            <div style={{ height: (total - end) * ROW_H }} aria-hidden />
          </>
        )}
      </div>
      {batchMode && (
        <div className="tree-batchbar">
          <span className="count">已选 {selected.size} 篇</span>
          <button
            className="btn-small"
            onClick={() => setSelected((prev) => (prev.size === allPaths.length ? new Set() : new Set(allPaths)))}
          >
            {selected.size === allPaths.length && allPaths.length > 0 ? '清空' : '全选'}
          </button>
          <button className="btn-small del" disabled={selected.size === 0} onClick={del}>
            删除
          </button>
          <button className="btn-small" onClick={() => { setBatchMode(false); setSelected(new Set()); }}>退出</button>
        </div>
      )}
    </aside>
  );
}
