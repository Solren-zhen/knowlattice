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
