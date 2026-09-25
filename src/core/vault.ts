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
import { exportQuestionStats, importQuestionStats } from './qbankStats';
import { loadMistakes, importMistakes } from './mistakes';
import { exportTodos, importTodos } from './todos';
import { exportCardEdits, importCardEdits } from './cardEdits';
import { exportDays, importDays } from './stats';
import { exportPomodoros, importPomodoros } from './pomodoro';
import { pushSnapshot } from './history';
import { repairMarkdown, type MarkdownRepairChange } from './markdownRepair';
import { exportPathwayTemplates, importPathwayTemplates } from './pathwayTemplates';

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

export interface MarkdownRepairFile {
  path: string;
  changes: MarkdownRepairChange[];
}

export interface ImportResult {
  ok: number;
  failed: number;
  repaired?: number;
  repairedFiles?: MarkdownRepairFile[];
}

/** 只接受 vault 内的 POSIX 相对路径；导入备份与未来的 Tauri 文件适配器共用。 */
export function safeVaultPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return null;
  const path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return path;
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

/** 批量写入：优先走适配器的合批事务（一批一个 IndexedDB 事务，快一个数量级），
 *  事务整体失败时退回逐条写以精确定位失败文件；返回**写失败的路径**：
 *  调用方据此报真实成功数，不能把「解析出的条数」当成「写成功的条数」。 */
async function writeMany(entries: Array<{ path: string; content: string }>): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const chunk = entries.slice(i, i + WRITE_BATCH);
    if (adapter.writeMany) {
      try {
        await adapter.writeMany(chunk);
        continue; // 本批全部成功
      } catch (e) {
        console.error('批量写入事务失败，退回逐条重写：', e);
      }
    }
    const results = await Promise.allSettled(chunk.map((f) => adapter.write(f.path, f.content)));
    results.forEach((r, j) => {
      if (r.status === 'rejected') {
        console.error('批量写入失败：', chunk[j].path, r.reason);
        failed.push(chunk[j].path);
      }
    });
  }
  return failed;
}

/** 批量删除：优先合批事务，失败退回逐条；返回删失败的路径 */
async function removeManyFiles(paths: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < paths.length; i += WRITE_BATCH) {
    const chunk = paths.slice(i, i + WRITE_BATCH);
    if (adapter.removeMany) {
      try {
        await adapter.removeMany(chunk);
        continue;
      } catch (e) {
        console.error('批量删除事务失败，退回逐条重删：', e);
      }
    }
    const results = await Promise.allSettled(chunk.map((p) => adapter.remove(p)));
    results.forEach((r, j) => {
      if (r.status === 'rejected') {
        console.error('批量删除失败：', chunk[j], r.reason);
        failed.push(chunk[j]);
      }
    });
  }
  return failed;
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

function repairEntries(entries: Array<{ path: string; content: string }>) {
  const repairedEntries: Array<{ path: string; content: string }> = [];
  const repairedFiles: MarkdownRepairFile[] = [];
  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith('.md')) {
      repairedEntries.push(entry);
      continue;
    }
    const result = repairMarkdown(entry.content);
    repairedEntries.push({ path: entry.path, content: result.content });
    if (result.changed) repairedFiles.push({ path: entry.path, changes: result.changes });
  }
  return { entries: repairedEntries, repairedFiles };
}

function repairCount(files: MarkdownRepairFile[]): number {
  return files.reduce((sum, file) => sum + file.changes.reduce((n, c) => n + c.count, 0), 0);
}

/** 只反映会影响名称解析和 PDF 目标列表的元数据；正文普通改动不应触发全库索引重建。 */
function linkMetadataSignature(path: string, content: string | undefined): string {
  if (!path.endsWith('.md')) return '';
  const { title, meta } = getMeta(path, content ?? '');
  return `${title}\u0000${meta.aliases.join('\u0000')}\u0000${meta.chapter ?? ''}`;
}

/** 首次使用引导笔记：空库自动创建（只建一次，删除后不再重生） */
const ONBOARD_PATH = '00-三分钟上手.md';
const ONBOARD_FLAG = 'knowlattice-onboarded';

/**
 * 上一版引导笔记的原文。作用只有一个：判断用户库里那篇「三分钟上手」是否还是
 * 我们当初塞进去的原样——原样才升级成新版本文档，用户改过一个字就不动。
 * created 行随创建当天变化，比较前先用 normCreated 抹掉（见下方加载逻辑）。
 */
const ONBOARD_CONTENT_V1 = `---
aliases: [新手指南]
tags: [指南]
chapter: 指南
source: 内置
created: (创建日期)
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

const ONBOARD_CONTENT = `---
aliases: [新手指南, 快速开始, 上手]
tags: [指南]
chapter: 指南
source: 内置
created: ${new Date().toISOString().slice(0, 10)}
---

# 三分钟上手

晶格把医学生的日常压成四个动作：**写下来 → 连起来 → 背下来 → 考出来**。
下面按这个顺序走一遍，每条都写清「点哪里、按哪个键」。

## 一、先建第一篇笔记

- 点左上角 **＋ 新建**，先选类型：概念 / 疾病 / 机制 / 检查 / 口诀
- 骨架自动生成，你只负责填空；写的时候停止输入约 1 秒会自动保存，也可以随时 \`Ctrl+S\`
- 章节层级靠缩进表达，不靠文件夹：**一文件一知识点**

## 二、写原子笔记：只有三个动作

- 回车: 自动续写下一条，不用输任何符号
	- Tab 缩进一层，就是子要点（这一行就是）
	- Shift+Tab 反缩进回来
- 属性: 冒号开头的行会自动加粗，用来标注结构，例如「机制: 缺氧导致…」「口诀: 一嗅二视三动眼」
- 双链: 输入两个左中括号 \`[[\` 会弹出笔记名补全（连别名一起搜），回车就把两篇笔记连上

## 三、快捷键总表

| 操作 | 快捷键 | 说明 |
| --- | --- | --- |
| 加粗 | Alt+A | 再按一次取消；没选中文字时会插入占位内容并选中 |
| 高亮 | Alt+S | 同上，语法是两个等号夹住重点 |
| 斜体 | Alt+Z | 同上，语法是单个星号夹住 |
| 插入双链 | Alt+X | 插入一对左中括号，并弹出笔记名候选，回车选中 |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Y | |
| 保存 | Ctrl+S | 不按也不会丢，自动保存已经在跑 |
| 缩进 / 反缩进 | Tab / Shift+Tab | 段落层级就是知识层级 |
| 快速搜索全库 | Ctrl+K | 标题匹配 + 全文（中文分词），支持最近打开排序 |
| 笔记前进 / 后退 | Alt+← / Alt+→ | 按打开顺序回退，误关的笔记能找回来 |
| 关闭当前面板 | Esc | |

加粗与高亮的标记分别是两个星号、两个等号（\`**重点**\`、\`==重点==\`），斜体是单个星号；双链是两个左中括号。这些符号只存在文件里，编辑时不会显示——要加粗就选中文字按 Alt+A，或右键「加粗」，都不必手打符号。

四个格式键刻意挤在左手：A/S 是基准键、Z/X 在正下方一行，拇指按住左 Alt 其余手指原地按，一只手就能加格式。之所以不用 Ctrl+字母或数字键：Ctrl+A/S/F 是全选/保存/查找，Alt+D 是浏览器地址栏、Ctrl+数字是切换标签页，这些都拦不住或不该抢。

## 四、把讲义变成笔记（两条路）

- **PDF / Word 对照**: 左侧原文（可选中文字层、缩放、搜索），划选重点 → 「粘贴到右」生成原文摘录；可以连续追加到同一篇笔记，摘录历史里能看到每条是否已入库
- **智能草稿**: 粘贴教材段落，或导入 PDF 讲义，一键拆成原子笔记骨架（识别 定义 / 来源 / 机制 / 作用 / 分类 / 鉴别 等语义），人工审核后再入库

## 五、用工具画医学通路图

- 在编辑器工具栏点击 **通路**，填写节点、箭头方向和酶/条件，右侧会实时预览；确认后点「插入笔记」
- 下面是一张用这个工具绘制的糖代谢示例。节点和箭头仍是 Markdown，插入后可以继续修改：

\`\`\`pathway
# 糖代谢通路示例
## 糖代谢总览 | #d64545 | 细胞质与线粒体
葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶
6-磷酸葡萄糖 -> 果糖-1,6-二磷酸 : PFK-1
果糖-1,6-二磷酸 -> 丙酮酸 : 糖酵解阶段
丙酮酸 -> 乳酸 : 乳酸脱氢酶（缺氧）
丙酮酸 -> 乙酰CoA : 丙酮酸脱氢酶
乙酰CoA -> 柠檬酸 : 柠檬酸合酶
柠檬酸 -> CO₂ + ATP : 三羧酸循环（概览）
\`\`\`

## 六、背下来：间隔复习

- 原子笔记自动生成复习卡：正面 = 标题 + 属性键，背面 = 内容
- 左侧卡片图标进入复习队列，FSRS 遗忘曲线安排每天该背的卡
- 答「忘了」会自动收进**错题本**，薄弱章节在热力图上一眼可见

## 七、考出来：题库与错题

- 「题库练习」支持导入 JSON / Word / Excel 题库（字段格式见面板内说明），随机组卷作答
- 答错且题目标注了关联笔记 → 自动进错题本，结果页一点直达笔记
- 复习数据可导出为 Anki 文件（.txt / .apkg），带去手机继续背

## 八、看见知识的形状

- **知识图谱**: 全库双链网络图，节点大小 = 连接度，颜色 = 一级章节，点节点直达笔记
- **3D 解剖图谱**: 12 系统 × 3478 结构，点结构 ↔ 笔记双向打通
- **脑图谱**: MNI152 模板 MRI + Harvard-Oxford 117 个脑区的中英文对照，点脑区定位到 MNI 坐标

## 九、数据是你自己的

- 全部数据存在本机浏览器（IndexedDB），不联网、不上传
- 目录卡片右上角 **⋯** → \`备份到 .json\` / \`从备份 .json 恢复\`（含复习进度、题库、错题）
- **⋯** → \`导出 md 文件夹 (.zip)\`: 真实的 Markdown 目录结构 + 图片附件，Obsidian、记事本都能直接打开，数据永不锁定
- 换设备或清理浏览器数据前，记得先备份

## 十、这篇笔记怎么处理

看完可以直接删掉（顶部工具栏的垃圾桶图标）——删掉之后不会再自动生成。
想留作速查表也行，第三节的快捷键表是最常回来看的部分。
`;

/** created 行随创建当天变化，比对旧笔记时先抹掉这一行 */
const normCreated = (s: string) => s.replace(/^created: .*$/m, 'created:');

export function useVault() {
  const [docs, setDocs] = useState<Map<string, string>>(new Map());
  const docsRef = useRef(docs);
  useEffect(() => { docsRef.current = docs; }, [docs]);
  const [structureDocs, setStructureDocs] = useState<Map<string, string>>(new Map());
  /** 二进制附件：path → Blob（与笔记分库，避免保存时整库拷贝大图片） */
  const [attachments, setAttachments] = useState<Map<string, Blob>>(new Map());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 加载失败原因。非空时应用停在错误页（见 Workspace），不允许进入可写状态 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 重试计数：自增即重跑加载 effect */
  const [reloadKey, setReloadKey] = useState(0);
  /** 链接索引：state 持有（替换 ref，规避 render 期访问 ref）。日常保存就地增量更新
   *  （updateLinksForPath），依赖 docs/索引身份的消费者（图谱、反链）随 docs 变化重算。 */
  const [linkIndex, setLinkIndex] = useState<LinkIndex>(() => ({ outgoing: new Map(), incoming: new Map() }));
  /** Blob 对象 URL 缓存：同一附件只 createObjectURL 一次 */
  const attachmentUrlCache = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
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
      } else if (normCreated(fileMap.get(ONBOARD_PATH) ?? '') === normCreated(ONBOARD_CONTENT_V1)) {
        // 老用户的「三分钟上手」若还是当初生成的原样（一个字没改），静默升级成新版本文档；
        // 改过、或已被删除，都不动它。
        await adapter.write(ONBOARD_PATH, ONBOARD_CONTENT);
        fileMap.set(ONBOARD_PATH, ONBOARD_CONTENT);
      }
      if (cancelled) return;
      setLinkIndex(rebuildLinkIndex(fileMap));
      setDocs(fileMap);
      setStructureDocs(fileMap);
      setAttachments(attachmentMap);
      setLoaded(true);
    })().catch((e) => {
      if (cancelled) return;
      console.error('加载知识库失败：', e);
      // 这里不再「失败也放行」：库没读出来时 docs 是空的，此后任何新建/查重都以
      // 「磁盘上没有这篇」为前提，会把真实笔记覆盖掉。改为停在错误页，等用户重试。
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** 重新加载知识库（错误页的「重试」按钮） */
  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoaded(false);
    setReloadKey((k) => k + 1);
  }, []);

  /** 保存：**先落盘、再更新内存**。写失败会抛出，调用方据此提示。
   *  旧写法是「先乐观更新内存、catch 里只 console.error」，于是 IndexedDB 写失败时
   *  界面照样显示「已保存 ✓」、脏点也消失——用户是在「应用说存住了」的前提下丢稿的。 */
  const save = useCallback(async (path: string, content: string) => {
    const safePath = safeVaultPath(path);
    if (!safePath) throw new Error('文件路径不安全');
    const previous = docsRef.current.get(safePath);
    const structureChanged = !docsRef.current.has(safePath)
      || linkMetadataSignature(safePath, previous) !== linkMetadataSignature(safePath, content);
    await adapter.write(safePath, content);
    const next = new Map(docsRef.current).set(safePath, content);
    docsRef.current = next;
    setDocs(next);
    updateLinksForPath(linkIndex, safePath, content);
    if (structureChanged) {
      setStructureDocs(next);
    }
    void pushSnapshot(safePath, content);
  }, [linkIndex]);

  /** 删除：先落盘、再改内存；失败抛出且内存保持原样（不会再「删了重启又回来」） */
  const remove = useCallback(async (path: string) => {
    const safePath = safeVaultPath(path);
    if (!safePath) throw new Error('文件路径不安全');
    await adapter.remove(safePath);
    const next = new Map(docsRef.current);
    next.delete(safePath);
    docsRef.current = next;
    setDocs(next);
    if (safePath.endsWith('.md')) setStructureDocs(next);
    updateLinksForPath(linkIndex, safePath, '');
    setCurrentPath((cur) => (cur === safePath ? null : cur));
  }, [linkIndex]);

  /** 批量删除：落盘分批限流（避免一次发几千个 IndexedDB 事务），返回**删失败的路径**。
   *  内存只删真正删成功的：失败的留在树里，用户看得见「没删掉」，而不是被蒙住。 */
  const removeMany = useCallback(async (paths: string[]): Promise<string[]> => {
    const entries = paths.map((original) => ({ original, safe: safeVaultPath(original) }));
    const invalid = entries.filter((entry) => !entry.safe).map((entry) => entry.original);
    const safePaths = entries.flatMap((entry) => entry.safe ? [entry.safe] : []);
    const failedSafe = await removeManyFiles(safePaths);
    const failedSafeSet = new Set(failedSafe);
    const failed = [...invalid, ...entries
      .filter((entry) => entry.safe && failedSafeSet.has(entry.safe))
      .map((entry) => entry.original)];
    const failedSet = new Set(failed);
    const del = new Set(entries
      .filter((entry) => entry.safe && !failedSet.has(entry.original))
      .map((entry) => entry.original));
    const next = new Map(docsRef.current);
    for (const p of del) next.delete(p);
    docsRef.current = next;
    setDocs(next);
    if ([...del].some((p) => p.endsWith('.md'))) setStructureDocs(next);
    for (const p of del) updateLinksForPath(linkIndex, p, '');
    setCurrentPath((cur) => (cur && del.has(cur) ? null : cur));
    return failed;
  }, [linkIndex]);

  /** 导出全部笔记为单个 .json 备份文件（直接用内存缓存；新附件库不并入 JSON，
   *  旧版残留的 dataURL 附件仍随 files 字段导出以保证不丢数据） */
  const exportAll = useCallback(async () => {
    const files = [...docs]
      .filter(([path]) => path.endsWith('.md') || path.startsWith('_attachments/'))
      .map(([path, content]) => ({ path, content }));
    const payload = {
      app: 'knowlattice',
      version: 6,
      exportedAt: new Date().toISOString(),
      files,
      // v2 起随备份保存 SRS 复习调度进度（旧版备份无此字段，导入时自动跳过）
      srs: exportSrsState(),
      // 题库与错题一并备份（v2 增量字段，旧版本导入时忽略）
      qbanks: await exportQbanks(),
      qbankStats: await exportQuestionStats(),
      mistakes: loadMistakes(),
      // v3 起补上待办与打卡：这两样此前只活在 localStorage 里，备份不到、换设备即丢
      todos: exportTodos(),
      days: exportDays(),
      // v4 起补上卡片自定义（改写正/背面、删卡）：和待办同一类问题，不随备份走就会丢
      cardEdits: exportCardEdits(),
      // v5 起补上番茄专注记录：工作台的「今日/累计/趋势」全靠它，丢了就等于白专注
      pomodoros: exportPomodoros(),
      pathwayTemplates: await exportPathwayTemplates(),
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
  const importBackup = useCallback(async (text: string): Promise<ImportResult> => {
    const data = JSON.parse(text) as {
      app?: string;
      version?: number;
      files?: { path: string; content: string }[];
      srs?: unknown;
      qbanks?: unknown;
      qbankStats?: unknown;
      mistakes?: unknown;
      todos?: unknown;
      days?: unknown;
      cardEdits?: unknown;
      pomodoros?: unknown;
      pathwayTemplates?: unknown;
    };
    // 兼容旧版以 medvault 命名的备份：两版文件结构一致，只有 app 字段不同
    if ((data.app !== 'knowlattice' && data.app !== 'medvault') || !Array.isArray(data.files)) {
      throw new Error('不是有效的 晶格 备份文件');
    }
    const valid: Array<{ path: string; content: string }> = [];
    let invalidFiles = 0;
    for (const f of data.files) {
      const path = safeVaultPath(f?.path);
      if (!path || typeof f?.content !== 'string') { invalidFiles++; continue; }
      valid.push({ path, content: f.content });
    }
    const notes = valid.filter((f) => !f.path.startsWith('_attachments/'));
    const repaired = repairEntries(notes);
    const legacyAttachments = valid.filter((f) => f.path.startsWith('_attachments/'));

    const failedNotes = await writeMany(repaired.entries);
    const failedSet = new Set(failedNotes);
    const restoredAttachments = new Map<string, Blob>();
    /** 转不成 Blob、只能按原文当笔记文件存回去的旧附件 */
    const keptAsFile = new Set<string>();
    let attachFailed = 0;
    for (const f of legacyAttachments) {
      const blob = dataUrlToBlob(f.content);
      try {
        if (blob) {
          await adapter.writeAttachment(f.path, blob);
          restoredAttachments.set(f.path, blob);
        } else {
          // 旧数据无法转 Blob 时按原文保留为笔记文件，至少不丢数据
          await adapter.write(f.path, f.content);
          keptAsFile.add(f.path);
        }
      } catch (e) {
        console.error('附件恢复失败：', f.path, e);
        attachFailed++;
      }
    }
    if (data.srs) importSrsState(data.srs);
    if (data.qbanks) await importQbanks(data.qbanks);
    if (data.qbankStats) await importQuestionStats(data.qbankStats);
    if (data.mistakes) importMistakes(data.mistakes);
    if (data.todos) importTodos(data.todos);
    if (data.days) importDays(data.days);
    if (data.cardEdits) importCardEdits(data.cardEdits);
    if (data.pomodoros) importPomodoros(data.pomodoros);
    if (data.pathwayTemplates) await importPathwayTemplates(data.pathwayTemplates);

    // 并入内存缓存 + 增量更新链接索引
    // 只把真正写成功的并入内存：写失败的如果也进内存，当前会话看着一切正常、还弹
    // 「已恢复 N 篇」，刷新后才永久缺失——这是最难事后归因的一类数据丢失。
    const okNotes = repaired.entries.filter((f) => !failedSet.has(f.path));
    const repairedFiles = repaired.repairedFiles.filter((f) => !failedSet.has(f.path));
    const next = new Map(docsRef.current);
    for (const f of okNotes) next.set(f.path, f.content);
    for (const f of legacyAttachments) {
      if (keptAsFile.has(f.path)) next.set(f.path, f.content);
    }
    docsRef.current = next;
    setDocs(next);
    setAttachments((prev) => {
      const next = new Map(prev);
      for (const [path, blob] of restoredAttachments) next.set(path, blob);
      return next;
    });
    for (const f of okNotes) updateLinksForPath(linkIndex, f.path, f.content);
    if (okNotes.length > 0) {
      setStructureDocs(next);
    }
    return {
      ok: okNotes.length,
      failed: failedSet.size + attachFailed + invalidFiles,
      repaired: repairCount(repairedFiles),
      repairedFiles,
    };
  }, [linkIndex]);

  /** 导入 md 文件夹（相对路径入库，保留目录结构）；返回真实成功/失败篇数 */
  const importMdFiles = useCallback(async (files: Array<{ path: string; content: string }>): Promise<ImportResult> => {
    const valid: Array<{ path: string; content: string }> = [];
    let invalidFiles = 0;
    for (const f of files) {
      const p = safeVaultPath(f.path);
      if (!p || !p.toLowerCase().endsWith('.md') || typeof f.content !== 'string') { invalidFiles++; continue; }
      valid.push({ path: p, content: f.content });
    }
    const repaired = repairEntries(valid);
    const failedPaths = await writeMany(repaired.entries);
    const failedSet = new Set(failedPaths);
    const okFiles = repaired.entries.filter((f) => !failedSet.has(f.path));
    const repairedFiles = repaired.repairedFiles.filter((f) => !failedSet.has(f.path));
    const next = new Map(docsRef.current);
    for (const f of okFiles) next.set(f.path, f.content);
    docsRef.current = next;
    setDocs(next);
    for (const f of okFiles) updateLinksForPath(linkIndex, f.path, f.content);
    if (okFiles.length > 0) {
      setStructureDocs(next);
    }
    return {
      ok: okFiles.length,
      failed: failedPaths.length + invalidFiles,
      repaired: repairCount(repairedFiles),
      repairedFiles,
    };
  }, [linkIndex]);

  /** 主动扫描并修复已有 Markdown，只写入实际发生变化的文件。 */
  const repairExistingMarkdown = useCallback(async (): Promise<ImportResult> => {
    const source = [...docsRef.current.entries()]
      .filter(([path]) => path.toLowerCase().endsWith('.md'))
      .map(([path, content]) => ({ path, content }));
    const repaired = repairEntries(source);
    const changed = repaired.entries.filter((entry) =>
      repaired.repairedFiles.some((file) => file.path === entry.path)
    );
    const failedPaths = await writeMany(changed);
    const failedSet = new Set(failedPaths);
    const okFiles = changed.filter((entry) => !failedSet.has(entry.path));
    const repairedFiles = repaired.repairedFiles.filter((file) => !failedSet.has(file.path));
    if (okFiles.length === 0) {
      return { ok: 0, failed: failedPaths.length, repaired: 0, repairedFiles: [] };
    }
    const next = new Map(docsRef.current);
    for (const file of okFiles) next.set(file.path, file.content);
    docsRef.current = next;
    setDocs(next);
    setStructureDocs(next);
    for (const file of okFiles) updateLinksForPath(linkIndex, file.path, file.content);
    return {
      ok: okFiles.length,
      failed: failedPaths.length,
      repaired: repairCount(repairedFiles),
      repairedFiles,
    };
  }, [linkIndex]);

  /** 保存图片附件（Blob 存入独立 attachments store），返回 vault 相对路径；写失败抛出 */
  const saveAttachment = useCallback(async (filename: string, blob: Blob): Promise<string> => {
    const path = safeVaultPath(`_attachments/${filename}`);
    if (!path) throw new Error('附件路径不安全');
    await adapter.writeAttachment(path, blob);
    setAttachments((prev) => new Map(prev).set(path, blob));
    return path;
  }, []);

  /** 新建笔记走模板，自动填 chapter/frontmatter（M1 验收项） */
  const createNote = useCallback(
    async (dir: string, title: string, template: string) => {
      const path = dir ? `${dir}/${title}.md` : `${title}.md`;
      if (docs.has(path)) throw new Error('同名笔记已存在');
      // 兜底再问一次存储层：内存索引可能因加载失败/部分写入而残缺，光看内存会把
      // 磁盘上已有的笔记当成新笔记直接覆盖（这是唯一不可逆的丢数据路径）。
      if (await adapter.exists(path)) throw new Error('同名笔记已存在');
      await save(path, template);
      setCurrentPath(path);
      return path;
    },
    [docs, save]
  );

  /**
   * 路径数组：**只在增删文件时换引用**，改正文不换。
   *
   * 为什么需要：`docs` 是 `new Map(prev).set(...)`，**每次自动保存（停手 800ms 后）都换
   * 引用**，于是所有 `useMemo(..., [docs])` 的全库计算每次都重跑——目录树、名称索引、
   * 链接名的 ICU 中文排序加起来在 5227 篇规模下约 60ms，打字停一下就顿一下，而且库越大
   * 越明显。但这些结果里只有「哪些路径存在」这一层是保存改不动的。
   *
   * 做法：先把路径拼成一个字符串签名，再拆回数组。字符串在依赖数组里按**值**比较，
   * 所以 `paths` 只在真正增删文件时才换引用。拼接 5227 条路径约 0.5ms，远低于重建目录树。
   * （路径不含 \u0000，可安全当分隔符。）
   */
  const pathSig = useMemo(() => [...docs.keys()].join('\u0000'), [docs]);
  const paths = useMemo(() => (pathSig ? pathSig.split('\u0000') : []), [pathSig]);

  const tree = useMemo(() => buildTree(paths), [paths]);

  /** 仅 .md 的路径（顺序与 docs 一致，供章节树/复习面板等使用）。同样只在增删时换引用。 */
  const notePaths = useMemo(() => paths.filter((p) => p.endsWith('.md')), [paths]);

  /** 名称 → 路径 索引（文件名 / 一级标题 / alias，小写）。构建一次，之后 O(1) 解析；
   *  解析结果走 metaCache，内容未变的篇目零成本。仅 .md 参与。
   *  这一步的开销几乎全在遍历本身（5227 篇约 23ms），签名省不掉，保持原样。 */
  const nameIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const [path, content] of structureDocs) {
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
  }, [structureDocs]);

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

  /** 所有可用链接名（文件名 + 标题 + alias 去重），供 [[ 自动补全。仅 .md 参与。
   *
   *  排序用 localeCompare(…, 'zh') 是为了**拼音序**（换成码点序，中文列表看着就是乱的），
   *  但 ICU 排序 1 万条实测约 24ms。这里先算出「名字集合的字符串签名」再排序：字符串在
   *  依赖数组里按值比较，于是改正文的自动保存（名字没变）不会重排，而增删/改名时签名变化，
   *  照常重排。签名里用 \u0000 分隔（文件名、标题、alias 都不会含它）。 */
  const linkNameSig = useMemo(() => {
    const names = new Set<string>();
    for (const [path, content] of structureDocs) {
      if (!path.endsWith('.md')) continue;
      names.add(path.replace(/\.md$/, '').split('/').pop()!);
      const { title, meta } = getMeta(path, content);
      if (title) names.add(title);
      meta.aliases.forEach((a) => names.add(a));
    }
    return [...names].join('\u0000');
  }, [structureDocs]);
  const allLinkNames = useMemo(
    () => (linkNameSig ? linkNameSig.split('\u0000').sort((a, b) => a.localeCompare(b, 'zh')) : []),
    [linkNameSig]
  );

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
    loadError,
    retryLoad,
    docs,
    structureDocs,
    tree,
    notePaths,
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
    repairExistingMarkdown,
    adapter,
  };
}
