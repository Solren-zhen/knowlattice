/**
 * 图片库的纯逻辑：把 vault 里的附件路径整理成「可浏览的图片条目」。
 *
 * 为什么单独一层：附件是 Blob，路径清单是字符串数组，两者都在 vault 里；而
 * 「哪些算图片、按什么顺序、显示什么名字」是纯粹的展示决策。放进视图会让
 * 排序/过滤规则跟 DOM 搅在一起，改一次排序就得点一遍界面。
 */
import { IMAGE_EXT_RE, isImagePath } from './imageRef';

export interface ImageEntry {
  /** vault 相对路径（含 `_attachments/`），插入笔记时原样用 */
  path: string;
  /** 文件名（不含目录） */
  name: string;
  /** 所在目录（`_attachments` 等），用于同名不同目录时区分 */
  dir: string;
}

/**
 * 附件路径 → 图片条目。
 *
 * - 只留图片（png/jpg/gif/webp/svg/bmp/avif），别的附件（pdf/docx）不进这个库；
 * - 排序按路径字典序：稳定、可预期，避免每次打开顺序乱跳（用户按位置找图）；
 * - `favicon.ico` 这类不算：IMAGE_EXT_RE 本身不含 ico，保持白名单不扩张。
 */
export function imageEntries(paths: readonly string[]): ImageEntry[] {
  const out: ImageEntry[] = [];
  for (const path of paths) {
    if (!isImagePath(path)) continue;
    const cleaned = path.replace(/^\/+/, '');
    const slash = cleaned.lastIndexOf('/');
    out.push({
      // 路径也去掉前导斜杠：`/_attachments/a.png` 与 `_attachments/a.png` 是同一份附件，
      // 但排序时会排到两处，插入笔记的链接也跟着带个多余的斜杠
      path: cleaned,
      name: slash === -1 ? cleaned : cleaned.slice(slash + 1),
      dir: slash === -1 ? '' : cleaned.slice(0, slash),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 按文件名/目录过滤（大小写不敏感）；空查询原样返回，避免每次输入都重建数组 */
export function filterImages(entries: readonly ImageEntry[], query: string): ImageEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries as ImageEntry[];
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
}

/**
 * 插入笔记用的 Markdown。
 *
 * 路径里有空格/括号时必须用 `<...>` 包起来，否则 `![](a b.png)` 会被解析成
 * 图片地址 `a` + 说明文字 `b.png` —— 图直接裂掉，而且看起来像「图没了」。
 * 中文文件名不用包（markdown-it 认），但统一包起来也不会错，所以只按需包。
 */
export function imageMarkdown(path: string, alt = ''): string {
  const needsAngle = /[\s()<>]/.test(path);
  const target = needsAngle ? `<${path}>` : path;
  return `![${alt}](${target})`;
}

/** 供界面显示的一句话统计：「12 张图片（_attachments）」 */
export function imageLibSummary(entries: readonly ImageEntry[]): string {
  // 空库只说数量：具体「为什么是空的、怎么才会有图」由面板的空状态讲一遍就够，
  // 同一句话在标题和生活里各出现一次，读起来像两处不同的错。
  if (!entries.length) return '0 张图片';
  const dirs = new Set(entries.map((e) => e.dir).filter(Boolean));
  const where = dirs.size === 1 ? `（${[...dirs][0]}）` : dirs.size ? `（${dirs.size} 个目录）` : '';
  return `${entries.length} 张图片${where}`;
}

export { IMAGE_EXT_RE };
