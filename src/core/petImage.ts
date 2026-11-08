/**
 * 桌宠自定义图片：IndexedDB 独立库 knowlattice-pet。
 *
 * 为什么不进 localStorage：图片 dataURL 轻松超过 5MB 配额，而桌宠只需要一张小图。
 * 存前先用 canvas 把任意来源缩到 256px 内（长边），单张 PNG 通常 <100KB。
 *
 * 存的是 Blob 而不是 dataURL：Blob 原样进出，不经 base64 膨胀 33%；
 * 读取时用 URL.createObjectURL，组件卸载时回收。
 * 图片存在不表示启用：开关在 knowlattice-pet 的 `image` 字段里，移除图片时两处一起清。
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'knowlattice-pet';
const STORE = 'img';
const KEY = 'custom';

/** 上传缩图的目标上限（长边，px） */
export const PET_IMAGE_MAX = 256;

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      },
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** 缩到长边 maxPx 内；PNG 保透明，其他统一转 PNG（桌宠需要透明底） */
export async function shrinkPetImage(file: Blob, maxPx = PET_IMAGE_MAX): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('shrinkPetImage 需要浏览器环境');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片无法解码'));
      el.src = url;
    });
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片编码失败');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function savePetImage(image: Blob): Promise<void> {
  const d = await db();
  await d.put(STORE, image, KEY);
}

export async function loadPetImage(): Promise<Blob | null> {
  try {
    const d = await db();
    const got = await d.get(STORE, KEY);
    return got instanceof Blob ? got : null;
  } catch {
    return null; // 无库（老数据 / 隐私模式）时当没有图片
  }
}

export async function clearPetImage(): Promise<void> {
  const d = await db();
  await d.delete(STORE, KEY);
}
