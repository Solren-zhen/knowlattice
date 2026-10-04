/**
 * 一次性迁移：IndexedDB（浏览器版存储）→ 所选文件夹（桌面端 vault）。
 *
 * 触发时机：桌面端启动（useVault 加载前）与「更换库文件夹」之后，由 vault.ts 调用。
 *
 * 幂等与重试语义（版本标记文件 = vault 根目录下 .knowlattice-migration.json）：
 * - 标记 status=done → 直接跳过，重复运行不会重复导入；
 * - 标记 status=pending → 上次运行中途失败，重跑迁移（逐文件原子写，覆盖同内容，安全）；
 * - 无标记且目标文件夹已有 .md 笔记 → 视为用户已有库，绝不动它（标记 done + skipped）；
 * - 无标记且目标为空 → 先写 pending 标记再迁移，全部写成功后才改写为 done；
 *   任何一步失败都不写 done，下次启动自动重试。
 *
 * 迁移内容：笔记写 <vault>/*.md（保留目录结构），附件写 <vault>/_attachments/**，
 * 旧版把 dataURL 附件塞在 files store 里的数据转成真实二进制。
 * 源数据（IndexedDB）迁移后原样保留，作为兜底备份，不做删除。
 */
import type { StorageAdapter } from './adapter';
import { WebAdapter } from './web';

export const MIGRATION_MARKER_PATH = '.knowlattice-migration.json';
const MARKER_VERSION = 1;

export interface FolderMigrationResult {
  /** 实际写入的笔记 / 附件数（skipped 时为 0） */
  notes: number;
  attachments: number;
  failed: number;
  /** true = 因 done 标记或目标非空而未执行迁移 */
  skipped: boolean;
}

interface MigrationMarker {
  version: number;
  status: 'pending' | 'done';
  notes: number;
  attachments: number;
  at: string;
}

/** 与 vault.safeVaultPath 同口径的宽松校验：只拦截越界路径，非法路径计为失败而不是中断整批 */
function isSafeRelPath(raw: string): boolean {
  if (!raw || raw.includes('\0')) return false;
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  return !p.split('/').some((s) => !s || s === '.' || s === '..');
}

async function readMarker(target: StorageAdapter): Promise<MigrationMarker | null> {
  try {
    const raw = await target.read(MIGRATION_MARKER_PATH);
    const m = JSON.parse(raw) as MigrationMarker;
    return m && m.version === MARKER_VERSION ? m : null;
  } catch {
    return null;
  }
}

async function writeMarker(target: StorageAdapter, status: MigrationMarker['status'], notes: number, attachments: number): Promise<void> {
  const marker: MigrationMarker = { version: MARKER_VERSION, status, notes, attachments, at: new Date().toISOString() };
  await target.write(MIGRATION_MARKER_PATH, JSON.stringify(marker, null, 2));
}

/** 目标文件夹是否已有 .md 笔记（readAll 只返回 .md）。
 *  注意：这里必须「读失败就抛」。适配器若把遍历失败伪装成空库，本函数会误判
 *  「目标为空」，紧接着就把 IndexedDB 快照写进用户已有的目录（同名覆盖，且写完
 *  即标记 done、以后不再迁移）——等于一次遍历失败吃掉整个库。 */
async function hasNotes(target: StorageAdapter): Promise<boolean> {
  return (await target.readAll()).size > 0;
}

export async function migrateIndexedDbToFolder(target: StorageAdapter): Promise<FolderMigrationResult> {
  const marker = await readMarker(target);
  if (marker?.status === 'done') return { notes: 0, attachments: 0, failed: 0, skipped: true };
  if (!marker && (await hasNotes(target))) {
    // 用户所选文件夹不是空的：一次字节都不写，直接标记完成，保护既有内容
    await writeMarker(target, 'done', 0, 0);
    return { notes: 0, attachments: 0, failed: 0, skipped: true };
  }

  const src = new WebAdapter();
  const fileMap = await src.readAll();
  const attachmentMap = await src.readAllAttachments();

  const notes: Array<{ path: string; content: string }> = [];
  /** 旧版（v1）把 dataURL 附件塞在 files store 里，转成真实二进制再写 */
  const legacyAttachments: Array<{ path: string; content: string }> = [];
  for (const [rawPath, content] of fileMap) {
    if (!isSafeRelPath(rawPath)) continue;
    if (rawPath.startsWith('_attachments/')) legacyAttachments.push({ path: rawPath, content });
    else notes.push({ path: rawPath, content });
  }
  const attachments: Array<{ path: string; blob: Blob }> = [];
  for (const [rawPath, blob] of attachmentMap) {
    if (isSafeRelPath(rawPath)) attachments.push({ path: rawPath, blob });
  }

  // 首次运行先立 pending 标记：此后任何中断都能被识别为「待续」，重复运行安全
  if (!marker) await writeMarker(target, 'pending', notes.length, attachments.length);

  let failed = 0;
  for (const n of notes) {
    try {
      await target.write(n.path, n.content);
    } catch (e) {
      console.error('笔记迁移失败：', n.path, e);
      failed++;
    }
  }
  let attachOk = 0;
  for (const a of attachments) {
    try {
      await target.writeAttachment(a.path, a.blob);
      attachOk++;
    } catch (e) {
      console.error('附件迁移失败：', a.path, e);
      failed++;
    }
  }
  for (const a of legacyAttachments) {
    try {
      const blob = dataUrlToBlob(a.content);
      if (blob) {
        await target.writeAttachment(a.path, blob);
        attachOk++;
      } else {
        // 转不成 Blob 的旧数据按原文写回，至少不丢
        await target.write(a.path, a.content);
      }
    } catch (e) {
      console.error('旧版附件迁移失败：', a.path, e);
      failed++;
    }
  }

  // 有失败就不写 done：下次启动（或手动迁移）自动重试
  if (failed > 0) return { notes: notes.length, attachments: attachOk, failed, skipped: false };
  await writeMarker(target, 'done', notes.length, attachOk);
  return { notes: notes.length, attachments: attachOk, failed: 0, skipped: false };
}

/** 旧版 dataURL 附件 → Blob（与 vault.ts 的启动迁移同逻辑；此处独立实现避免循环依赖） */
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
