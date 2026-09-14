/**
 * Vault 核心：文件树 + 内存文档缓存 + 保存/新建。
 * 通过 StorageAdapter 与底层存储解耦（web = IndexedDB / tauri = fs）。
 *
 * 性能设计（5227 篇量级）：
 * - 启动：adapter.readAll() 单遍读出全部内容（IndexedDB getAll 本就反序列化整条记录）。
 * - 保存：乐观更新内存 + 链接索引单篇增量更新；依赖 docs 身份的消费者自然重算，
 *   不再全库重建 tree/linkIndex/搜索索引。
 * - frontmatter 解析走 parser.ts 模块级缓存（内容引用未变直接命中），nameIndex/allLinkNames 共享。
 * - 索引遍历一律只处理 .md；附件（_attachments/*）以 Blob 形式存独立 attachments store，
 *   不进 docs Map，也不进任何索引。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StorageAdapter } from '../storage/adapter';
import { WebAdapter } from '../storage/web';
import { parseFrontmatterCached } from './parser';
import { rebuildLinkIndex, updateLinksForPath, backlinks, type LinkIndex } from './linkIndex';
import { exportSrsState, importSrsState } from './srs';
import { exportQbanks, importQbanks } from './qbank';
import { loadMistakes, importMistakes } from './mistakes';
import { pushSnapshot } from './history';

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

/** 从扁平路径列表构建目录树 */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const p of [...paths].filter((p) => p.endsWith('.md')).sort()) {
    const parts = p.split('/');
    let level = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === parts[i]);
      if (!node) {
        node = {
          name: parts[i],
          path: acc,
          type: isFile ? 'file' : 'dir',
          children: isFile ? undefined : [],
        };
        level.push(node);
      }
      if (!isFile) level = node.children!;
    }
  }
  // 目录在前、文件在后
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1
    );
    nodes.forEach((n) => n.children && sortRec(n.children));
  };
  sortRec(root);
  return root;
}

const adapter: StorageAdapter = new WebAdapter();

/** IndexedDB 并发写入分批大小 */
const WRITE_BATCH = 100;

/** 批量并行写入（IndexedDB 支持并发事务，但浏览器对并发事务数有限制，分批避免打爆） */
async function writeMany(entries: Array<{ path: string; content: string }>): Promise<void> {
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const chunk = entries.slice(i, i + WRITE_BATCH);
    await Promise.allSettled(chunk.map((f) => adapter.write(f.path, f.content)));
  }
}

/** 批量并行删除：与 writeMany 同理，分批限流 */
async function removeManyFiles(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += WRITE_BATCH) {
    const chunk = paths.slice(i, i + WRITE_BATCH);
    await Promise.allSettled(chunk.map((p) => adapter.remove(p)));
  }
}

/** 旧版 dataURL 附件 → Blob（启动迁移与旧备份导入共用） */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const isBase64 = m[2] === ';base64';
  const body = m[3];
  try {
    if (isBase64) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch {
    return null;
  }
}

/** frontmatter 解析走 parser.ts 模块级缓存（与 React 渲染无关）：content 引用未变即命中 */
const getMeta = parseFrontmatterCached;

/** 首次使用引导笔记：空库自动创建（只建一次，删除后不再重生） */
const ONBOARD_PATH = '00-三分钟上手.md';
const ONBOARD_FLAG = 'medvault-onboarded';
const ONBOARD_CONTENT = `---
aliases: [新手指南]
tags: [指南]
chapter: 指南
source: 内置
created: ${new Date().toISOString().slice(0, 10)}
---

# 三分钟上手

欢迎使用晶格！这篇笔记教你写原子笔记的全部语法——只有三个动作。

## 三个动作

- 回车: 换行自动续写下一条，不用输任何符号
	- 按 Tab 缩进一层，就是子要点（就像现在这行）
	- 按 Shift+Tab 反缩进回来
- [[双链: 输入两个左中括号会弹出笔记名补全，选中即可连接
	- 双链把知识连成网，去左侧「知识图谱」看效果
- 属性: 冒号开头的行会被自动加粗，比如「机制」「口诀」

## 编辑器工具栏

- 编辑区顶部有一排小按钮：加粗、列表、缩进、双链、口诀
- 鼠标悬停可看说明；熟悉后直接用键盘更快

## 试试看

- 新建: 点左上角 ＋，先选一个类型（疾病/机制/概念…），骨架自动生成，你只需要填空
- 练习: 左下角「题库练习」导入题库刷题，答错自动进错题本
- 复习: 左上角卡片图标进入间隔复习，遗忘曲线帮你安排

## 下一步

- 删除本篇: 顶部工具栏的垃圾桶图标
- 数据都在本机浏览器里，「备份」图标可导出 .json 随身携带
`;

export function useVault() {
  const [docs, setDocs] = useState<Map<string, string>>(new Map());
  /** 二进制附件：path → Blob（与笔记分库，避免保存时整库拷贝大图片） */
  const [attachments, setAttachments] = useState<Map<string, Blob>>(new Map());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 链接索引：state 持有（替换 ref，规避 render 期访问 ref）。日常保存就地增量更新
   *  （updateLinksForPath），依赖 docs/索引身份的消费者（图谱、反链）随 docs 变化重算。 */
  const [linkIndex, setLinkIndex] = useState<LinkIndex>(() => ({ outgoing: new Map(), incoming: new Map() }));
  /** Blob 对象 URL 缓存：同一附件只 createObjectURL 一次 */
  const attachmentUrlCache = useRef(new Map<string, string>());

  useEffect(() => {
    (async () => {
      // 单遍读出全部笔记与附件；空库首次使用自动创建引导笔记
      const fileMap = await adapter.readAll();
      const attachmentMap = await adapter.readAllAttachments();

      // 迁移旧版（v1）把 dataURL 附件塞在 files store 里的数据：转为 Blob 放 attachments store
      const legacyMoved: Array<{ path: string; blob: Blob }> = [];
      for (const [p, content] of fileMap) {
        if (!p.startsWith('_attachments/')) continue;
        const blob = dataUrlToBlob(content);
        if (blob) {
          legacyMoved.push({ path: p, blob });
          attachmentMap.set(p, blob);
          fileMap.delete(p);
        }
        // 转换失败的旧数据暂时留在 docs 里，readFile 仍可当 dataURL 渲染，避免丢图
      }
      for (const a of legacyMoved) {
        await adapter.writeAttachment(a.path, a.blob).catch(() => {});
        await adapter.remove(a.path).catch(() => {});
      }

      const hasNote = [...fileMap.keys()].some((p) => p.endsWith('.md'));
      if (!hasNote && !localStorage.getItem(ONBOARD_FLAG)) {
        await adapter.write(ONBOARD_PATH, ONBOARD_CONTENT);
        fileMap.set(ONBOARD_PATH, ONBOARD_CONTENT);
        localStorage.setItem(ONBOARD_FLAG, '1');
      }
      setLinkIndex(rebuildLinkIndex(fileMap));
      setDocs(fileMap);
      setAttachments(attachmentMap);
      setLoaded(true);
    })().catch((e) => {
      console.error('加载知识库失败：', e);
      setLoaded(true); // 即使失败也放行进入，保证应用可操作
    });
  }, []);

  /** 保存：乐观更新内存（UI 即时生效），落盘异步进行；落盘后异步推入历史快照（fire-and-forget） */
  const save = useCallback(async (path: string, content: string) => {
    setDocs((prev) => new Map(prev).set(path, content));
    updateLinksForPath(linkIndex, path, content);
    try {
      await adapter.write(path, content);
      void pushSnapshot(path, content);
    } catch (e) {
      console.error('保存失败：', path, e);
    }
  }, [linkIndex]);

  const remove = useCallback(async (path: string) => {
    setDocs((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    updateLinksForPath(linkIndex, path, '');
    try {
      await adapter.remove(path);
    } catch (e) {
      console.error('删除失败：', path, e);
    }
    setCurrentPath((cur) => (cur === path ? null : cur));
  }, [linkIndex]);

  /** 批量删除：先乐观更新 UI，落盘分批限流（避免一次发几千个 IndexedDB 事务） */
  const removeMany = useCallback(async (paths: string[]) => {
    const del = new Set(paths);
    setDocs((prev) => {
      const next = new Map(prev);
      for (const p of del) next.delete(p);
      return next;
    });
    for (const p of del) updateLinksForPath(linkIndex, p, '');
    setCurrentPath((cur) => (cur && del.has(cur) ? null : cur));
    await removeManyFiles([...del]);
  }, [linkIndex]);

  /** 导出全部笔记为单个 .json 备份文件（直接用内存缓存；新附件库不并入 JSON，
   *  旧版残留的 dataURL 附件仍随 files 字段导出以保证不丢数据） */
  const exportAll = useCallback(async () => {
    const files = [...docs]
      .filter(([path]) => path.endsWith('.md') || path.startsWith('_attachments/'))
      .map(([path, content]) => ({ path, content }));
    const payload = {
      app: 'medvault',
      version: 2,
      exportedAt: new Date().toISOString(),
      files,
      // v2 起随备份保存 SRS 复习调度进度（旧版备份无此字段，导入时自动跳过）
      srs: exportSrsState(),
      // 题库与错题一并备份（v2 增量字段，旧版本导入时忽略）
      qbanks: exportQbanks(),
      mistakes: loadMistakes(),
    };
    const blob = new Blob([JSON.stringify(payload)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lattice-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [docs]);

  /** 从备份 .json 恢复（合并模式：同名路径覆盖，其余保留）；笔记/复习进度/题库/错题一并恢复。
   *  旧版备份里的 dataURL 附件会自动转回 Blob 附件库；恢复后直接并入内存缓存，不再全库重读存储。 */
  const importBackup = useCallback(async (text: string): Promise<number> => {
    const data = JSON.parse(text) as {
      app?: string;
      version?: number;
      files?: { path: string; content: string }[];
      srs?: unknown;
      qbanks?: unknown;
      mistakes?: unknown;
    };
    if (data.app !== 'medvault' || !Array.isArray(data.files)) {
      throw new Error('不是有效的 晶格 备份文件');
    }
    const valid = data.files.filter((f) => f.path && typeof f.content === 'string');
    const notes = valid.filter((f) => !f.path.startsWith('_attachments/'));
    const legacyAttachments = valid.filter((f) => f.path.startsWith('_attachments/'));

    await writeMany(notes);
    const restoredAttachments = new Map<string, Blob>();
    for (const f of legacyAttachments) {
      const blob = dataUrlToBlob(f.content);
      if (blob) {
        await adapter.writeAttachment(f.path, blob).catch(() => {});
        restoredAttachments.set(f.path, blob);
      } else {
        // 旧数据无法转 Blob 时按原文保留为笔记文件，至少不丢数据
        await adapter.write(f.path, f.content).catch(() => {});
      }
    }
    if (data.srs) importSrsState(data.srs);
    if (data.qbanks) importQbanks(data.qbanks);
    if (data.mistakes) importMistakes(data.mistakes);

    // 并入内存缓存 + 增量更新链接索引
    setDocs((prev) => {
      const next = new Map(prev);
      for (const f of notes) next.set(f.path, f.content);
      for (const f of legacyAttachments) {
        if (!restoredAttachments.has(f.path)) next.set(f.path, f.content);
      }
      return next;
    });
    setAttachments((prev) => {
      const next = new Map(prev);
      for (const [path, blob] of restoredAttachments) next.set(path, blob);
      return next;
    });
    for (const f of notes) updateLinksForPath(linkIndex, f.path, f.content);
    return notes.length;
  }, [linkIndex]);

  /** 导入 md 文件夹（相对路径入库，保留目录结构）；返回导入篇数 */
  const importMdFiles = useCallback(async (files: Array<{ path: string; content: string }>): Promise<number> => {
    const valid: Array<{ path: string; content: string }> = [];
    for (const f of files) {
      const p = f.path.replace(/\\/g, '/');
      if (!p.toLowerCase().endsWith('.md') || !p.trim()) continue;
      valid.push({ path: p, content: f.content });
    }
    await writeMany(valid);
    setDocs((prev) => {
      const next = new Map(prev);
      for (const f of valid) next.set(f.path, f.content);
      return next;
    });
    for (const f of valid) updateLinksForPath(linkIndex, f.path, f.content);
    return valid.length;
  }, [linkIndex]);

  /** 保存图片附件（Blob 存入独立 attachments store），返回 vault 相对路径 */
  const saveAttachment = useCallback(async (filename: string, blob: Blob): Promise<string> => {
    const path = `_attachments/${filename}`;
    setAttachments((prev) => new Map(prev).set(path, blob));
    try {
      await adapter.writeAttachment(path, blob);
    } catch (e) {
      console.error('附件保存失败：', path, e);
    }
    return path;
  }, []);

  /** 新建笔记走模板，自动填 chapter/frontmatter（M1 验收项） */
  const createNote = useCallback(
    async (dir: string, title: string, template: string) => {
      const path = dir ? `${dir}/${title}.md` : `${title}.md`;
      if (docs.has(path)) throw new Error('同名笔记已存在');
      await save(path, template);
      setCurrentPath(path);
      return path;
    },
    [docs, save]
  );

  const tree = useMemo(() => buildTree([...docs.keys()]), [docs]);

  /** 名称 → 路径 索引（文件名 / 一级标题 / alias，小写）。构建一次，之后 O(1) 解析；
   *  解析结果走 metaCache，内容未变的篇目零成本。仅 .md 参与。 */
  const nameIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const [path, content] of docs) {
      if (!path.endsWith('.md')) continue;
      const base = path.replace(/\.md$/, '');
      const fileName = base.split('/').pop()!;
      if (!map.has(fileName.toLowerCase())) map.set(fileName.toLowerCase(), path);
      const { title, meta } = getMeta(path, content);
      if (title && !map.has(title.toLowerCase())) map.set(title.toLowerCase(), path);
      for (const a of meta.aliases) {
        if (a && !map.has(a.toLowerCase())) map.set(a.toLowerCase(), path);
      }
    }
    return map;
  }, [docs]);

  /** 名称 -> 路径 解析：文件名 / 一级标题 / alias 都能命中（不区分大小写） */
  const resolveLink = useCallback(
    (name: string): string | null => {
      const key = name.trim().toLowerCase();
      if (!key) return null;
      return nameIndex.get(key) ?? null;
    },
    [nameIndex]
  );

  /** vault 路径 → 可渲染内容：.md 返回文本，附件返回 Blob 对象 URL（惰性创建并缓存） */
  const readFile = useCallback(
    (path: string): string | undefined => {
      const text = docs.get(path);
      if (text !== undefined) return text;
      const blob = attachments.get(path);
      if (!blob) return undefined;
      let url = attachmentUrlCache.current.get(path);
      if (!url) {
        url = URL.createObjectURL(blob);
        attachmentUrlCache.current.set(path, url);
      }
      return url;
    },
    [docs, attachments]
  );

  /** 导出为 md 文件夹(.zip)：真实 Markdown 目录结构，可直接用 Obsidian/记事本打开（数据永不锁定） */
  const exportMdFolder = useCallback(async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    let count = 0;
    for (const [path, content] of docs) {
      if (path.endsWith('.md')) {
        zip.file(path, content);
        count++;
      } else if (path.startsWith('_attachments/')) {
        // 旧版残留的 dataURL 附件：保留原样导出，防止丢图
        zip.file(`${path}.dataurl.txt`, content);
      }
    }
    for (const [path, blob] of attachments) {
      // 新附件库：以真实二进制导出，图片可直接打开
      zip.file(path, blob);
    }
    zip.file(
      'README.md',
      `# 晶格 · KnowLattice 导出\n\n- 导出时间：${new Date().toLocaleString()}\n- 笔记数：${count} 篇\n- [[双链]]、frontmatter、目录结构均保留，可直接用 Obsidian 打开本文件夹\n\n> 纯 Markdown 存储，软件停更后数据依然可用。\n`
    );
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lattice-vault-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    return count;
  }, [docs, attachments]);

  /** 所有可用链接名（文件名 + 标题 + alias 去重），供 [[ 自动补全。仅 .md 参与。 */
  const allLinkNames = useMemo(() => {
    const names = new Set<string>();
    for (const [path, content] of docs) {
      if (!path.endsWith('.md')) continue;
      names.add(path.replace(/\.md$/, '').split('/').pop()!);
      const { title, meta } = getMeta(path, content);
      if (title) names.add(title);
      meta.aliases.forEach((a) => names.add(a));
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [docs]);

  const currentContent = currentPath ? docs.get(currentPath) ?? '' : null;

  const currentBacklinks = useMemo(() => {
    if (!currentPath) return [];
    const content = docs.get(currentPath) ?? '';
    if (!content) return [];
    const { title } = getMeta(currentPath, content);
    const name = title || currentPath.replace(/\.md$/, '').split('/').pop()!;
    return backlinks(linkIndex, name);
    // docs 变化即重算：保存/删除他人笔记改变了 incoming 时，这里也要刷新
  }, [currentPath, docs, linkIndex]);

  return {
    loaded,
    docs,
    tree,
    linkIndex,
    currentPath,
    setCurrentPath,
    currentContent,
    currentBacklinks,
    resolveLink,
    allLinkNames,
    save,
    remove,
    removeMany,
    createNote,
    saveAttachment,
    readFile,
    exportAll,
    exportMdFolder,
    importBackup,
    importMdFiles,
    adapter,
  };
}
