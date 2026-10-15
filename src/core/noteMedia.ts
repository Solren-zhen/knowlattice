/**
 * 笔记媒体附件：一篇笔记可以挂一段音频讲解 + 一份字幕文本（srt/vtt），
 * 界面据此渲染音频条与逐句字幕（views/MediaTrack.tsx）。
 *
 * **为什么挂载关系存 localStorage，而不是写进笔记 frontmatter**：
 * 写进 frontmatter 意味着**每一篇既有笔记**都会在下次保存时被重写（多出 `audio:` / `subtitle:`
 * 字段、字节数变化、外部同步工具一律判成"被改过"）——那是"老数据被迫迁移"，代价落在全部历史
 * 笔记上，换来的只是省一个键。而这份映射本质是**应用侧元数据**（"这篇笔记旁边挂了个播放器"
 * 这一界面状态），与 core/cardEdits（卡片自定义）完全同一性质，所以用同一种存法：单键
 * localStorage，随整包备份走（vault.ts 的 import/export 链）。
 *
 * 范式对齐 core/cardEdits：
 *   ① 单键 + 模块级缓存（界面每次渲染都会读）；
 *   ② 缓存按 **localStorage 原始字符串**比对，而不是"第一次读到就永远用它"——
 *      外部直接写存储（另一个标签页、备份导入、测试里 clear）时下一次读自动失效重解析。
 *
 * 已知边界（写在这里，免得下次以为是漏了）：
 *   - 键 = 笔记路径，所以**重命名/移动笔记**等于换了一个键，原挂载会变成孤儿（仍留在存储里，
 *     不会被清掉）；想清就手动 clearNoteMedia 或用原路径再挂一次；
 *   - 附件文件被删同理：这里只记路径，读不到文件由界面兜底；
 *   - 值只有两个路径字符串，没有 updatedAt —— "挂没挂、挂的是谁"看值本身即可。
 */

/** 一篇笔记的媒体挂载：两面都是 vault 相对路径（如 `_attachments/x.mp3`），空 = 没挂 */
export interface NoteMedia {
  audio?: string;
  subtitle?: string;
}

/** 键 = 笔记路径 */
export type NoteMediaMap = Record<string, NoteMedia>;

const KEY = 'knowlattice-note-media';

/** 缓存原文（localStorage 里的原始字符串）与解析结果；两者一起换，见文件头说明 */
let cacheRaw: string | null = null;
let cache: NoteMediaMap = {};

function pick(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** 读出整份映射；空/损坏的存储一律当空表 */
export function loadNoteMedia(): NoteMediaMap {
  let raw: string;
  try {
    raw = localStorage.getItem(KEY) ?? '{}';
  } catch {
    // 隐私模式等拿不到存储：退回上一次读到的内容，界面不至于白屏
    return cache;
  }
  if (raw === cacheRaw) return cache;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: NoteMediaMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as Partial<NoteMedia> | null;
      if (!e || typeof e !== 'object') continue;
      const audio = pick(e.audio);
      const subtitle = pick(e.subtitle);
      if (!audio && !subtitle) continue; // 空壳不留
      out[k] = { ...(audio ? { audio } : {}), ...(subtitle ? { subtitle } : {}) };
    }
    cache = out;
  } catch {
    cache = {};
  }
  cacheRaw = raw;
  return cache;
}

function save(map: NoteMediaMap) {
  cache = map;
  cacheRaw = JSON.stringify(map);
  localStorage.setItem(KEY, cacheRaw);
}

/**
 * 取一篇笔记的挂载；没挂返回 null。
 * 返回**副本**：调用方拿到后通常要拼成 patch 再存回去，原地改会污染模块缓存
 * （下一次读到的就是被改过的对象，而"存储里并没有"）。
 */
export function getNoteMedia(path: string): NoteMedia | null {
  const m = loadNoteMedia()[path];
  return m ? { ...m } : null;
}

/**
 * 写入/更新一篇笔记的挂载。语义是**逐字段合并**（patch）：
 *   - 传了的字段 → 用它（trim 后为空串 = 清掉这一面）；
 *   - 没传的字段 → 保持原样（换音频不会顺手把字幕丢了——界面上本来就是两个独立动作）。
 * 合并后两面都空 → 整条记录删掉（不留空壳），返回的映射里就没有这个键了。
 *
 * 一律返回**新对象**：视图把它放进 React state，原地改再返回同一引用会被判定为"没变化"
 * 而不重渲染——存储对了、界面不动，是最难查的一类假成功（同 core/cardEdits）。
 *
 * `now` 是为了跟 core/cardEdits 的 saveCardEdit 保持同一签名（调用方不必记两套），
 * 但这份映射的值只有两个路径、没有 updatedAt 字段，时间戳暂时没有落点：这里明确
 * `void` 掉，表示"有意忽略"，而不是漏用参数。
 */
export function saveNoteMedia(path: string, patch: NoteMedia, now = Date.now()): NoteMediaMap {
  void now;
  const key = path.trim();
  const prev = loadNoteMedia()[key];
  const audio = patch.audio === undefined ? prev?.audio : patch.audio.trim() || undefined;
  const subtitle = patch.subtitle === undefined ? prev?.subtitle : patch.subtitle.trim() || undefined;
  const map: NoteMediaMap = { ...loadNoteMedia() };
  if (!audio && !subtitle) delete map[key];
  else map[key] = { ...(audio ? { audio } : {}), ...(subtitle ? { subtitle } : {}) };
  save(map);
  return map;
}

/** 卸载一篇笔记的媒体（音频与字幕一起摘掉）。返回新映射。 */
export function clearNoteMedia(path: string): NoteMediaMap {
  const map: NoteMediaMap = { ...loadNoteMedia() };
  delete map[path];
  save(map);
  return map;
}

/** 导出全部挂载（随整包备份走）；返回的是快照，改它不影响存储 */
export function exportNoteMedia(): NoteMediaMap {
  const out: NoteMediaMap = {};
  for (const [k, v] of Object.entries(loadNoteMedia())) out[k] = { ...v };
  return out;
}

/**
 * 从备份恢复（**合并**导入：同键覆盖，没提到的键原样留着）；返回导入了几条。
 * 非法输入不抛错、也不动已存数据：备份是用户手里的文件，坏一条不该毁掉整份挂载表。
 */
export function importNoteMedia(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const map: NoteMediaMap = { ...loadNoteMedia() };
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<NoteMedia> | null;
    if (!e || typeof e !== 'object') continue;
    const audio = pick(e.audio);
    const subtitle = pick(e.subtitle);
    if (!audio && !subtitle) continue;
    map[k] = { ...(audio ? { audio } : {}), ...(subtitle ? { subtitle } : {}) };
    n++;
  }
  save(map);
  return n;
}

/** 音频扩展名（按**文件名末尾**匹配：带查询串的 URL 不算，那是网络地址不是 vault 路径） */
export const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|webm|aac|flac)$/i;

/** 字幕扩展名 */
export const SUBTITLE_EXT = /\.(srt|vtt)$/i;

/**
 * 从 vault 路径列表里挑出可当音频/字幕的附件。
 * 只看**文件名**的扩展名（目录名里带 `.mp3` 不算），各自按路径升序返回——
 * 顺序稳定，界面上的下拉列表才不会每次刷新都换序。
 */
export function pickMediaAttachments(paths: string[]): { audio: string[]; subtitle: string[] } {
  const audio: string[] = [];
  const subtitle: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    // 音频优先：`.ogg` 既是音频容器也是视频容器，本轮按音频用（AUDIO_EXT 里已经列了）
    if (AUDIO_EXT.test(name)) audio.push(p);
    else if (SUBTITLE_EXT.test(name)) subtitle.push(p);
  }
  const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { audio: audio.sort(asc), subtitle: subtitle.sort(asc) };
}
