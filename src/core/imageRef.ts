/**
 * 图片引用的解析规则（纯函数，编辑器实时预览与右侧预览共用一份）。
 *
 * 对齐 Obsidian 的两处约定：
 * ① 尺寸写法：`![[图.png|300]]` 宽 300、`![[图.png|640x480]]` 宽高都钉，
 *    `|` 后面不是数字就是说明文字（alt）—— Obsidian 的既有语义，用户的库里真在用
 *    （例如 `![[fig/间断点1-可去.png|300]]`）。
 * ② 找文件：先按写的路径找，再按 `_attachments/` 前缀找；只写了文件名时，
 *    在整个附件库里按文件名唯一匹配（Obsidian 的 shortest path 语义）。
 *    重名算歧义 —— 宁可显示「未导入」，也不猜错一张图。
 */

/** 认得出来的图片后缀（与 core/livePreview 的图片部件、附件落盘口径一致） */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path);
}

/** 附件目录：vault 根下唯一的外置附件目录（见 vault.saveAttachment） */
export const ATTACHMENT_DIR = '_attachments/';

export interface EmbedSize {
  width?: number;
  height?: number;
}

export interface EmbedSpec {
  /** 目标路径（已去掉尺寸/说明部分） */
  name: string;
  /** 说明文字（alt）；没有说明时回落到文件名 */
  alt: string;
  size: EmbedSize;
}

/** `300` / `640x480` 才算尺寸；其余一律当说明文字 */
const SIZE_ONLY_RE = /^(\d+)$/;
const SIZE_BOX_RE = /^(\d+)\s*[x×]\s*(\d+)$/i;

/** 尺寸上限：Obsidian 里 `|99999` 这类笔误不该让浏览器去布局一张 10 万像素宽的图。
 *  超过上限按上限算（不是丢弃——丢弃会静默改掉用户的写法，按上限至少还看得见）。 */
export const MAX_EMBED_SIZE = 4000;

/** 0 与非法值一律当「没写尺寸」：`|0` 设成 width=0 等于把图藏起来 */
function clampSize(n: string): number | undefined {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(v, MAX_EMBED_SIZE);
}

/**
 * 解析 `目标|管道内容`（管道内容可省略）。
 * 返回值里的 name/alt 都已 trim；尺寸只在管道内容是数字时才给。
 */
export function parseEmbedSpec(raw: string): EmbedSpec {
  const bar = raw.indexOf('|');
  const name = (bar === -1 ? raw : raw.slice(0, bar)).trim();
  const pipe = bar === -1 ? '' : raw.slice(bar + 1).trim();
  const fallback = name.slice(name.lastIndexOf('/') + 1);
  const only = SIZE_ONLY_RE.exec(pipe);
  if (only) {
    const width = clampSize(only[1]);
    if (width) return { name, alt: fallback, size: { width } };
  }
  const box = SIZE_BOX_RE.exec(pipe);
  if (box) {
    const width = clampSize(box[1]);
    const height = clampSize(box[2]);
    if (width || height) return { name, alt: fallback, size: { width, height } };
  }
  return { name, alt: pipe || fallback, size: {} };
}

/** 文件名 → 唯一附件路径（重名记 null：歧义不猜）。keys 是附件库里的全部路径。 */
export function basenameIndex(keys: Iterable<string>): Map<string, string | null> {
  const byName = new Map<string, string | null>();
  for (const key of keys) {
    const name = key.slice(key.lastIndexOf('/') + 1);
    byName.set(name, byName.has(name) ? null : key);
  }
  return byName;
}

/**
 * 按 Obsidian 的顺序给出候选路径：
 *   ① 原样（正文里常写成 `_attachments/x.png` 或子目录相对路径）
 *   ② 加 `_attachments/` 前缀（写成 `fig/x.png`、`x.png` 的库）
 *   ③ 相对**当前笔记所在目录**（Obsidian 的「相对路径」写法：笔记与 fig/ 同级，
 *      正文写 `![[fig/x.png]]`）—— 同上再加一层 `_attachments/` 前缀
 *   ④ 只写了文件名时，按文件名唯一匹配（`basenameIndex` 的结果，歧义为 null 时不给候选）
 * 候选只列路径，是否存在由调用方判断（找不到返回 undefined，不抛错）。
 */
export function attachmentCandidates(
  path: string,
  byName: Map<string, string | null>,
  noteDir = ''
): string[] {
  const out: string[] = [];
  const push = (cand: string) => { if (cand && !out.includes(cand)) out.push(cand); };
  push(path);
  if (!path.startsWith(ATTACHMENT_DIR)) push(`${ATTACHMENT_DIR}${path}`);
  if (noteDir) {
    push(`${noteDir}${path}`);
    push(`${ATTACHMENT_DIR}${noteDir}${path}`);
  }
  if (!path.includes('/')) {
    const hit = byName.get(path);
    if (hit) push(hit);
  }
  return out;
}
