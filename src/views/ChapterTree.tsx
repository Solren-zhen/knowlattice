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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ImportResult, TreeNode } from '../core/vault';
import { NOTE_TYPE_LABELS, type NoteType } from '../core/parser';
import { IconPlus, IconBackup, IconRestore, IconChevron, IconFolder, IconFolderIn, IconBatch, IconMore, IconTrash } from './icons';
import { toast, confirmBox } from '../core/feedback';
import { clickable } from './a11y';
import { useEsc } from './useEsc';
import { packSummary, parseKnowledgePack } from '../core/knowledgePack';
import { apkgSummary, apkgToVaultFiles, readAnkiTsv, readApkg } from '../core/ankiImport';
import { datasetSummary, datasetToVaultFiles, detectDataset, type DatasetKind } from '../core/datasetImport';
import { EXISTING_NOTE_REASON, skipExistingNotes, type ImportToVaultResult } from '../core/importToVault';

/**
 * 数据集类别 → 中文名（只为拼 sourceNote 与提示文案）。
 * core/datasetImport 里那份 KIND_LABELS 没有导出，而本次改动范围不允许改它，
 * 所以在这里复制一份；若将来两处漂移，最坏结果只是界面文案不一致，不影响数据。
 */
const DATASET_KIND_LABEL: Record<DatasetKind, string> = {
  'symptom-disease': '症状→疾病对照',
  mnemonic: '口诀/记忆术',
  'term-list': '术语表',
  unknown: '未识别',
};

interface Props {
  tree: TreeNode[];
  currentPath: string | null;
  onOpen: (path: string) => void;
  onCreate: (dir: string, title: string, type?: NoteType) => void;
  onExport: () => Promise<void>;
  onExportFolder: () => Promise<number>;
  onImport: (text: string) => Promise<ImportResult>;
  /** 导入 md 文件夹（webkitdirectory 选择目录，相对路径入库） */
  onImportMd: (files: Array<{ path: string; content: string }>) => Promise<ImportResult>;
  /** 打开库时**自动**修正 Markdown 的报告（vault.autoRepair；没有可修的是 null）。
   *  这里只负责把「自动改了什么」显示出来——修复本身不再是菜单里的一次性动作。 */
  autoRepairReport?: ImportResult | null;
  /** 导入知识包（.json）：逐条返回结果，由本组件把跳过原因显示给用户 */
  onImportPack?: (text: string) => Promise<{ created: number; skipped: Array<{ path: string; title: string; reason: string }> }>;
  /** 统一导入面板（自动识别格式 + 批量）：提供时，把「恢复 / 知识包 / Anki / 数据集 / md 文件夹」
   *  全部收敛成一个「导入…」——用户不必先判断文件属于哪一类；不提供时保留原有分门别类的入口（向后兼容）。 */
  onUnifiedImport?: () => void;
  /** 下载自带示例知识包（不含医学结论，只演示格式与挖空用法） */
  onDownloadExamplePack?: () => void;
  /** 桌面端：把浏览器版（IndexedDB）里的既有笔记/附件迁移到本机文件夹；浏览器版不传即隐藏入口 */
  onMigrateFromBrowser?: () => Promise<{ notes: number; attachments: number; failed: number }>;
  /** 桌面端：更换库文件夹（系统目录选择框）；浏览器版不传即隐藏入口 */
  onChangeVaultFolder?: () => Promise<string | null>;
  /** 当前库文件夹（用于菜单项提示），桌面端为默认根名或用户所选绝对路径 */
  vaultDir?: string | null;
  /** 批量删除选中的笔记 */
  onRemove: (paths: string[]) => void;
  /** 列出「未被任何笔记引用」的附件（只算不删）。不提供就不显示「清理未引用的附件」 */
  onFindOrphanAttachments?: () => Promise<{ orphans: string[]; referenced: number; total: number }>;
  /** 真删这些附件（实现里只接受 `_attachments/` 下的路径），返回删失败的清单 */
  onRemoveAttachments?: (paths: string[]) => Promise<{ removed: number; failed: string[] }>;
}
/**
 * 行缩进（目录行与笔记行**共用**）：每层 14px + 统一 8px 左边距。
 * 为什么必须共用：以前目录行是 `depth*14`（第 0 层左边距为 0、箭头贴边），笔记行是 `depth*14 + 12`
 * （为箭头预留的位置）——同一层级里两种行的**名字列差 8px**（目录名 = 缩进 + 箭头 14 + 间距 6，
 * 笔记名 = 缩进 + 12），看起来就是「错位」；批量模式下还多差一个槽（见笔记行那段注释）。
 * 现在两边同一套缩进 + 同一个固定宽度的箭头槽（.tree-caret），名字列逐层对齐。
 */
const rowIndent = (depth: number) => depth * 14 + 8;

/** 虚拟滚动行高 —— 与 index.css 的 .tree-row 固定高度保持一致 */
const ROW_H = 26;
/** 视口上下各多渲染的行数 */
const OVERSCAN = 8;

const repairKindLabel: Record<string, string> = {
  'escaped-table-pipe': '表格管道符转义',
};

/**
 * 「只补不覆盖」里**冲突另存 / 内容相同跳过**两段的文案（恢复 / 导入共用，避免文案分叉）。
 * 返回的片段里，冲突另存带上文件名（前 3 个），用户能核对「另存的是哪几篇」——比只报数字可追溯得多。
 * 「新增 N 篇」由调用方自己说（恢复用 r.ok，资料导入已在别处说过，避免重复）。
 * 这些字段都是 ImportResult 上的**可选新增字段**，旧调用方（如本组件测试 mock 的 onImportMd）
 * 不返回它们时不会出现，文案自然退化，不会打印 undefined。
 */
function mergeReport(r: {
  conflictNotes?: number;
  conflictFiles?: string[];
  unchangedNotes?: number;
}): string[] {
  const parts: string[] = [];
  if (r.conflictNotes) {
    const files = r.conflictFiles ?? [];
    const names = files.slice(0, 3).join('、');
    parts.push(`冲突另存 ${r.conflictNotes} 篇（原内容未被改动）${names ? `：${names}${files.length > 3 ? ' 等' : ''}` : ''}`);
  }
  if (r.unchangedNotes) parts.push(`内容相同跳过 ${r.unchangedNotes} 篇`);
  return parts;
}

interface FlatRow {
  node: TreeNode;
  depth: number;
  open: boolean;
  /** 目录：其下笔记数（文件为 0） */
  count: number;
}

/** 单行（memo：仅当本行涉及的状态变化时才重渲染） */
const Row = memo(function Row({
  node, depth, count, currentPath, batchMode, sel, open, onOpen, onPickDir, onToggle, onDelete, onMenu,
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
  /** 单篇删除（已带确认框，见 ChapterTree.delOne） */
  onDelete: (path: string) => void;
  /** 右键唤起单篇操作菜单 */
  onMenu: (node: TreeNode, e: MouseEvent) => void;
}) {
  if (node.type === 'file') {
    const name = node.name.replace(/\.md$/, '');
    const label = batchMode
      ? `${sel ? '取消选择' : '选择'}：${name}`
      : `打开笔记：${name}`;
    return (
      // 删除键是行的**兄弟**节点而不是子节点：行本身是 role="button"，
      // 里面再套一个 button 属于嵌套可交互元素，屏幕阅读器会读乱。
      <div className="tree-row-wrap">
        <div
          className={`tree-row file ${currentPath === node.path ? 'active' : ''}`}
          style={{ paddingLeft: rowIndent(depth) }}
          onClick={() => (batchMode ? onToggle(node) : onOpen(node.path))}
          onContextMenu={(e) => {
            // 整篇笔记的鼠标入口：右键弹「打开 / 删除整篇」
            e.preventDefault();
            if (!batchMode) onMenu(node, e);
          }}
          {...clickable(label)}
        >
          {batchMode && <span className={`ck ${sel ? 'on' : ''}`}>✓</span>}
          {/* 箭头槽：笔记行没有箭头，但**无条件**留同样宽的空位——否则① 非批量时目录名比笔记名
              多出「箭头 14 + 间距 6」，② 批量时目录行有槽、笔记行没有，又差 20px。同一层级
              两种行的名字列必须落在同一列上，空槽是最省事也最稳的做法。 */}
          <span className="tree-caret" aria-hidden />
          <span className="tree-name">{name}</span>
        </div>
        {!batchMode && (
          <button
            className="tree-del"
            title={`删除笔记：${name}`}
            aria-label={`删除笔记：${name}`}
            onClick={() => onDelete(node.path)}
          >
            <IconTrash size={13} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      className="tree-row dir"
      style={{ paddingLeft: rowIndent(depth) }}
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
      {/* 固定宽度箭头槽：与笔记行的空槽同宽，所以两类行的名字列逐层对齐；
          箭头有了自己的 14px 盒子（以前是裸 <svg>，位置由「相邻文本节点怎么被合并/换行」决定，
          没有稳定的落点），行内空间再紧也是这一个盒在占位，不靠文本节点凑。 */}
      <span className="tree-caret"><IconChevron open={open} /></span>
      <span className="tree-name">{node.name}</span>
      <span className="dir-count">{count}</span>
    </div>
  );
});

export default function ChapterTree({ tree, currentPath, onOpen, onCreate, onExport, onExportFolder, onImport, onImportMd, onImportPack, onUnifiedImport, onDownloadExamplePack, onMigrateFromBrowser, onChangeVaultFolder, vaultDir, autoRepairReport, onRemove, onFindOrphanAttachments, onRemoveAttachments }: Props) {
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
  const [migrateBusy, setMigrateBusy] = useState(false);

  /** 「清理未引用的附件」是否进行中：扫描/确认/删除期间为 true，用来防连点（见 cleanOrphans） */
  const [cleanBusy, setCleanBusy] = useState(false);
  /** 本次「从备份 .json 恢复」的报告：用户刚点的动作，优先于打开库时的自动修正报告显示明细 */
  const [repairReport, setRepairReport] = useState<ImportResult | null>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const packRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  /** Anki 牌组（.apkg/.txt）与结构化数据集（.json）：与知识包同一个「隐藏 input + 菜单项」模式 */
  const ankiRef = useRef<HTMLInputElement>(null);
  const datasetRef = useRef<HTMLInputElement>(null);

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

  /**
   * 当前库里**已有**的笔记路径集合（资料侧增量导入用：导入时只补新篇，不覆盖已有笔记）。
   *
   * 为什么就地取，而不是新增 props / 让 Workspace 换个写法传进来：
   * 目录树本来就是「库里有哪些 .md」的完整镜像（core/vault.buildTree 只收 .md），
   * `allPaths` 又是按树 memo 出来的全量文件路径——需要的东西已经在手上，
   * 新增 props 只会扩散改动面（onImportMd 的签名与 Workspace 都不属于本次改动范围）。
   * 为什么用 Set：导入时每条都要问一次「这个路径在不在库里」，Set 是 O(1)。
   */
  const existingPaths = useMemo(() => new Set(allPaths), [allPaths]);

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

  /**
   * 清理未被引用的附件：**先列清单 → 用户确认 → 再删**，三步都不省。
   * 判据（以及为什么宁可少删不可误删）见 core/attachmentOrphans；这里只负责把结果说清楚：
   * 没有孤儿时明说「全部有笔记在用」，有孤儿时给出数量与前几个文件名（确认框可滚动）。
   */
  const cleanOrphans = () => {
    setMoreOpen(false);
    const find = onFindOrphanAttachments;
    const remove = onRemoveAttachments;
    // cleanBusy 既是反馈也是闸门：扫描要读全部笔记 + 题库 + 模板，几百毫秒起步；没有闸门时
    // 用户在菜单上连点两下会叠出两个确认框（删的是同一批文件），「点几次算几次」就变得说不清。
    if (!find || !remove || cleanBusy) return;
    setCleanBusy(true);
    void (async () => {
      try {
        const { orphans, referenced, total } = await find();
        if (!orphans.length) {
          toast(total ? `没有未被引用的附件（共 ${total} 个，全部有笔记在用）` : '这个库里还没有附件', 'info', 4200);
          return;
        }
        const names = orphans.slice(0, 8).map((p) => p.replace(/^_attachments\//, ''));
        const more = orphans.length > names.length ? `\n…还有 ${orphans.length - names.length} 个` : '';
        const ok = await confirmBox({
          title: `删除 ${orphans.length} 个未被引用的附件？`,
          detail: `共 ${total} 个附件，其中 ${referenced} 个仍被笔记引用（会保留）。\n将删除：\n${names.join('\n')}${more}`,
          danger: true,
          okText: '删除',
        });
        if (!ok) return;
        const r = await remove(orphans);
        if (r.failed.length) toast(`已删除 ${r.removed} 个附件，${r.failed.length} 个删除失败`, 'err', 9000);
        else toast(`已删除 ${r.removed} 个未被引用的附件`, 'ok', 4200);
      } catch (err) {
        toast(`清理失败：${(err as Error).message}`, 'err');
      } finally {
        setCleanBusy(false);
      }
    })();
  };

  /** 单篇删除：行内垃圾桶，目录里随时能有「就删这一篇」的入口。 */
  const delOne = useCallback((path: string) => {
    const name = path.replace(/\.md$/, '').split('/').pop() ?? path;
    void confirmBox({
      title: `删除「${name}」？`,
      detail: '笔记将从知识库中移除；最近的历史快照仍可在「历史版本」中找回。',
      danger: true,
      okText: '删除',
    }).then((ok) => {
      if (ok) onRemove([path]);
    });
  }, [onRemove]);

  // ---------- 整篇笔记的右键菜单 ----------
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const onMenu = useCallback((node: TreeNode, e: MouseEvent) => {
    setMenu({ x: e.clientX, y: e.clientY, path: node.path, name: node.name.replace(/\.md$/, '') });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      // 点在菜单自己身上不算「点外面」：否则 pointerdown 先把菜单关掉，
      // 随后的 click 落在一个已卸载的按钮上，点了等于没点。
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const blur = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [menu]);

  // Esc 关菜单：接进全局 Esc 栈，和其它面板一样「一次只退一层」
  useEsc(() => setMenu(null), menu !== null);

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

  /**
   * 读取选中的 md 文件夹（webkitRelativePath 去顶层目录）并入库。
   *
   * 这条通道也走**只补不覆盖**（onImportMd → vault.importMdFiles 现在按路径三分类）：
   * 库里已存在的笔记不再被整目录回灌覆盖——内容不同就另存到「导入冲突/」、相同则跳过。
   * 旧语义「同名覆盖」正是用户明说要避免的（覆盖写不推历史快照、覆盖后不可恢复）。
   */
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
      const r = await onImportMd(list);
      const parts = [`新增 ${r.ok} 篇`, ...mergeReport(r)];
      const tail = `${r.repaired ? `，修正 ${r.repaired} 处格式` : ''}`;
      if (r.failed) toast(`导入 md 文件夹：${parts.join('，')}${tail}；另有 ${r.failed} 篇写入失败（存储空间可能不足）`, 'err', 9000);
      else toast(`导入 md 文件夹：${parts.join('，')}${tail}`, 'ok', 9000);
      setRepairReport(r);
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

  /** 导出 md 文件夹：先收起菜单，再等导出完成并回报篇数。
   *  打包失败（jszip 动态 import 拉不下来、几千篇超时等）必须报出来，否则按钮看着像没生效。 */
  const exportFolder = async () => {
    setMoreOpen(false);
    try {
      const n = await onExportFolder();
      toast(`已导出 ${n} 篇笔记为 md 文件夹(.zip)，可直接用 Obsidian 打开`, 'ok');
    } catch (err) {
      toast(`导出失败：${(err as Error).message}`, 'err');
    }
  };

  /** 导入知识包：逐条把跳过原因报出来（静默丢弃是最糟的反馈——用户不知道少了什么） */
  const onPackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onImportPack) return;
    try {
      const text = await file.text();
      const r = await onImportPack(text);
      // 再说清"这是什么包"（名称/篇数/体积/作者/许可）。这里自己解析一次、而不是让
      // onImportPack 回传摘要：多一次 JSON.parse 只发生在用户点导入的这一下，
      // 换来的是这句话不依赖上层实现。与对标产品把目录清单（manifest）显示给用户同一个目的。
      let summary = '知识包';
      try {
        // 用文件自身的字节数报体积：调用点已经有 text 了，不必让 packSummary 再 stringify 一遍
        summary = packSummary(parseKnowledgePack(text), text.length);
      } catch {
        // 格式问题已由 onImportPack 报过错了；这里只是拿不到摘要，不再重复报错
      }
      if (r.skipped.length === 0) {
        toast(`${summary} 导入完成：新增 ${r.created} 篇笔记。`, 'ok', 4200);
      } else {
        const head = r.skipped
          .slice(0, 3)
          .map((s) => `${s.title || s.path}（${s.reason}）`)
          .join('、');
        toast(`${summary}：新增 ${r.created} 篇，跳过 ${r.skipped.length} 篇 — ${head}${r.skipped.length > 3 ? ' 等' : ''}`, 'info', 6000);
      }
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err');
    }
  };

  /**
   * 写盘并回报：把「导入通道」产出的文件交给**既有的** onImportMd
   * （Workspace 传进来的 vault.importMdFiles —— 格式修正、逐篇写入失败回报都在那条通道里）。
   * 为什么不另开一条写盘通道：另起一套必然与「笔记树导入」分叉——「从 A 入口进来的能抽查、
   * 从 B 入口进来的不能」这类不一致事后极难解释。
   * 跳过原因**必须报出来**（静默丢弃是本项目最忌讳的失败形态，见上面 onPackFile 的注释）。
   *
   * **资料侧增量导入（O3）**：交出去之前先拿 existingPaths 过一道 skipExistingNotes，
   * **资料侧增量导入（O3）**：交出去之前先拿 existingPaths 过一道 skipExistingNotes，
   * 库里已有同名路径的篇目**不进** onImportMd——这是第一步过滤。**兜底**在 onImportMd 那一侧：
   * vault.importMdFiles 现在也是「只补不覆盖」——路径已存在且内容不同就另存到「导入冲突/」、
   * 完全相同则跳过，写前不再无条件覆盖（storage/web.ts 的 writeMany 直接 db.put、不推历史快照，
   * 此前把整包交过去等于覆盖掉用户改过的笔记且不可恢复）。两道防线一起保证「同一份资料再导一遍」
   * 既不覆盖、也不出现「看着成功、其实一篇没写」。现在只补新篇，并一次报出「新增 / 已存在 / 冲突另存」。
   */
  const writeImported = async <T extends ImportToVaultResult>(
    // label 可以是字符串（Anki 的 sourceNote），也可以是**由本次实际结果生成的文案函数**：
    // 数据集要走 datasetSummary 说清「识别成什么」。为什么允许函数——它里面的「可导入 N 篇」
    // 必须按增量过滤**之后**的篇数说，否则同一句 toast 里会同时出现「可导入 2 篇」和「新增 0 篇」
    // 两句互相打脸的话（用户只会得出「这软件自己都说不清」的结论）。
    label: string | ((res: T) => string),
    res: T,
  ): Promise<void> => {
    const filtered = skipExistingNotes(res, existingPaths);
    const text = typeof label === 'function' ? label(filtered) : label;
    const r = await onImportMd(filtered.files);
    const existing = filtered.existingSkipped ?? 0;
    // 写入失败的篇数一并计入「跳过」：它们同样没进库，用户必须看到
    const skipped = res.skipped.length + r.failed;
    // 兜底层（importMdFiles）判出的冲突另存 / 内容相同跳过也是用户必须看到的真实结果，
    // 所以它们为 0 才算「没有别的话要说」，走那句最简的成功提示。
    const mergeExtra = mergeReport(r);
    if (existing === 0 && skipped === 0 && mergeExtra.length === 0) {
      toast(`${text}：新增 ${r.ok} 篇笔记。`, 'ok', 4200);
      return;
    }
    const parts = [`新增 ${r.ok} 篇`];
    if (existing) {
      // 只说「已存在 3 篇」用户没法核对是哪几篇，所以把名字一并带上（名字从 skipped 里按
      // 共用原因常量挑出来，不在这里再判一次「算不算已存在」——两处判定迟早会漂移）。
      const names = filtered.skipped
        .filter((s) => s.reason === EXISTING_NOTE_REASON)
        .map((s) => s.title);
      parts.push(
        `已存在 ${existing} 篇（增量导入跳过，未覆盖你的内容：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}）`,
      );
    }
    // 冲突另存 / 内容相同跳过：importMdFiles 兜底层判出来的也一并报出，绝不静默
    for (const part of mergeExtra) parts.push(part);
    if (skipped) parts.push(`跳过 ${skipped} 篇`);
    const head = res.skipped
      .slice(0, 3)
      .map((s) => `${s.title}（${s.reason}）`)
      .join('、');
    const tail = head ? ` — ${head}${res.skipped.length > 3 ? ' 等' : ''}` : '';
    // 配色按「是否真的出错」定，而不是「有没有新增」：重复导入同一份资料时新增 0 篇是**预期结果**，
    // 亮红灯会让用户以为导入失败了。只有真出了别的跳过/写失败（skipped > 0）且一篇没写才报错。
    toast(`${text}：${parts.join('，')}${tail}`, r.ok > 0 || skipped === 0 ? 'info' : 'err', 9000);
  };

  /**
   * 导入 Anki 牌组 → **笔记**（不是题库，理由见 core/ankiImport 开头的三条取舍）。
   * .apkg 是 SQLite 二进制包，读字节走 readApkg；Anki「导出为 .txt」是制表符文本，走 readAnkiTsv。
   * 两条路汇成同一个 ApkgContent，再由**唯一**的 apkgToVaultFiles 落成笔记：
   * 写盘、已存在的篇目跳过（见 writeImported）、标签里的 `章节:` 解析都只有一套，
   * 不会因为入口不同而分叉。
   */
  const onAnkiFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 先清空：同一个文件再选一次也要能触发 change
    if (!file) return;
    try {
      const content = /\.(txt|tsv)$/i.test(file.name)
        ? readAnkiTsv(await file.text())
        : await readApkg(new Uint8Array(await file.arrayBuffer()));
      if (content.notes.length === 0) {
        // 一条都没读到：apkgSummary 的这句话已经说清「请确认导出方式」，原样报给用户
        toast(`导入失败：${apkgSummary(content)}`, 'err', 10000);
        return;
      }
      // source 由「识别出的形状 + 文件名」组成：笔记一旦进库就会被复习、导出、分享，
      // 「这份资料从哪来」必须跟着笔记走（版权预防措施，不能省）。
      const shape = content.modelNames.filter(Boolean).join('、') || '未知模型';
      const sourceNote = `Anki 导入（${shape}，来自 ${file.name}）`;
      await writeImported(sourceNote, apkgToVaultFiles(content, { sourceNote }));
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err', 9000);
    }
  };

  /**
   * 导入结构化数据集（症状→疾病 / 口诀 / 术语表）→ **笔记**。
   * 识别不出来时**不猜**：把 detectDataset 给出的 evidence（缺哪些字段）原样报给用户，
   * 让他能回去核对文件或反馈给我们适配——猜着导入会把无关 JSON 变成一堆空笔记。
   */
  const onDatasetFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const det = detectDataset(raw);
      if (det.kind === 'unknown') {
        toast(`数据集导入：未能识别这份文件（${det.evidence.join('；')}）。原始文件没有被修改。`, 'err', 12000);
        return;
      }
      const sourceNote = `数据集导入（${DATASET_KIND_LABEL[det.kind]}，来自 ${file.name}）`;
      const res = datasetToVaultFiles(raw, { sourceNote });
      // 提示文案用 datasetSummary 生成：它把「识别成什么 / 可导入多少 / 跳过多少 / 来源」一次说全。
      // 传的是**函数**而不是先用 res 拼好的字符串：增量导入时「可导入 N 篇」必须按过滤后的篇数说，
      // 否则会出现「可导入 2 篇」紧跟「新增 0 篇」这种自相矛盾的提示（详见 writeImported 注释）。
      await writeImported((r) => datasetSummary(r, sourceNote), res);
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err', 9000);
    }
  };

  /** 要展示的修正明细：本次恢复导入的报告优先（用户刚点的，带上下文），
   *  否则显示打开库时自动修正的报告（vault 只在真的改动了什么时才给）。 */
  const repairReportShown = repairReport ?? autoRepairReport ?? null;

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
                <div onClick={() => { setMoreOpen(false); void onExport().catch((err: unknown) => toast(`备份失败：${(err as Error).message}`, 'err')); }} {...clickable()}>
                  <IconBackup /> 备份到 .json
                </div>
                <div onClick={() => void exportFolder()} {...clickable()}>
                  <IconFolder /> 导出 md 文件夹 (.zip)
                </div>
                {onUnifiedImport ? (
                  /* 统一入口：把下面四个分门别类的导入收敛成一条。点开后由 ImportView 自动识别
                     格式（笔记备份 / 知识包 / 题库 / 数据集 / Anki / Word·PDF / Excel）并批量处理。 */
                  <div
                    onClick={() => { setMoreOpen(false); onUnifiedImport(); }}
                    {...clickable('一个入口导入所有资料：自动识别笔记 / 题库 / Anki 牌组 / 数据集 / 知识包 / 备份 / Word·PDF / Excel，支持多选与拖拽批量处理')}
                  >
                    {/* 只留动作名，不列扩展名：那串（.md / .json / .apkg / …）会把菜单顶得比侧栏宽
                        （实测菜单 417px vs 侧栏 263px → 被裁到只剩一行尾巴）。完整清单在导入面板里
                        和「无法识别的文件格式（支持 …）」的提示里都有，菜单项不必再占一行。 */}
                    <IconRestore /> 导入笔记
                  </div>
                ) : (
                  <>
                    <div onClick={() => { jsonRef.current?.click(); setMoreOpen(false); }} {...clickable()}>
                      <IconRestore /> 从备份 .json 恢复
                    </div>
                    {onImportPack && (
                      <div
                        onClick={() => { packRef.current?.click(); setMoreOpen(false); }}
                        {...clickable('导入别人分享的知识包（.json）。同名笔记会被跳过，不会覆盖你自己的内容')}
                      >
                        <IconRestore /> 导入知识包 (.json)
                      </div>
                    )}
                    {/* 两个新入口排在「导入知识包」之后：都属于「导入外来资料 → 落成笔记」这一组，
                        落盘走同一条 onImportMd 通道（见 writeImported），用户不必记两套后果。 */}
                    <div
                      onClick={() => { ankiRef.current?.click(); setMoreOpen(false); }}
                      {...clickable('把 Anki 里的存量卡读进来（.apkg = Anki 导出的牌组包；.txt = Anki「导出为 .txt」的制表符文件）。落成笔记，重名的跳过、不会覆盖你自己的内容')}
                    >
                      <IconRestore /> 导入 Anki 牌组 (.apkg/.txt)
                    </div>
                    <div
                      onClick={() => { datasetRef.current?.click(); setMoreOpen(false); }}
                      {...clickable('导入结构化数据集（.json）：症状→疾病对照 / 口诀·记忆术 / 术语表。识别不出类型时不会导入，并告诉你缺哪些字段')}
                    >
                      <IconRestore /> 导入数据集 (.json)
                    </div>
                  </>
                )}
                {onDownloadExamplePack && (
                  <div
                    onClick={() => { setMoreOpen(false); onDownloadExamplePack(); }}
                    {...clickable('下载一份示例知识包：演示知识包格式与 {{挖空}} 用法，可先导入看看效果')}
                  >
                    <IconBackup /> 下载示例知识包
                  </div>
                )}
                {onMigrateFromBrowser && (
                  <div
                    onClick={() => {
                      if (migrateBusy || !onMigrateFromBrowser) return;
                      setMoreOpen(false);
                      setMigrateBusy(true);
                      void onMigrateFromBrowser()
                        .then((r) => {
                          if (r.failed) toast(`迁移完成：${r.notes} 篇笔记、${r.attachments} 个附件已写入，${r.failed} 项失败`, 'err');
                          else if (r.notes || r.attachments) toast(`已把 ${r.notes} 篇笔记、${r.attachments} 个附件写入「文档/KnowLattice」`, 'ok', 4200);
                          else toast('没有可迁移的浏览器数据', 'info');
                        })
                        .catch((err: unknown) => toast(`迁移失败：${(err as Error).message}`, 'err'))
                        .finally(() => setMigrateBusy(false));
                    }}
                    {...clickable(migrateBusy ? '正在迁移' : '把浏览器里已有的笔记/附件写入本机文件夹（文档/KnowLattice）')}
                  >
                    <IconFolder /> {migrateBusy ? '正在迁移…' : '迁移浏览器数据到本机文件夹'}
                  </div>
                )}
                {onChangeVaultFolder && (
                  <div
                    onClick={() => {
                      setMoreOpen(false);
                      void onChangeVaultFolder()
                        .then((dir) => { if (dir) toast(`库文件夹已切换：${dir}`, 'ok', 4200); })
                        .catch((err: unknown) => toast(`切换库文件夹失败：${(err as Error).message}`, 'err'));
                    }}
                    {...clickable()}
                    title={vaultDir ? `当前：${vaultDir}` : undefined}
                  >
                    <IconFolder /> 更换库文件夹…
                  </div>
                )}
                {/* 传了 onUnifiedImport 时这一条也并进统一入口：统一面板本身就能「导入整个文件夹（.md）」，
                    留一条平行的文件夹入口等于让用户再选一次「我这个 md 该走哪个按钮」——正是要消掉的分叉。
                    不传时保留原入口（向后兼容）。 */}
                {!onUnifiedImport && (
                  <div onClick={() => { folderRef.current?.click(); setMoreOpen(false); }} {...clickable()}>
                    <IconFolderIn /> 导入 md 文件夹
                  </div>
                )}
                {/* 清理未引用的附件：不改「删笔记」的语义，只是把已经没人引用的附件列出来，
                    用户确认后再删（判据见 core/attachmentOrphans）。排在「批量删除」之前——
                    它是这一组里唯一的破坏性操作，而清理有确认框、且正文一个字都不动。 */}
                {onFindOrphanAttachments && onRemoveAttachments && (
                  <div onClick={cleanOrphans} {...clickable(cleanBusy ? '正在扫描未引用的附件…' : '列出没有任何笔记引用的附件，确认后删除（只删附件，正文不动）')}>
                    <IconTrash /> {cleanBusy ? '清理中…' : '清理未引用的附件…'}
                  </div>
                )}
                {/* 批量删除排最后：它是这一组里唯一的破坏性操作，前面全是备份/导出/导入
                    这类日常数据操作，从上往下扫过去不会误点。 */}
                <div className="menu-danger" onClick={() => { setBatchMode((v) => !v); setSelected(new Set()); setMoreOpen(false); }} {...clickable()}>
                  <IconBatch /> {batchMode ? '批量删除（进行中 · 点此退出）' : '批量删除'}
                </div>
              </div>
            )}
          </div>
          <input
            ref={packRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => void onPackFile(e)}
          />
          <input
            ref={ankiRef}
            type="file"
            accept=".apkg,.txt,.tsv"
            hidden
            onChange={(e) => void onAnkiFile(e)}
          />
          <input
            ref={datasetRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void onDatasetFile(e)}
          />
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
                  const r = await onImport(reader.result as string);
                  // 「只补不覆盖」后不会再覆盖任何现有文件：说清新增 / 冲突另存 / 内容相同跳过三段，
                  // 冲突另存的篇目把文件名列出来（前 3 个）供用户核对。
                  const parts = [`新增 ${r.ok} 篇`, ...mergeReport(r)];
                  const tail = r.repaired ? `，修正 ${r.repaired} 处格式` : '';
                  const base = parts.join('，');
                  if (r.failed) {
                    toast(`恢复：${base}${tail}；另有 ${r.failed} 篇写入失败——这几篇没有进库，请确认存储空间后重新导入`, 'err', 9000);
                  } else {
                    toast(`恢复完成：${base}${tail}（题库 / 复习进度等也已按「只补新键」合并）`, 'ok', 9000);
                  }
                  setRepairReport(r);
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
          {repairReportShown && (repairReportShown.repairedFiles?.length ?? 0) > 0 && (
            <details className="markdown-repair-report">
              <summary>{repairReport ? '查看本次修正明细' : '打开库时已自动修正格式'}（{repairReportShown.repairedFiles?.length ?? 0} 篇）</summary>
              <ul>
                {(repairReportShown.repairedFiles ?? []).map((file) => (
                  <li key={file.path}>{file.path}：{file.changes.map((change) => `${repairKindLabel[change.kind] ?? change.kind} ×${change.count}`).join('、')}</li>
                ))}
              </ul>
            </details>
          )}
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
        onScroll={(e) => { setScrollTop((e.target as HTMLDivElement).scrollTop); setMenu(null); }}
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
                onDelete={delOne}
                onMenu={onMenu}
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
      {menu && (
        // 整篇笔记的鼠标入口（用户反馈：目录里只能找到「批量删除」）。
        // 样式复用编辑器右键菜单那套 .cm-ctx-menu，两处菜单长得一样。
        <div
          className="cm-ctx-menu"
          ref={menuRef}
          role="menu"
          aria-label={`笔记操作：${menu.name}`}
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="cm-ctx-item"
            role="menuitem"
            onClick={() => { onOpen(menu.path); setMenu(null); }}
          >
            打开笔记
          </button>
          <button
            className="cm-ctx-item danger"
            role="menuitem"
            onClick={() => { delOne(menu.path); setMenu(null); }}
          >
            <span><IconTrash size={13} /> 删除整篇笔记</span>
          </button>
        </div>
      )}
    </aside>
  );
}
