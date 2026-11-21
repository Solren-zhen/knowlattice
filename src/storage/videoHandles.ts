/**
 * 本地视频文件句柄（File System Access API）持久化。
 *
 * 浏览器安全模型禁止把本地磁盘绝对路径写进 localStorage，也禁止跨刷新保留 blob URL。
 * 支持 `showOpenFilePicker` 的环境（Chromium / Edge / Windows WebView2）可以把
 * `FileSystemFileHandle` 结构化克隆进 IndexedDB；之后从「视频历史」或笔记锚点再次打开时，
 * 只需向浏览器校验/请求一次读取权限即可直接拿回原 `File`，无需每次重新找文件。
 * 不支持该 API 的环境全部安全降级成普通文件选择框。
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'knowlattice-video-handles';
const STORE = 'handles';

export interface LocalFileHandleLike {
  getFile(): Promise<File>;
  queryPermission?: (desc: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (desc: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
}

export interface PickedLocalVideo {
  file: File;
  handle: LocalFileHandleLike;
}

let dbPromise: Promise<IDBPDatabase | null> | null = null;

function getDb(): Promise<IDBPDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    }).catch(() => null);
  }
  return dbPromise;
}

/** 浏览器是否支持原生文件选择句柄（支持才能跨刷新直开）。 */
export function supportsLocalVideoPicker(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';
}

/** 用系统文件选择器挑一个视频，同时返回 File 与可持久化的句柄。取消返回 null，不支持或被环境拦截返回 'unsupported'。 */
export async function pickLocalVideoWithHandle(): Promise<PickedLocalVideo | null | 'unsupported'> {
  if (!supportsLocalVideoPicker()) return 'unsupported';
  const picker = (window as unknown as {
    showOpenFilePicker: (opts?: unknown) => Promise<LocalFileHandleLike[]>;
  }).showOpenFilePicker;
  try {
    const [handle] = await picker({
      multiple: false,
      types: [
        {
          description: '视频文件',
          accept: {
            'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogv', '.ogg'],
          },
        },
      ],
    });
    if (!handle) return null;
    const file = await handle.getFile();
    return { file, handle };
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
    if (name === 'AbortError') return null;
    return 'unsupported';
  }
}

/** 保存文件句柄到 IndexedDB（按 media 复合键索引）。 */
export async function saveLocalVideoHandle(media: string, handle: LocalFileHandleLike): Promise<boolean> {
  if (!media) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    await db.put(STORE, handle, media);
    return true;
  } catch {
    return false;
  }
}

/** 从 IndexedDB 恢复文件并校验读取权限；拿不到或用户拒绝时返回 null。 */
export async function openLocalVideoFromHandle(media: string): Promise<File | null> {
  if (!media) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const handle = (await db.get(STORE, media)) as LocalFileHandleLike | undefined;
    if (!handle || typeof handle.getFile !== 'function') return null;
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission({ mode: 'read' });
      if (state !== 'granted') {
        if (typeof handle.requestPermission !== 'function') return null;
        const next = await handle.requestPermission({ mode: 'read' });
        if (next !== 'granted') return null;
      }
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** 删除单条本地视频句柄。 */
export async function removeLocalVideoHandle(media: string): Promise<void> {
  if (!media) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.delete(STORE, media);
  } catch {
    /* 忽略 */
  }
}

/** 清空全部本地视频句柄。 */
export async function clearLocalVideoHandles(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.clear(STORE);
  } catch {
    /* 忽略 */
  }
}
