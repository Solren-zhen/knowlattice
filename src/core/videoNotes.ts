/**
 * 视频笔记：时间点锚点 + 片段书签。
 *
 * 锚点写成**普通 markdown 链接** `[▶ 12:34](#vn=754)`，不用自定义协议：
 * 编辑器对 `[x](url)` 走协议白名单（只放 http(s)/mailto），自定义 scheme 会被拦下报警；
 * fragment 形式的 `#vn=` 不会被误开窗，编辑器另行把它交给播放器 seek。
 *
 * 锚点写进笔记正文；片段收藏只存本机 localStorage（键 knowlattice-video-clips），
 * 与 noteMedia 的「挂载关系不进 frontmatter」保持一致：写进笔记等于强制重写全部历史数据。
 * 但片段**必须随整库备份走**（exportClips / importClips，接到 vault.exportAll 与 importBackup）：
 * 它和 noteMedia 一样是「用户一条条攒出来的记录」，不随备份走就会在换设备时无声消失。
 */
import { formatTime } from './subtitle';
import type { VideoSourceKind } from './videoSource';

export const ANCHOR_PREFIX = '#vn=';

/** 秒 → 锚点 href。向下取整：锚点要落在同一画面上，四舍五入会跳过头一帧。 */
export function anchorHref(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${ANCHOR_PREFIX}${s}`;
}

/** 从 href 里取回秒数；不是锚点返回 null（调用方据此决定是否当普通链接处理）。 */
export function parseAnchorHref(href: string | null | undefined): number | null {
  if (!href || !href.startsWith(ANCHOR_PREFIX)) return null;
  const n = Number(href.slice(ANCHOR_PREFIX.length));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 要插进笔记的那一段 markdown。`label` 是用户当场写的一句话，可空。 */
export function anchorMarkdown(seconds: number, label = ''): string {
  const text = label.trim();
  return `[▶ ${formatTime(seconds)}](${anchorHref(seconds)})${text ? ` ${text}` : ''}`;
}

/** 笔记里已有的锚点（面板列出来当跳转清单用；顺序即出现顺序）。 */
export function findAnchors(text: string): Array<{ seconds: number; raw: string }> {
  const out: Array<{ seconds: number; raw: string }> = [];
  const re = /\[([^\]]*)\]\(#vn=(\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ seconds: Number(m[2]), raw: m[0] });
  }
  return out;
}

export interface VideoClip {
  id: string;
  /** 视频标识：附件路径或直链 URL。同一视频的片段归在一起 */
  media: string;
  start: number;
  /** 区间片段才有终点；单点收藏是 null */
  end: number | null;
  label: string;
  tags: string[];
  at: number;
  /** 是否已插入到某篇笔记正文（用于去重提示） */
  inserted?: boolean;
}

export const CLIPS_KEY = 'knowlattice-video-clips';

function isClip(v: unknown): v is VideoClip {
  const c = v as VideoClip;
  return (
    !!c &&
    typeof c.id === 'string' &&
    typeof c.media === 'string' &&
    Number.isFinite(c.start) &&
    (c.end === null || Number.isFinite(c.end)) &&
    Array.isArray(c.tags)
  );
}

/** 读失败/形状不符一律当空表：片段是附加信息，坏数据不该让面板打不开。 */
export function loadClips(): VideoClip[] {
  try {
    const raw = localStorage.getItem(CLIPS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isClip) : [];
  } catch {
    return [];
  }
}

/** 导出全部片段（备份用；返回副本，调用方改它不会污染存储） */
export function exportClips(): VideoClip[] {
  return loadClips().map((c) => ({ ...c, tags: [...c.tags] }));
}

/**
 * 从备份恢复片段：**只补不覆盖**——同 id 已存在就保留本地那份。
 * 与 core/vault 里其它 localStorage 存储同一条纪律：旧备份不该把新写的备注/标签冲回去。
 * 返回真正新增的条数。
 */
export function importClips(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const cur = loadClips();
  const seen = new Set(cur.map((c) => c.id));
  let added = 0;
  const next = cur.slice();
  for (const v of raw) {
    if (!isClip(v) || seen.has(v.id)) continue;
    seen.add(v.id);
    next.push({
      ...v,
      start: Math.max(0, Math.round(v.start)),
      end: v.end == null ? null : Math.max(0, Math.round(v.end)),
      label: typeof v.label === 'string' ? v.label : '',
      tags: v.tags.filter((t) => typeof t === 'string'),
      ...(v.inserted === true ? { inserted: true } : {}),
    });
    added += 1;
  }
  if (added) save(next);
  return added;
}

function save(clips: VideoClip[]): boolean {
  try {
    localStorage.setItem(CLIPS_KEY, JSON.stringify(clips));
    return true;
  } catch {
    // 配额满/隐私模式：返回 false 让界面提示，而不是抛到事件处理里变成白屏
    return false;
  }
}

/**
 * 收藏区间：设了 A 和 B 就以 A-B 为区间（与播放顺序无关，用户可能先设 B 再设 A），
 * 与当前播放位置无关；没设满才退化成「当前播放位置的单点收藏」。
 *
 * 之前的写法把 start 取当前播放位置、end 取 max(a,b)：在区间外点收藏会存成倒序区间
 * （例如 A=30/B=20 时在 60 秒处收藏 → start=60、end=30），清单显示成「1:00–0:30」，
 * 点进去跳的也不是用户圈出的那一段。
 */
export function clipRange(
  a: number | null,
  b: number | null,
  at: number,
): { start: number; end: number | null } {
  if (a == null || b == null) return { start: Math.max(0, Math.floor(at)), end: null };
  return { start: Math.max(0, Math.floor(Math.min(a, b))), end: Math.max(0, Math.floor(Math.max(a, b))) };
}

/** 新增一条片段（同一视频同一秒重复点收藏时更新标签，不堆重复条目）。 */
export function addClip(
  clip: Omit<VideoClip, 'id' | 'at'> & { id?: string; at?: number },
  now = Date.now(),
): { clips: VideoClip[]; ok: boolean } {
  const clips = loadClips();
  // 区间一律归一成 start ≤ end：坏数据（历史版本存下的倒序区间）不该继续扩散到清单与排序里
  let start = Math.max(0, Math.round(clip.start));
  let end = clip.end == null ? null : Math.max(0, Math.round(clip.end));
  if (end != null && end < start) [start, end] = [end, start];
  const same = clips.findIndex(
    (c) => c.media === clip.media && Math.abs(c.start - start) < 1 && c.end === end,
  );
  const next: VideoClip = {
    id: clip.id ?? `v${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    media: clip.media,
    start,
    end,
    label: clip.label ?? '',
    tags: clip.tags ?? [],
    at: now,
  };
  if (same >= 0) clips[same] = { ...clips[same], label: next.label, tags: next.tags };
  else clips.unshift(next);
  return { clips, ok: save(clips) };
}

export function removeClip(id: string): { clips: VideoClip[]; ok: boolean } {
  const clips = loadClips().filter((c) => c.id !== id);
  return { clips, ok: save(clips) };
}

/** 更新已有片段的备注、标签或已插入状态。 */
export function updateClip(
  id: string,
  patch: { label?: string; tags?: string[]; inserted?: boolean },
): { clips: VideoClip[]; ok: boolean } {
  const clips = loadClips();
  const idx = clips.findIndex((c) => c.id === id);
  if (idx < 0) return { clips, ok: true };
  const cur = clips[idx];
  const nextItem: VideoClip = {
    ...cur,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.inserted !== undefined ? { inserted: patch.inserted } : {}),
  };
  const next = clips.slice();
  next[idx] = nextItem;
  return { clips: next, ok: save(next) };
}

/** 批量标记片段已插入笔记（只有实际发生变化时才写盘）。 */
export function markClipsInserted(ids: string[]): { clips: VideoClip[]; ok: boolean } {
  const target = new Set(ids);
  const clips = loadClips();
  let changed = false;
  const next = clips.map((c) => {
    if (!target.has(c.id) || c.inserted) return c;
    changed = true;
    return { ...c, inserted: true };
  });
  return { clips: next, ok: changed ? save(next) : true };
}

/** 面板只列当前视频的片段；`query` 匹配标签、备注与时间文字。 */
export function clipsFor(clips: VideoClip[], media: string, query = ''): VideoClip[] {
  const q = query.trim().toLowerCase();
  return clips
    .filter((c) => c.media === media)
    .filter((c) => !q || `${c.label} ${c.tags.join(' ')} ${formatTime(c.start)}`.toLowerCase().includes(q))
    .sort((a, b) => a.start - b.start);
}

export function formatClipRange(clip: VideoClip): string {
  return clip.end == null
    ? formatTime(clip.start)
    : `${formatTime(clip.start)}–${formatTime(clip.end)}`;
}

/** 单条片段 → 可插回正文的 Markdown：锚点指向起点，区间终点与标签只作可读信息保留。 */
export function clipMarkdown(clip: VideoClip): string {
  const label = clip.label.trim();
  const range = clip.end == null || clip.end <= clip.start ? '' : `（${formatClipRange(clip)}）`;
  const text = `${label}${range}`.trim();
  const tags = clip.tags
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(' ');
  return `- ${anchorMarkdown(clip.start, text)}${tags ? ` ${tags}` : ''}`;
}

/**
 * A-B 循环的下一个播放位置：越过 B 就回到 A。
 * 返回 null 表示「不处理」，调用方不要动 currentTime——
 * 无脑设置 currentTime 会打断正常的连续播放，也会和浏览器的缓冲状态打架。
 */
export function loopNext(current: number, a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (current >= to) return from;
  return null;
}

export interface VideoHistoryEntry {
  /** 视频标识（与 VideoClip.media 同一口径，作为去重键） */
  media: string;
  /** 可重新打开的原始链接（本地文件 blob 不跨会话持久化，存空串） */
  url: string;
  /** 展示标题 */
  title: string;
  /** 来源类型 */
  kind: VideoSourceKind;
  /** 最近打开时间戳（ms） */
  at: number;
  /** 上次播放位置（秒，取整；仅可读进度的视频有） */
  lastTime?: number;
  /** 视频总时长（秒，取整） */
  duration?: number;
  /** 是否置顶（置顶条目不参与 LRU 淘汰） */
  pinned?: boolean;
  /** 最近配合编辑的笔记路径 */
  notePath?: string;
  /** 上次使用的播放倍速 */
  playbackRate?: number;
}

export const VIDEO_HISTORY_KEY = 'knowlattice-video-history';
export const NOTE_VIDEO_KEY = 'knowlattice-note-video';
export const VIDEO_RATE_KEY = 'knowlattice-video-rate';
export const MAX_VIDEO_HISTORY = 30;
export const VIDEO_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const VALID_KINDS = new Set<string>([
  'local',
  'direct',
  'bilibili',
  'douyin',
  'netdisk',
  'page',
  'unknown',
]);

function isHistoryEntry(v: unknown): v is VideoHistoryEntry {
  const h = v as VideoHistoryEntry;
  return (
    !!h &&
    typeof h.media === 'string' &&
    h.media.trim().length > 0 &&
    typeof h.url === 'string' &&
    typeof h.title === 'string' &&
    typeof h.kind === 'string' &&
    VALID_KINDS.has(h.kind) &&
    Number.isFinite(h.at)
  );
}

function normalizeHistoryEntry(raw: VideoHistoryEntry): VideoHistoryEntry {
  const out: VideoHistoryEntry = {
    media: raw.media.trim(),
    url: raw.url.trim(),
    title: raw.title.trim() || raw.media.trim(),
    kind: raw.kind,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
  };
  if (raw.lastTime != null && Number.isFinite(raw.lastTime) && raw.lastTime >= 0) {
    out.lastTime = Math.floor(raw.lastTime);
  }
  if (raw.duration != null && Number.isFinite(raw.duration) && raw.duration > 0) {
    out.duration = Math.floor(raw.duration);
  }
  if (raw.pinned === true) out.pinned = true;
  if (typeof raw.notePath === 'string' && raw.notePath.trim()) {
    out.notePath = raw.notePath.trim();
  }
  if (raw.playbackRate != null && Number.isFinite(raw.playbackRate) && raw.playbackRate > 0) {
    out.playbackRate = raw.playbackRate;
  }
  return out;
}

function sortAndTrimHistory(list: VideoHistoryEntry[]): VideoHistoryEntry[] {
  const pinned = list.filter((x) => x.pinned).sort((a, b) => b.at - a.at).slice(0, MAX_VIDEO_HISTORY);
  const restSlots = Math.max(0, MAX_VIDEO_HISTORY - pinned.length);
  const unpinned = list.filter((x) => !x.pinned).sort((a, b) => b.at - a.at).slice(0, restSlots);
  return [...pinned, ...unpinned];
}

function saveHistory(list: VideoHistoryEntry[]): boolean {
  try {
    localStorage.setItem(VIDEO_HISTORY_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** 读取视频观看历史（置顶优先，其余按最近打开倒序，最多 MAX_VIDEO_HISTORY 条）。 */
export function loadVideoHistory(): VideoHistoryEntry[] {
  try {
    const raw = localStorage.getItem(VIDEO_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortAndTrimHistory(parsed.filter(isHistoryEntry).map(normalizeHistoryEntry));
  } catch {
    return [];
  }
}

/** 按 media 查找单条观看历史。 */
export function getVideoHistoryItem(media: string): VideoHistoryEntry | undefined {
  if (!media) return undefined;
  return loadVideoHistory().find((item) => item.media === media);
}

/** 记录一次打开视频：按 media 去重并置顶，保留已有播放进度、置顶状态、关联笔记与更完整的标题。 */
export function recordVideoHistory(
  entry: Omit<VideoHistoryEntry, 'at'> & { at?: number },
  now = Date.now(),
): VideoHistoryEntry[] {
  const media = entry.media.trim();
  const cur = loadVideoHistory();
  if (!media) return cur;
  const prev = cur.find((item) => item.media === media);
  const nextItem: VideoHistoryEntry = {
    media,
    url: entry.url.trim() || prev?.url || '',
    title: entry.title.trim() || prev?.title || media,
    kind: entry.kind ?? prev?.kind ?? 'unknown',
    at: entry.at ?? now,
    ...(entry.lastTime != null && Number.isFinite(entry.lastTime) && entry.lastTime >= 0
      ? { lastTime: Math.floor(entry.lastTime) }
      : prev?.lastTime != null
        ? { lastTime: prev.lastTime }
        : {}),
    ...(entry.duration != null && Number.isFinite(entry.duration) && entry.duration > 0
      ? { duration: Math.floor(entry.duration) }
      : prev?.duration != null
        ? { duration: prev.duration }
        : {}),
    ...((entry.pinned ?? prev?.pinned) ? { pinned: true } : {}),
    ...((entry.notePath?.trim() || prev?.notePath)
      ? { notePath: entry.notePath?.trim() || prev?.notePath }
      : {}),
    ...((entry.playbackRate ?? prev?.playbackRate) != null
      ? { playbackRate: entry.playbackRate ?? prev?.playbackRate }
      : {}),
  };
  const next = sortAndTrimHistory([nextItem, ...cur.filter((item) => item.media !== media)]);
  saveHistory(next);
  return next;
}

/** 更新已有视频的播放进度、总时长、标题、关联笔记或倍速（仅在字段确实变化时写盘）。 */
export function updateVideoHistoryProgress(
  media: string,
  patch: {
    lastTime?: number;
    duration?: number;
    title?: string;
    notePath?: string;
    playbackRate?: number;
  },
): VideoHistoryEntry[] {
  const cur = loadVideoHistory();
  const idx = cur.findIndex((item) => item.media === media);
  if (idx < 0) return cur;
  const target = cur[idx];
  const updated: VideoHistoryEntry = { ...target };
  let changed = false;

  if (patch.lastTime != null && Number.isFinite(patch.lastTime) && patch.lastTime >= 0) {
    const sec = Math.floor(patch.lastTime);
    if (updated.lastTime !== sec) {
      updated.lastTime = sec;
      changed = true;
    }
  }
  if (patch.duration != null && Number.isFinite(patch.duration) && patch.duration > 0) {
    const dur = Math.floor(patch.duration);
    if (updated.duration !== dur) {
      updated.duration = dur;
      changed = true;
    }
  }
  if (patch.title) {
    const nextTitle = patch.title.trim();
    if (nextTitle && updated.title !== nextTitle) {
      updated.title = nextTitle;
      changed = true;
    }
  }
  if (patch.notePath) {
    const nextNote = patch.notePath.trim();
    if (nextNote && updated.notePath !== nextNote) {
      updated.notePath = nextNote;
      changed = true;
    }
  }
  if (patch.playbackRate != null && Number.isFinite(patch.playbackRate) && patch.playbackRate > 0) {
    if (updated.playbackRate !== patch.playbackRate) {
      updated.playbackRate = patch.playbackRate;
      changed = true;
    }
  }
  if (!changed) return cur;
  const next = cur.slice();
  next[idx] = updated;
  saveHistory(next);
  return next;
}

/** 置顶 / 取消置顶某条观看历史。 */
export function togglePinVideoHistory(media: string): VideoHistoryEntry[] {
  const cur = loadVideoHistory();
  const idx = cur.findIndex((item) => item.media === media);
  if (idx < 0) return cur;
  const updated: VideoHistoryEntry = { ...cur[idx] };
  if (updated.pinned) delete updated.pinned;
  else updated.pinned = true;
  const next = sortAndTrimHistory(cur.map((item, i) => (i === idx ? updated : item)));
  saveHistory(next);
  return next;
}

/** 重命名历史视频标题。 */
export function renameVideoHistory(media: string, title: string): VideoHistoryEntry[] {
  const trimmed = title.trim();
  if (!trimmed) return loadVideoHistory();
  return updateVideoHistoryProgress(media, { title: trimmed });
}

/** 移除单条观看历史。 */
export function removeVideoHistory(media: string): VideoHistoryEntry[] {
  const next = loadVideoHistory().filter((item) => item.media !== media);
  saveHistory(next);
  return next;
}

/** 清空全部观看历史。 */
export function clearVideoHistory(): VideoHistoryEntry[] {
  try {
    localStorage.removeItem(VIDEO_HISTORY_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
  return [];
}

/** 导出全部观看历史（备份用）。 */
export function exportVideoHistory(): VideoHistoryEntry[] {
  return loadVideoHistory().map((item) => ({ ...item }));
}

/** 从备份恢复观看历史：只补不覆盖（同 media 保留本地记录）。 */
export function importVideoHistory(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const cur = loadVideoHistory();
  const seen = new Set(cur.map((item) => item.media));
  const next = cur.slice();
  let added = 0;
  for (const v of raw) {
    if (!isHistoryEntry(v)) continue;
    const item = normalizeHistoryEntry(v);
    if (seen.has(item.media)) continue;
    seen.add(item.media);
    next.push(item);
    added += 1;
  }
  if (added > 0) {
    saveHistory(sortAndTrimHistory(next));
  }
  return added;
}

/** 读取「笔记路径 → 视频标识」映射。 */
export function loadNoteVideoMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NOTE_VIDEO_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.trim() && typeof v === 'string' && v.trim()) out[k.trim()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function getVideoForNote(notePath: string | null | undefined): string | null {
  const p = notePath?.trim();
  if (!p) return null;
  return loadNoteVideoMap()[p] ?? null;
}

/** 绑定笔记与视频（不改变无关条目）。 */
export function bindNoteVideo(notePath: string, media: string): Record<string, string> {
  const p = notePath.trim();
  const m = media.trim();
  const cur = loadNoteVideoMap();
  if (!p || !m || cur[p] === m) return cur;
  const next = { ...cur, [p]: m };
  try {
    localStorage.setItem(NOTE_VIDEO_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式忽略 */
  }
  return next;
}

export function exportNoteVideos(): Record<string, string> {
  return { ...loadNoteVideoMap() };
}

/** 从备份恢复笔记视频关联：只补不覆盖。 */
export function importNoteVideos(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const cur = loadNoteVideoMap();
  let added = 0;
  const next = { ...cur };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || typeof v !== 'string' || !v.trim() || key in cur) continue;
    next[key] = v.trim();
    added += 1;
  }
  if (added > 0) {
    try {
      localStorage.setItem(NOTE_VIDEO_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  }
  return added;
}

/** 读取默认播放倍速（默认 1x）。 */
export function loadVideoRate(): number {
  try {
    const raw = localStorage.getItem(VIDEO_RATE_KEY);
    if (!raw) return 1;
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) && n > 0 && n <= 4 ? n : 1;
  } catch {
    return 1;
  }
}

export function saveVideoRate(rate: number): number {
  const safe = Number.isFinite(rate) && rate > 0 && rate <= 4 ? rate : 1;
  try {
    localStorage.setItem(VIDEO_RATE_KEY, JSON.stringify(safe));
  } catch {
    /* 忽略 */
  }
  return safe;
}

/** 判断 media 是否是本地文件的复合键（`文件名|大小|修改时间`）。 */
export function isLocalMediaKey(media: string): boolean {
  return /^.+\|\d+\|\d+$/.test(media);
}

/** 计算适合续播的起始秒数；接近结尾（距末尾不足 2 秒）或 0 秒时不续播。 */
export function resumeSeconds(
  entry: Pick<VideoHistoryEntry, 'lastTime' | 'duration'> | null | undefined,
): number | null {
  if (!entry || entry.lastTime == null || entry.lastTime <= 0) return null;
  if (entry.duration != null && entry.duration > 0 && entry.lastTime >= entry.duration - 2) {
    return null;
  }
  return entry.lastTime;
}
