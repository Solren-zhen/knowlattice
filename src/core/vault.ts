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
import { TauriAdapter } from '../storage/tauri';
import { isTauri } from '../storage/tauriEnv';
import { hasChosenVault, getStoredVaultDir, storeVaultDir, pickVaultFolder, authorizeVaultDir } from '../storage/vaultFolder';
import { migrateIndexedDbToFolder } from '../storage/migrateToFolder';
import { parseFrontmatterCached } from './parser';
import { rebuildLinkIndex, updateLinksForPath, backlinks, type LinkIndex } from './linkIndex';
import { exportSrsState, importSrsState } from './srs';
import { exportQbanks, importQbanks } from './qbank';
import { exportQuestionStats, importQuestionStats } from './qbankStats';
import { exportStars, importStars, type StarMap } from './qbankStarred';
import { exportCalibration, importCalibration } from './qbankCalib';
import { loadMistakes, importMistakes } from './mistakes';
import { exportTodos, importTodos } from './todos';
import { exportCardEdits, importCardEdits } from './cardEdits';
import { exportNoteMedia, importNoteMedia } from './noteMedia';
import { findOrphanAttachments as findOrphans } from './attachmentOrphans';
import { exportNoteStyles, importNoteStyles } from './mindmapNodeStyles';
import { exportMarks, importMarks } from './mindmapMarks';
import { exportMindMapPrefs, importMindMapPrefs } from './mindmapPrefs';
import { exportPlan, importPlan } from './reviewPlan';
import { exportReminder, importReminder } from './reminder';
import { exportRecall, importRecall } from './localRecall';
import { exportExamHistory, importExamHistory } from './examHistory';
import { exportDaily, importDaily } from './dailyPractice';
import { exportDays, importDays } from './stats';
import { exportPomodoros, importPomodoros } from './pomodoro';
import { pushSnapshot } from './history';
import { repairMarkdown, type MarkdownRepairChange } from './markdownRepair';
import { exportPathwayTemplates, importPathwayTemplates } from './pathwayTemplates';
import { enqueueWrite } from './writeQueue';
import { planMerge, formatConflictStamp, pickNewObjectKeys, pickNewListItems, type ExistingFile } from './restoreMerge';
import { toast } from './feedback';

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
  /** 本次**真正被覆盖**的现有路径（笔记与附件分列）。
   *  「只补不覆盖」后这里**恒为空数组**：恢复 / 导入不再替换现有文件——内容不同时把来源那一篇
   *  另存到冲突目录、内容相同则跳过，附件则原样保留。保留该字段是为了不改既有字段语义
   *  （ChapterTree 仍在读它）。 */
  overwritten?: string[];
  /** 新增（真正写入）的**笔记**篇数。 */
  addedNotes?: number;
  /** 因「路径已存在且内容不同」而**另存**到冲突目录的笔记篇数。 */
  conflictNotes?: number;
  /** 冲突另存的**目标路径**（可追溯地亮给用户：哪几篇被另存了）。 */
  conflictFiles?: string[];
  /** 因「路径已存在且内容完全相同」而跳过的笔记篇数。 */
  unchangedNotes?: number;
  /** 附件：新写入的个数。 */
  addedAttachments?: number;
  /** 附件：因已存在而保留跳过的个数（现有笔记引用的就是现有附件，替换会改历史笔记的显示）。 */
  skippedAttachments?: number;
  /** 各 localStorage 存储的逐条合并计数（键已存在则保留现有值，只补新键）。 */
  storeMerges?: Array<{ name: string; added: number; kept: number }>;
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

/** 桌面端（Tauri）写真实文件系统，浏览器版（含离线包展示面）用 IndexedDB。
 *  桌面端 vault 目录来自用户选择（localStorage 持久化，vaultFolder.ts）：
 *  null = 默认 <文档>/KnowLattice；「更换库文件夹」后重建适配器并触发整库重载。 */
let adapter: StorageAdapter = isTauri() ? new TauriAdapter(getStoredVaultDir()) : new WebAdapter();

/** 桌面端启动准备（useVault 每次加载前调用）：
 *  1. 首次启动弹系统目录选择框定 vault 位置，取消则用默认 <文档>/KnowLattice；
 *  2. 向 Rust 端重申 fs 运行时作用域（授权不跨重启持久，顺带自愈路径不一致）；
 *  3. IndexedDB → 文件夹一次性迁移（标记文件幂等，失败下次自动重试）。
 *  StrictMode 会并发挂载两次 effect：用共享 Promise 保证选择框只弹一次。 */
let preparePromise: Promise<void> | null = null;
function prepareTauriVault(): Promise<void> {
  preparePromise ??= (async () => {
    if (!hasChosenVault()) {
      const dir = await pickVaultFolder();
      storeVaultDir(dir);
      if (dir) adapter = new TauriAdapter(dir);
    }
    await authorizeVaultDir(getStoredVaultDir()).catch((e) => {
      console.warn('vault 目录授权失败（将依赖上次会话的授权）：', e);
    });
    try {
      const r = await migrateIndexedDbToFolder(adapter);
      if (!r.skipped && r.notes + r.attachments > 0) {
        toast(`已把浏览器里的 ${r.notes} 篇笔记、${r.attachments} 个附件迁入库文件夹`, 'ok', 4200);
      }
    } catch (e) {
      console.error('IndexedDB → 文件夹迁移失败（下次启动自动重试）：', e);
    }
  })().finally(() => {
    preparePromise = null;
  });
  return preparePromise;
}

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

/** Blob → dataURL（把二进制附件并入 .json 备份；环境不支持 FileReader 时返回 null，跳过该附件不阻塞整包） */
function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
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

/**
 * 打开库时的 Markdown 格式自动修复（幂等：只有实际发生变化的文件才写盘）。
 *
 * 为什么不做成菜单里的一次性动作：格式修复属于**维护**，不是用户操作——用户既不知道
 * 自己哪篇笔记坏在哪，也没理由记住「要去点一下」。放在加载路径上，每次打开库顺带扫一遍：
 * 坏的那一次修好，之后各次都只是一遍内存扫描、零写盘。
 *
 * 就地改 `fileMap`（此时调用方还没 setDocs）：避免「先发布一份坏内容、再发一次事件修正」
 * 的中间态。写失败的文件保持磁盘原样、报告里如实扣掉。
 */
async function repairNotesOnLoad(fileMap: Map<string, string>): Promise<ImportResult> {
  const source = [...fileMap.entries()]
    .filter(([path]) => path.toLowerCase().endsWith('.md'))
    .map(([path, content]) => ({ path, content }));
  const repaired = repairEntries(source);
  if (repaired.repairedFiles.length === 0) {
    return { ok: 0, failed: 0, repaired: 0, repairedFiles: [] };
  }
  const changed = repaired.entries.filter((entry) =>
    repaired.repairedFiles.some((file) => file.path === entry.path)
  );
  const failedPaths = await writeMany(changed);
  const failedSet = new Set(failedPaths);
  const okFiles = changed.filter((entry) => !failedSet.has(entry.path));
  for (const file of okFiles) fileMap.set(file.path, file.content);
  const repairedFiles = repaired.repairedFiles.filter((file) => !failedSet.has(file.path));
  return {
    ok: okFiles.length,
    failed: failedPaths.length,
    repaired: repairCount(repairedFiles),
    repairedFiles,
  };
}

/** localStorage 存储的合并计数（报告用） */
interface StoreMerge { name: string; added: number; kept: number }

/**
 * 对象型 localStorage 存储的「只补不覆盖」合并：读出当前快照 → 只挑**新键** → 交给该存储
 * 自己的导入器落盘。
 *
 * 为什么不直接整块 setItem 覆盖：① 存储自己的导入器带着各自的校验与兜底（core/srs、
 * core/cardEdits、core/noteMedia 等），复用它们才不会在恢复路径上分叉出第二套解析；
 * ② 那些导入器多是「同键覆盖」语义，直接喂整包会把用户现有值盖掉——先过滤成「只含新键」
 * 再喂，天然碰不到现有键，等价于「键已存在则保留现有值」。
 *
 * `wholeReplace`：少数导入器（如 core/qbankCalib 的 importCalibration）用它收到的对象
 * **重建**整份存储，只传新键会把现有键整批抹掉；此时补上现有值（现有优先）再喂，既留旧又增新。
 */
async function mergeObjectStore(
  name: string,
  incoming: unknown,
  snapshot: Record<string, unknown>,
  apply: (payload: Record<string, unknown>) => unknown,
  wholeReplace = false,
): Promise<StoreMerge> {
  const { fresh, added, kept } = pickNewObjectKeys(incoming, snapshot);
  if (added > 0) await apply(wholeReplace ? { ...(incoming as Record<string, unknown>), ...snapshot } : fresh);
  return { name, added, kept };
}

/**
 * 数组型 localStorage 存储的「只补不覆盖」合并：按身份键（id 等）滤出现有键之外的条目再落盘。
 * 未提供身份键的条目按新增处理（见 pickNewListItems）：判不了重时宁可可多不能漏。
 */
async function mergeListStore(
  name: string,
  incoming: unknown,
  existingKeys: ReadonlySet<string>,
  keyOf: (item: Record<string, unknown>) => string | undefined,
  apply: (fresh: Record<string, unknown>[]) => unknown,
): Promise<StoreMerge> {
  const { fresh, added, kept } = pickNewListItems(incoming, existingKeys, keyOf);
  if (added > 0) await apply(fresh);
  return { name, added, kept };
}

/**
 * 题库统计是 (题库 → 题目 → 值) 的两层对象：按 (题库, 题目) 逐键过滤，现有键保留、只补新键。
 * 与对象型存储同一纪律——现有键的值原样留着，不因为导入而被旧备份冲回去。
 */
function pickNewQuestionStats(
  incoming: unknown,
  existing: Record<string, Record<string, unknown>>,
): { fresh: Record<string, Record<string, unknown>>; added: number; kept: number } {
  const fresh: Record<string, Record<string, unknown>> = {};
  let added = 0;
  let kept = 0;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { fresh, added, kept };
  for (const [bank, questions] of Object.entries(incoming as Record<string, unknown>)) {
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) continue;
    const existingBank = existing[bank] ?? {};
    const target: Record<string, unknown> = {};
    for (const [qid, stat] of Object.entries(questions as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(existingBank, qid)) {
        kept++;
        continue;
      }
      target[qid] = stat;
      added++;
    }
    if (Object.keys(target).length > 0) fresh[bank] = target;
  }
  return { fresh, added, kept };
}

/**
 * 收藏题与题库统计同形（题库 → 题目 → 值），走同一套「逐键只补不覆盖」：
 * 本地已收藏的题保持收藏，备份里多出来的题补上；已被取消收藏的题不会被旧备份复活。
 */
function pickNewStars(
  incoming: unknown,
  existing: StarMap,
): { fresh: StarMap; added: number; kept: number } {
  const fresh: StarMap = {};
  let added = 0;
  let kept = 0;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { fresh, added, kept };
  for (const [bank, questions] of Object.entries(incoming as Record<string, unknown>)) {
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) continue;
    const existingBank = existing[bank] ?? {};
    const target: Record<string, true> = {};
    for (const qid of Object.keys(questions as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(existingBank, qid)) {
        kept++;
        continue;
      }
      target[qid] = true;
      added++;
    }
    if (Object.keys(target).length > 0) fresh[bank] = target;
  }
  return { fresh, added, kept };
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
  /**
   * 改 docs 的**唯一入口**：先写 ref，再 setState。
   *
   * 为什么不能靠「useEffect 同步 ref」：effect 跑在渲染提交之后，于是存在一个
   * 「界面已经显示加载完成（loaded=true）、docsRef 还是旧值（空表）」的窗口。恢复 / 导入的
   * 查重读的正是 docsRef：落在这个窗口里时，每一篇现有笔记都会命中「存在但内容拿不到」这条
   * 保守分支，被各自另存一份 `恢复冲突/…` 副本（真机上表现为「刚打开库就恢复 → 莫名多出一堆
   * 冲突副本」；测试里表现为 conflictNotes 偶发从 1 变 2）。
   * 所以：ref 一律先写，state 只负责渲染。
   */
  const applyDocs = useCallback((next: Map<string, string>) => {
    docsRef.current = next;
    setDocs(next);
  }, []);
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

  /** 打开库时**自动**修正的 Markdown 格式报告（没有可修的为 null）。只用于界面显示明细，
   *  不是用户要点一下的动作——真正的修复在加载 effect 里做，见 repairNotesOnLoad。 */
  const [autoRepair, setAutoRepair] = useState<ImportResult | null>(null);
  /** Blob 对象 URL 缓存：同一附件只 createObjectURL 一次 */
  const attachmentUrlCache = useRef(new Map<string, string>());
  /** 各路径「我们上次看到的磁盘 mtime」。写盘前比对它来发现外部改动（外部编辑器 /
   *  另一个窗口 / 同步盘）：不一致就先留档再覆盖，绝不静默吃掉别人的内容。 */
  const diskMtimesRef = useRef(new Map<string, number>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 桌面端：先定 vault 目录（首次启动弹选择框）、重申 fs 授权、做 IndexedDB → 文件夹一次性迁移
      if (isTauri()) {
        await prepareTauriVault();
        if (cancelled) return;
      }
      // 单遍读出全部笔记与附件；空库首次使用自动创建引导笔记
      const fileMap = await adapter.readAll();
      const attachmentMap = await adapter.readAllAttachments();

      // 迁移旧版（v1）把 dataURL 附件塞在 files store 里的数据：转为 Blob 放 attachments store
      const legacyMoved: Array<{ path: string; blob: Blob; raw: string }> = [];
      for (const [p, content] of fileMap) {
        if (!p.startsWith('_attachments/')) continue;
        const blob = dataUrlToBlob(content);
        if (blob) {
          legacyMoved.push({ path: p, blob, raw: content });
          attachmentMap.set(p, blob);
          fileMap.delete(p);
        }
        // 转换失败的旧数据暂时留在 docs 里，readFile 仍可当 dataURL 渲染，避免丢图
      }
      for (const a of legacyMoved) {
        try {
          await adapter.writeAttachment(a.path, a.blob);
        } catch {
          // 新位置写失败（配额 / IO）：把旧 dataURL 记录放回 docs。否则下面的 remove 会
          // 删掉唯一那份数据 —— 上面「避免丢图」的承诺落空，图永久消失且没有任何报错。
          fileMap.set(a.path, a.raw);
          continue;
        }
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

      // Markdown 格式自动修复：打开库即静默跑一遍（幂等，只写实际变化的文件）。
      // 不做成「⋯」菜单里的一次性动作：格式修复是**维护**，用户既不知道哪篇坏在哪，
      // 也没理由记住「要去点一下」；修过一次之后，此后每次打开都只是一遍内存扫描、零写盘。
      const repair = await repairNotesOnLoad(fileMap);
      if (repair.repaired || repair.failed) setAutoRepair(repair);
      if (cancelled) return;
      setLinkIndex(rebuildLinkIndex(fileMap));
      applyDocs(fileMap);
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
  }, [reloadKey, applyDocs]);

  /** 重新加载知识库（错误页的「重试」按钮） */
  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoaded(false);
    setReloadKey((k) => k + 1);
  }, []);

  /** 桌面端：更换库文件夹（设置入口）。选定后重申授权、重建适配器并整库重载；
   *  新文件夹为空且浏览器里还有数据时，重载过程会自动做一次性迁移。用户取消返回 null。 */
  const changeVaultFolder = useCallback(async (): Promise<string | null> => {
    if (!isTauri()) throw new Error('浏览器版数据存在浏览器里，没有文件夹库');
    const dir = await pickVaultFolder();
    if (!dir) return null;
    await authorizeVaultDir(dir); // 先授权再切换：失败则保持原库不动，错误抛给调用方提示
    storeVaultDir(dir);
    adapter = new TauriAdapter(dir);
    setLoaded(false);
    setReloadKey((k) => k + 1);
    return dir;
  }, []);

  /** 记下某路径当前的磁盘 mtime（打开笔记 / 写盘成功后调用）。
   *  文件不存在就清掉记录——新建笔记本就没有基线可比。 */
  const syncDiskMtime = useCallback(async (path: string) => {
    const meta = await adapter.stat(path).catch(() => null);
    if (meta) diskMtimesRef.current.set(path, meta.mtime);
    else diskMtimesRef.current.delete(path);
  }, []);

  /** 打开笔记时记下基线：保存前的冲突检测要拿它当基准。 */
  useEffect(() => {
    if (!currentPath) return;
    void syncDiskMtime(currentPath);
  }, [currentPath, syncDiskMtime]);

  /** 写盘前的外部改动检测。
   *  mtime 与基线不一致 = 这个文件在应用之外被改过（外部编辑器 / 另一个窗口 / 同步盘）。
   *  mtime 只是廉价闸门，真正判定用内容：`touch` 改 mtime 不改内容、以及我们自己刚写过的
   *  那一版，磁盘内容都会与内存里的上一版相同，不该留档。只有磁盘内容既不是我们要写的、
   *  也不是我们内存里那一版时，才把磁盘上的版本推进历史版本（可在「历史版本」面板找回），
   *  然后照常落盘——用户的应用内编辑不被打断，别人的改动也不会被静默吃掉。 */
  const keepExternalEdit = useCallback(async (path: string, incoming: string) => {
    const known = diskMtimesRef.current.get(path);
    if (known === undefined) return; // 本次会话没打开也没写过 → 没有基线，直接写
    const meta = await adapter.stat(path).catch(() => null);
    if (!meta || meta.mtime === known) return;
    const onDisk = await adapter.read(path).catch(() => null);
    if (onDisk === null || onDisk === incoming) return;
    if (onDisk === docsRef.current.get(path)) return; // 只是 mtime 变了，内容还是我们那一版
    await pushSnapshot(path, onDisk);
  }, []);

  /** 保存：先落盘、再更新内存。写失败会抛出，调用方据此提示——不能乐观更新内存，
   *  否则 IndexedDB 写失败时界面照样显示「已保存 ✓」、脏点也消失，用户会在
   *  「应用说存住了」的前提下丢稿。同一路径的写通过 enqueueWrite 串行落盘（见
   *  writeQueues 注释），杜绝「先发后到」的 rename 覆盖；内存更新仍在各自的 Promise
   *  里按序进行。 */
  const save = useCallback(async (path: string, content: string) => {
    const safePath = safeVaultPath(path);
    if (!safePath) throw new Error('文件路径不安全');
    await enqueueWrite(safePath, async () => {
      const previous = docsRef.current.get(safePath);
      const structureChanged = !docsRef.current.has(safePath)
        || linkMetadataSignature(safePath, previous) !== linkMetadataSignature(safePath, content);
      // 先看这个文件有没有被应用之外的东西改过：有就留档，再落盘（见 keepExternalEdit）
      await keepExternalEdit(safePath, content);
      await adapter.write(safePath, content);
      await syncDiskMtime(safePath);
      const next = new Map(docsRef.current).set(safePath, content);
      applyDocs(next);
      updateLinksForPath(linkIndex, safePath, content);
      if (structureChanged) {
        setStructureDocs(next);
      }
      void pushSnapshot(safePath, content);
    });
  }, [linkIndex, keepExternalEdit, syncDiskMtime, applyDocs]);

  /** 删除：先落盘、再改内存；失败抛出且内存保持原样（不会再「删了重启又回来」）。
   *  同样进同路径写队列：避免「删除刚完成、自动保存的 rename 又把文件写回来」。 */
  const remove = useCallback(async (path: string) => {
    const safePath = safeVaultPath(path);
    if (!safePath) throw new Error('文件路径不安全');
    await enqueueWrite(safePath, async () => {
      await adapter.remove(safePath);
      diskMtimesRef.current.delete(safePath); // 文件没了，基线一并作废
      const next = new Map(docsRef.current);
      next.delete(safePath);
      applyDocs(next);
      if (safePath.endsWith('.md')) setStructureDocs(next);
      updateLinksForPath(linkIndex, safePath, '');
      setCurrentPath((cur) => (cur === safePath ? null : cur));
    });
  }, [linkIndex, applyDocs]);

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
    applyDocs(next);
    if ([...del].some((p) => p.endsWith('.md'))) setStructureDocs(next);
    for (const p of del) updateLinksForPath(linkIndex, p, '');
    setCurrentPath((cur) => (cur && del.has(cur) ? null : cur));
    return failed;
  }, [linkIndex, applyDocs]);

  /** 导出全部笔记为单个 .json 备份文件（直接用内存缓存）。
   *  v7 起把二进制附件也以 dataURL 并入 files：此前新附件库只进 ZIP 导出，用户以为
   *  「备份到 .json」就是全部，换设备才发现图片全丢。旧版残留的 dataURL 附件原样保留。 */
  const exportAll = useCallback(async () => {
    const fileMap = new Map<string, string>();
    for (const [path, content] of docs) {
      if (path.endsWith('.md') || path.startsWith('_attachments/')) fileMap.set(path, content);
    }
    // 新附件库（Blob）并入备份：转不成 dataURL 的跳过，不阻塞整包导出
    for (const [path, blob] of attachments) {
      if (fileMap.has(path)) continue;
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl) fileMap.set(path, dataUrl);
    }
    const files = [...fileMap].map(([path, content]) => ({ path, content }));
    const payload = {
      app: 'knowlattice',
      version: 12,
      exportedAt: new Date().toISOString(),
      files,
      // v2 起随备份保存 SRS 复习调度进度（旧版备份无此字段，导入时自动跳过）
      srs: exportSrsState(),
      // 题库与错题一并备份（v2 增量字段，旧版本导入时忽略）
      qbanks: await exportQbanks(),
      qbankStats: await exportQuestionStats(),
      // v11 起补上收藏/重点题：与逐题统计分开存（见 core/qbankStarred），不随备份走就会在换设备时全丢
      stars: await exportStars(),
      mistakes: loadMistakes(),
      // v3 起补上待办与打卡：这两样此前只活在 localStorage 里，备份不到、换设备即丢
      todos: exportTodos(),
      days: exportDays(),
      // 元认知校准桶：与 days 同属 localStorage 小数据，不随备份走就会丢；旧备份无此字段时导入自动跳过
      calibration: exportCalibration(),
      // v4 起补上卡片自定义（改写正/背面、删卡）：和待办同一类问题，不随备份走就会丢
      cardEdits: exportCardEdits(),
      // v9 起补上笔记媒体挂载（哪篇笔记配了哪个音频/字幕，见 core/noteMedia 头部说明为何存
      // localStorage 而不写 frontmatter）。与 cardEdits 同一性质的 localStorage 小数据，
      // 不随备份走就会在换设备时丢掉全部挂载关系——附件还在，界面却不知道该挂给谁。
      noteMedia: exportNoteMedia(),
      // v10 起补上思维导图的节点样式（字号/粗斜/颜色/形状，见 core/mindmapNodeStyles 头部：
      // 与 noteMedia 同性质的 localStorage 小数据，键 = 笔记路径 → 节点文本路径）。
      // 不随备份走就会在换设备时丢掉全部手工调过的格式。
      mindmapStyles: exportNoteStyles(),
      // v11 起补上思维导图的关系线与概要（core/mindmapMarks）：端点按**节点文本路径**记录，
      // 所以笔记改名/换设备后仍能重建；同 mindmapStyles 一样是应用侧状态，正文不动。
      mindmapMarks: exportMarks(),
      // v12 起补上思维导图的**呈现偏好**（布局方向/主题/视图/连线/编号，core/mindmapPrefs）。
      // 它是三类导图状态里唯一不随备份走的一份：丢了不丢数据，但换设备后每篇笔记的观感都要重设。
      mindmapPrefs: exportMindMapPrefs(),
      // v5 起补上专注周期专注记录：工作台的「今日/累计/趋势」全靠它，丢了就等于白专注
      pomodoros: exportPomodoros(),
      pathwayTemplates: await exportPathwayTemplates(),
      // v8 起补上复习计划/每日提醒与本地速查：又一批只活在 localStorage 里的小数据，
      // 不随备份走就会在换设备时无声消失（计划与提醒要重设、速查答案全丢）。
      reviewPlan: exportPlan(),
      reminder: exportReminder(),
      localRecall: exportRecall(),
      // v10 起补上模拟考试成绩历史与每日一练进度：又一批只活在 localStorage 里的小数据，
      // 不随备份走就会在换设备时无声消失（考试历史清空、每日一练连续天数归零）。
      examHistory: exportExamHistory(),
      daily: exportDaily(),
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
  }, [docs, attachments]);

  /** 从备份 .json 恢复（**只补不覆盖**）：目标路径不存在才写入；已存在且内容不同 → 把备份里
   *  那一篇另存到 `恢复冲突/…`（两份都留）；已存在且内容完全相同 → 跳过；附件已存在 → 保留现有。
   *  localStorage 各存储逐条合并、键已存在保留现有值、只补新键。笔记/复习进度/题库/错题一并恢复。
   *  旧版备份里的 dataURL 附件会自动转回 Blob 附件库；恢复后直接并入内存缓存，不再全库重读存储。 */
  const importBackup = useCallback(async (text: string): Promise<ImportResult> => {
    const data = JSON.parse(text) as {
      app?: string;
      version?: number;
      files?: { path: string; content: string }[];
      srs?: unknown;
      qbanks?: unknown;
      qbankStats?: unknown;
      stars?: unknown;
      mistakes?: unknown;
      todos?: unknown;
      days?: unknown;
      calibration?: unknown;
      cardEdits?: unknown;
      pomodoros?: unknown;
      pathwayTemplates?: unknown;
      reviewPlan?: unknown;
      reminder?: unknown;
      localRecall?: unknown;
      noteMedia?: unknown;
      mindmapStyles?: unknown;
      mindmapMarks?: unknown;
      mindmapPrefs?: unknown;
      examHistory?: unknown;
      daily?: unknown;
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
    // 先做格式修正，再拿**修正好之后**的内容做比对：写出去的就是这一份，只有和它相同才算「没变化」。
    // （修正本身是幂等的，所以第二次恢复同一份备份仍能识别为「内容相同」。）
    const repaired = repairEntries(notes);
    const legacyAttachments = valid.filter((f) => f.path.startsWith('_attachments/'));

    // 这次恢复**一篇现有笔记都不会被覆盖**：查「路径是否存在」只为三分类
    // （不存在→新增 / 相同→跳过 / 不同→另存冲突副本，见 core/restoreMerge）。
    const lookup = async (path: string): Promise<ExistingFile> => {
      // 内存是启动时 readAll 的完整快照，命中即为最新；没有才问存储层（拿不到内容时给 null，
      // planMerge 会保守地当冲突处理，绝不会静默覆盖）。
      const cached = docsRef.current.get(path);
      if (cached !== undefined) return { exists: true, content: cached };
      return { exists: await adapter.exists(path), content: null };
    };
    const plan = await planMerge(repaired.entries, lookup, {
      conflictRoot: '恢复冲突',
      conflictLabel: '恢复',
      // 同一批共用一个时间戳：同一份备份的冲突文件名稳定可复现（不用 Math.random）。
      timestamp: formatConflictStamp(new Date()),
    });

    const addFailedSet = new Set(await writeMany(plan.toAdd));
    const conflictFailedSet = new Set(await writeMany(plan.toConflict));
    // 只把**真正写成功**的条目并入内存：写失败的若也并入，当前会话看着一切正常、还弹
    // 「已恢复 N 篇」，刷新后才永久缺失——这是最难事后归因的一类数据丢失。
    const okEntries = plan.entries.filter((e) => {
      if (e.verdict === 'add') return !addFailedSet.has(e.path);
      if (e.verdict === 'conflict') return !conflictFailedSet.has(e.conflictPath!);
      return false;
    });
    const okPaths = new Set(okEntries.map((e) => e.path));
    const repairedFiles = repaired.repairedFiles.filter((f) => okPaths.has(f.path));

    // 附件：已存在就**跳过并保留现有**（不另存副本、不覆盖）。现有笔记引用的正是现有附件，
    // 替换会悄悄改变历史笔记的显示内容——比丢一篇笔记更隐蔽，所以这里绝不动它。
    const restoredAttachments = new Map<string, Blob>();
    /** 转不成 Blob、只能按原文当笔记文件存回去的旧附件 */
    const keptAsFile = new Set<string>();
    let addedAttachments = 0;
    let skippedAttachments = 0;
    let attachFailed = 0;
    for (const f of legacyAttachments) {
      if (await adapter.existsAttachment(f.path).catch(() => false)) {
        skippedAttachments++;
        continue;
      }
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
        addedAttachments++;
      } catch (e) {
        console.error('附件恢复失败：', f.path, e);
        attachFailed++;
      }
    }

    // ---- localStorage 各存储：逐条合并、键已存在则保留现有值、只补新键；逐存储报告「新增/已存在」----
    // 每个 if 把关：缺字段直接跳过——v1–v9 旧备份照旧能恢复成功，不会被误判成「格式不正确」。
    const storeMerges: StoreMerge[] = [];
    if (data.srs) {
      storeMerges.push(await mergeObjectStore('复习调度', data.srs, exportSrsState(), (p) => { importSrsState(p); }));
    }
    if (data.qbanks) {
      const cur = await exportQbanks();
      storeMerges.push(await mergeListStore('题库', data.qbanks, new Set(cur.map((b) => b.name)), (it) => (typeof it.name === 'string' ? it.name : undefined), (p) => importQbanks(p)));
    }
    if (data.qbankStats) {
      // 题库统计是 (题库 → 题目 → 值) 两层对象：按 (题库,题目) 键过滤，现有键保留、只补新键
      const cur = await exportQuestionStats();
      const { fresh, added, kept } = pickNewQuestionStats(data.qbankStats, cur);
      if (added > 0) await importQuestionStats(fresh);
      storeMerges.push({ name: '题库统计', added, kept });
    }
    if (data.stars) {
      // 收藏题同样是 (题库 → 题目) 两层：逐键只补不覆盖，已有键保留、只补新键
      const cur = await exportStars();
      const { fresh, added, kept } = pickNewStars(data.stars, cur);
      if (added > 0) await importStars(fresh);
      storeMerges.push({ name: '收藏题', added, kept });
    }
    if (data.mistakes) {
      storeMerges.push(await mergeObjectStore('错题', data.mistakes, loadMistakes(), (p) => { importMistakes(p); }));
    }
    if (data.todos) {
      const cur = exportTodos();
      storeMerges.push(await mergeListStore('待办', data.todos, new Set(cur.map((t) => t.id)), (it) => (typeof it.id === 'string' ? it.id : undefined), (p) => importTodos(p)));
    }
    if (data.days) {
      storeMerges.push(await mergeObjectStore('打卡', data.days, exportDays(), (p) => { importDays(p); }));
    }
    if (data.calibration) {
      // importCalibration 是**整体覆盖**写（用收到的对象重建存储），所以传「现有 ∪ 新增」而非只传新键
      storeMerges.push(await mergeObjectStore('元认知校准', data.calibration, exportCalibration(), (p) => { importCalibration(p); }, true));
    }
    if (data.cardEdits) {
      storeMerges.push(await mergeObjectStore('卡片自定义', data.cardEdits, exportCardEdits(), (p) => { importCardEdits(p); }));
    }
    /* v9 起新增的笔记媒体挂载（音频/字幕附件，core/noteMedia）。**v8 及更早的备份没有这个字段**：
       整段由 `if` 把关，缺字段就直接跳过，旧备份照旧导入成功，不会被判成「格式不正确」。
       这里的键是**笔记路径**；该路径此刻在不在库里无所谓——备份里提到的笔记可能还没恢复
       过来、或已改名（noteMedia.ts 头部写明：键即路径，改名等于换键，旧挂载变孤儿）。所以
       不按「当前库是否有该路径」过滤、更不因此报错：等那个路径回来就能用上。 */
    if (data.noteMedia) {
      storeMerges.push(await mergeObjectStore('笔记媒体', data.noteMedia, exportNoteMedia(), (p) => { importNoteMedia(p); }));
    }
    /* v10 起新增的思维导图节点样式（core/mindmapNodeStyles）。**v9 及更早的备份没有这个字段**：
       整段由 `if` 把关，缺字段直接跳过。键是「笔记路径 → 节点文本路径」，与笔记当前在不在库里
       无关（备份里的笔记可能还没恢复过来、或已改名），所以同样不按当前库过滤。 */
    if (data.mindmapStyles) {
      storeMerges.push(await mergeObjectStore('导图样式', data.mindmapStyles, exportNoteStyles(), (p) => { importNoteStyles(p); }));
    }
    /* v11 起新增的关系线/概要（core/mindmapMarks）。v10 及更早的备份没有这个字段：整段由 if 把关。 */
    if (data.mindmapMarks) {
      storeMerges.push(await mergeObjectStore('导图标记', data.mindmapMarks, exportMarks(), (p) => { importMarks(p); }));
    }
    /* v12 起新增的导图偏好（布局/主题/视图/连线/编号，core/mindmapPrefs）。v11 及更早的备份没有这个
       字段：整段由 if 把关。当初有意不接（理由写在那个文件头里）——它丢了不丢数据，但换了设备
       每篇笔记的观感都要一篇篇重设，而形状与 core/noteMedia 完全一致，接一行就够。 */
    if (data.mindmapPrefs) {
      storeMerges.push(await mergeObjectStore('导图偏好', data.mindmapPrefs, exportMindMapPrefs(), (p) => { importMindMapPrefs(p); }));
    }
    if (data.pomodoros) {
      const cur = exportPomodoros();
      storeMerges.push(await mergeListStore('专注记录', data.pomodoros, new Set(cur.map((r) => r.id)), (it) => (typeof it.id === 'string' ? it.id : undefined), (p) => importPomodoros(p)));
    }
    if (data.pathwayTemplates) {
      const cur = await exportPathwayTemplates();
      storeMerges.push(await mergeListStore('路径模板', data.pathwayTemplates, new Set(cur.map((t) => t.id)), (it) => (typeof it.id === 'string' ? it.id : undefined), (p) => importPathwayTemplates(p)));
    }
    // 复习计划 / 每日提醒是**单例配置**（没有「键」）：已经设过就保留现有、不覆盖；没设过才用备份里的
    if (data.reviewPlan) {
      const cur = exportPlan();
      const configured = Boolean(cur.examDate || cur.examLabel || cur.dailyCap);
      storeMerges.push(configured
        ? { name: '复习计划', added: 0, kept: 1 }
        : { name: '复习计划', added: importPlan(data.reviewPlan) ? 1 : 0, kept: 0 });
    }
    if (data.reminder) {
      const cur = exportReminder();
      const configured = cur.enabled || Boolean(cur.lastFired);
      storeMerges.push(configured
        ? { name: '每日提醒', added: 0, kept: 1 }
        : { name: '每日提醒', added: importReminder(data.reminder) ? 1 : 0, kept: 0 });
    }
    if (data.localRecall) {
      storeMerges.push(await mergeObjectStore('本地速查', data.localRecall, exportRecall(), (p) => { importRecall(p); }));
    }
    if (data.examHistory) {
      const cur = exportExamHistory();
      storeMerges.push(await mergeListStore('考试历史', data.examHistory, new Set(cur.map((r) => r.id)), (it) => (typeof it.id === 'string' ? it.id : undefined), (p) => importExamHistory(p)));
    }
    if (data.daily) {
      storeMerges.push(await mergeObjectStore('每日一练', data.daily, exportDaily(), (p) => { importDaily(p); }));
    }

    // 并入内存缓存 + 增量更新链接索引（新增的与冲突另存的都算「这次写进去的」）
    const next = new Map(docsRef.current);
    for (const e of okEntries) next.set(e.verdict === 'conflict' ? e.conflictPath! : e.path, e.content);
    for (const f of legacyAttachments) {
      if (keptAsFile.has(f.path)) next.set(f.path, f.content);
    }
    applyDocs(next);
    setAttachments((prev) => {
      const next = new Map(prev);
      for (const [path, blob] of restoredAttachments) next.set(path, blob);
      return next;
    });
    for (const e of okEntries) updateLinksForPath(linkIndex, e.verdict === 'conflict' ? e.conflictPath! : e.path, e.content);
    if (okEntries.length > 0) {
      setStructureDocs(next);
    }
    const addedNotes = okEntries.filter((e) => e.verdict === 'add').length;
    const conflictFiles = okEntries.filter((e) => e.verdict === 'conflict').map((e) => e.conflictPath!);
    return {
      ok: addedNotes,
      failed: addFailedSet.size + conflictFailedSet.size + attachFailed + invalidFiles,
      repaired: repairCount(repairedFiles),
      repairedFiles,
      // 只补不覆盖后不会再覆盖任何现有文件，恒为空数组（保留字段不改既有语义）
      overwritten: [],
      addedNotes,
      conflictNotes: conflictFiles.length,
      conflictFiles,
      unchangedNotes: plan.unchanged,
      addedAttachments,
      skippedAttachments,
      storeMerges,
    };
  }, [linkIndex, applyDocs]);

  /** 导入 md 文件夹 / 资料导入通道（**只补不覆盖**）：目标路径不存在才写入；已存在且内容不同 →
   *  把来源那一篇另存到 `导入冲突/…`（两份都留）；内容完全相同 → 跳过。返回真实成功/失败篇数。
   *  为什么这条通道也改成只补不覆盖：它是「导入别人 / 别处的文件」的入口，用户自己改过的笔记
   *  不能被一份外来文件整篇替换（此前的覆盖写是真实丢数据风险，且不推历史快照、覆盖后不可恢复）。 */
  const importMdFiles = useCallback(async (files: Array<{ path: string; content: string }>): Promise<ImportResult> => {
    const valid: Array<{ path: string; content: string }> = [];
    let invalidFiles = 0;
    for (const f of files) {
      const p = safeVaultPath(f.path);
      if (!p || !p.toLowerCase().endsWith('.md') || typeof f.content !== 'string') { invalidFiles++; continue; }
      valid.push({ path: p, content: f.content });
    }
    // 与 importBackup 同一套规则与命名（复用 core/restoreMerge），只是根目录标成「导入冲突」
    const repaired = repairEntries(valid);
    const lookup = async (path: string): Promise<ExistingFile> => {
      const cached = docsRef.current.get(path);
      if (cached !== undefined) return { exists: true, content: cached };
      return { exists: await adapter.exists(path), content: null };
    };
    const plan = await planMerge(repaired.entries, lookup, {
      conflictRoot: '导入冲突',
      conflictLabel: '导入',
      // 同一批共用一个时间戳：稳定可复现，不用 Math.random
      timestamp: formatConflictStamp(new Date()),
    });
    const addFailedSet = new Set(await writeMany(plan.toAdd));
    const conflictFailedSet = new Set(await writeMany(plan.toConflict));
    // 只把真正写成功的并入内存（写失败的不进内存，避免「看着成功、刷新后缺失」）
    const okEntries = plan.entries.filter((e) => {
      if (e.verdict === 'add') return !addFailedSet.has(e.path);
      if (e.verdict === 'conflict') return !conflictFailedSet.has(e.conflictPath!);
      return false;
    });
    const okPaths = new Set(okEntries.map((e) => e.path));
    const repairedFiles = repaired.repairedFiles.filter((f) => okPaths.has(f.path));
    const next = new Map(docsRef.current);
    for (const e of okEntries) next.set(e.verdict === 'conflict' ? e.conflictPath! : e.path, e.content);
    applyDocs(next);
    for (const e of okEntries) updateLinksForPath(linkIndex, e.verdict === 'conflict' ? e.conflictPath! : e.path, e.content);
    if (okEntries.length > 0) {
      setStructureDocs(next);
    }
    const addedNotes = okEntries.filter((e) => e.verdict === 'add').length;
    const conflictFiles = okEntries.filter((e) => e.verdict === 'conflict').map((e) => e.conflictPath!);
    return {
      ok: addedNotes,
      failed: addFailedSet.size + conflictFailedSet.size + invalidFiles,
      repaired: repairCount(repairedFiles),
      repairedFiles,
      overwritten: [],
      addedNotes,
      conflictNotes: conflictFiles.length,
      conflictFiles,
      unchangedNotes: plan.unchanged,
    };
  }, [linkIndex, applyDocs]);

  /** 保存图片附件（Blob 存入独立 attachments store），返回 vault 相对路径；写失败抛出 */
  const saveAttachment = useCallback(async (filename: string, blob: Blob): Promise<string> => {
    const path = safeVaultPath(`_attachments/${filename}`);
    if (!path) throw new Error('附件路径不安全');
    await adapter.writeAttachment(path, blob);
    setAttachments((prev) => new Map(prev).set(path, blob));
    return path;
  }, []);

  /**
   * 列出「没有任何笔记引用」的附件（只算、不删）。判据见 core/attachmentOrphans。
   * 读的是**内存快照**（attachments 的键 = 全部附件，docsRef = 全部正文），与界面上看到的一致，
   * 不会因为磁盘上的脏数据多报或漏报。
   */
  const findOrphanAttachments = useCallback(
    // async 是刻意的：界面按 Promise 用它，而且下面要读题库存储（IndexedDB）
    async () => {
      const extra: string[] = [];   // 附件路径（结构化引用）
      const texts: string[] = [];   // 用户写的文字（可能贴着附件路径）
      // ① 音频/字幕：挂载关系在 localStorage（core/noteMedia），**正文里没有任何字符串**。
      //    漏掉这一条 → 用户挂着的音频/字幕会被列成「未被引用」，一确认就删掉，正文里的播放条当场断。
      for (const m of Object.values(exportNoteMedia())) {
        if (m.audio) extra.push(m.audio);
        if (m.subtitle) extra.push(m.subtitle);
      }
      // ② 题库：题干图/选项图是结构化引用；题干、选项、答案与解析里的文字也可能贴着附件路径。
      for (const bank of await exportQbanks()) {
        for (const q of bank.questions ?? []) {
          if (q.image) extra.push(q.image);
          for (const img of q.optionImages ?? []) if (img) extra.push(img);
          texts.push(q.stem ?? '', q.answerText ?? '', ...(q.options ?? []));
          for (const e of q.explanations ?? []) texts.push(e?.text ?? '');
          for (const n of q.optionNotes ?? []) if (n) texts.push(n);
        }
      }
      // ③ 通路模板与卡片自定义里存着用户写的 markdown/文字（模板正文、卡片正反面），同样可能引用附件。
      //    判定的方向是「宁可少删一个孤儿」：多算一处引用，最坏只是少清理掉一个文件。
      for (const t of await exportPathwayTemplates()) texts.push(t.markdown ?? '');
      for (const c of Object.values(exportCardEdits())) texts.push(c.front ?? '', c.back ?? '');
      return findOrphans([...attachments.keys()], [...docsRef.current.values(), ...texts], extra);
    },
    [attachments],
  );

  /**
   * 真删附件（返回值里给出删失败的清单）。
   *
   * 两道护栏都为了「绝不误删笔记」：
   *   ① 只接受 `_attachments/` 下的路径——这个入口只该删附件，路径再校验一道，将来某次调用
   *      即使把笔记路径传进来，也删不掉正文；
   *   ② 拒绝含 `..` 的路径（在 safeVaultPath 之外再挡一次纵深）。
   * 写盘成功才动内存（与 noteMedia「只并入真正写成功的」同一原则），并顺手释放对象 URL：
   * 否则删掉的文件还会继续占着 blob 引用。
   */
  const removeAttachments = useCallback(
    async (paths: string[]): Promise<{ removed: number; failed: string[] }> => {
      const safe = [...new Set(paths)].filter(
        (p) => typeof p === 'string' && p.startsWith('_attachments/') && !p.includes('..'),
      );
      const failed: string[] = [];
      const done: string[] = [];
      for (const p of safe) {
        try {
          await adapter.removeAttachment(p);
          done.push(p);
        } catch {
          failed.push(p);
        }
      }
      if (done.length) {
        const gone = new Set(done);
        setAttachments((prev) => {
          const next = new Map(prev);
          for (const p of gone) next.delete(p);
          return next;
        });
        for (const p of gone) {
          const url = attachmentUrlCache.current.get(p);
          if (url) {
            URL.revokeObjectURL(url);
            attachmentUrlCache.current.delete(p);
          }
        }
      }
      return { removed: done.length, failed };
    },
    [],
  );

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

  /** 桌面端专用：把此前存在浏览器 IndexedDB 里的笔记/附件一次性写入本机文件夹
   *  （<文档>/KnowLattice）。切换存储后端后，老用户的桌面端数据都还在 IndexedDB 里，
   *  不迁移的话界面上就像「笔记全丢了」。合并语义：同名覆盖，其余保留；幂等，可重复点。
   *  浏览器版不适用（源与目标都是同一个 IndexedDB），返回全 0。 */
  const migrateFromBrowser = useCallback(async (): Promise<{ notes: number; attachments: number; failed: number }> => {
    if (!isTauri()) return { notes: 0, attachments: 0, failed: 0 };
    const src = new WebAdapter();
    const fileMap = await src.readAll();
    const attachmentMap = await src.readAllAttachments();

    const notes: Array<{ path: string; content: string }> = [];
    /** 旧版（v1）把 dataURL 附件塞在 files store 里，单独转换处理 */
    const legacyAttachments: Array<{ path: string; content: string }> = [];
    for (const [rawPath, content] of fileMap) {
      const path = safeVaultPath(rawPath);
      if (!path) continue;
      if (path.startsWith('_attachments/')) legacyAttachments.push({ path, content });
      else notes.push({ path, content });
    }

    const failedPaths = await writeMany(notes);
    const failedSet = new Set(failedPaths);

    const migratedBlobs = new Map<string, Blob>();
    let attachFailed = 0;
    for (const [rawPath, blob] of attachmentMap) {
      const path = safeVaultPath(rawPath);
      if (!path) continue;
      try {
        await adapter.writeAttachment(path, blob);
        migratedBlobs.set(path, blob);
      } catch (e) {
        console.error('附件迁移失败：', path, e);
        attachFailed++;
      }
    }
    for (const f of legacyAttachments) {
      const blob = dataUrlToBlob(f.content);
      try {
        if (blob) {
          await adapter.writeAttachment(f.path, blob);
          migratedBlobs.set(f.path, blob);
        } else {
          // 转不成 Blob 的旧数据按原文写回，至少不丢
          await adapter.write(f.path, f.content);
        }
      } catch (e) {
        console.error('旧附件迁移失败：', f.path, e);
        attachFailed++;
      }
    }

    // 并入内存：迁移后无需整库重读，界面直接反映；只并入真正写成功的
    const okNotes = notes.filter((f) => !failedSet.has(f.path));
    if (okNotes.length > 0) {
      const next = new Map(docsRef.current);
      for (const f of okNotes) next.set(f.path, f.content);
      applyDocs(next);
      setStructureDocs(next);
      for (const f of okNotes) updateLinksForPath(linkIndex, f.path, f.content);
    }
    if (migratedBlobs.size > 0) {
      setAttachments((prev) => {
        const next = new Map(prev);
        for (const [p, b] of migratedBlobs) next.set(p, b);
        return next;
      });
    }
    return { notes: okNotes.length, attachments: migratedBlobs.size, failed: failedSet.size + attachFailed };
  }, [linkIndex, applyDocs]);

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
    /** 「清理未引用的附件」用：先算清单（只算不删），用户确认后再走 removeAttachments */
    findOrphanAttachments,
    removeAttachments,
    readFile,
    exportAll,
    exportMdFolder,
    importBackup,
    importMdFiles,
    /** 打开库时**自动**修正的 Markdown 格式报告（没有可修的为 null）。界面只拿它显示明细，
     *  不再是用户要点一下的动作——见 repairNotesOnLoad。 */
    autoRepair,
    migrateFromBrowser,
    changeVaultFolder,
    /** 当前 vault 目录（桌面端 = 默认根名或用户所选绝对路径；浏览器端 null），设置入口展示用 */
    vaultDir: isTauri() && adapter instanceof TauriAdapter ? adapter.root : null,
    adapter,
  };
}
