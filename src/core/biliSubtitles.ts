/**
 * B 站课程字幕：把「分P + 原生 CC 字幕」读成可喂给 AI 的带时间戳文本。
 *
 * 为什么必须走代理：/x/player/v2 不发 CORS 头，字幕清单在多数稿件上还要求登录态；
 * 字幕文件本身落在 i*.hdslb.com，直连同样被跨域挡。复用 biliPlay 的 /bili-proxy
 * （白名单已含 .bilibili.com 与 .hdslb.com，并会自动补 Referer 与 Cookie）。
 *
 * 已知限制（界面必须如实说明，不要静默失败）：
 * - 未登录时 B 站一律返回空字幕清单；
 * - 不少课程本身就没有 CC 字幕，这里只能返回空数组，不做音频下载/ASR。
 */
import { cookieHeader, proxied, type BiliAccount } from './biliPlay';
import { formatTime, parseSubtitle, type Cue } from './subtitle';

export interface BiliSubtitleTrack {
  /** BCP-47 语言标签，如 zh-CN */
  lan: string;
  /** 中文说明，如「中文（中国）」 */
  lanDoc: string;
  /** 已补全协议的字幕文件地址（B 站给的是 //i0.hdslb.com/...） */
  url: string;
  /** 是否为 AI 生成字幕 */
  ai: boolean;
}

/** 抓字幕清单用的最小响应形状；其余字段（字体、位置等）与本功能无关 */
interface RawPlayerV2 {
  subtitle?: {
    subtitles?: {
      lan?: string;
      lan_doc?: string;
      subtitle_url?: string;
      ai_type?: number;
      type?: number;
    }[];
  };
}

/** `//i0.hdslb.com/x.json` 与 `http://…` 都要归一成 https 绝对地址 */
export function normalizeSubtitleUrl(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  return text;
}

/** 语言优先级：人工中文 > 人工中文（其他标签） > AI 中文 > 第一条 */
const ZH_EXACT = ['zh-CN', 'zh-Hans', 'zh'];
const ZH_PREFIX = ['zh-CN', 'zh-Hans', 'zh-Hant', 'zh'];

export function pickSubtitleTrack(tracks: readonly BiliSubtitleTrack[]): BiliSubtitleTrack | null {
  const usable = tracks.filter((t) => t.url);
  if (!usable.length) return null;
  const manual = usable.filter((t) => !t.ai);
  const pool = manual.length ? manual : usable;
  for (const lan of ZH_EXACT) {
    const hit = pool.find((t) => t.lan === lan);
    if (hit) return hit;
  }
  for (const prefix of ZH_PREFIX) {
    const hit = pool.find((t) => t.lan.startsWith(prefix));
    if (hit) return hit;
  }
  return pool[0] ?? null;
}

interface RawSubtitleJson {
  body?: { from?: number | string; to?: number | string; content?: string }[];
}

/**
 * 解析 B 站字幕 JSON（`{ body: [{ from, to, content }] }`，时间单位是秒）。
 * 与 SRT/VTT 的 parseSubtitle 分开：这里没有时间行，不能共用那套按箭头切块的逻辑。
 * 非法 JSON、缺 body、空正文一律返回空数组，不抛异常（抓取层会把它当成「没有字幕」）。
 */
export function parseBiliSubtitleJson(raw: string): Cue[] {
  let json: RawSubtitleJson;
  try {
    json = JSON.parse(raw) as RawSubtitleJson;
  } catch {
    return [];
  }
  const list = Array.isArray(json?.body) ? json.body : [];
  const cues: Cue[] = [];
  for (const item of list) {
    const start = Number(item?.from);
    const end = Number(item?.to);
    // 正文里的换行是排版，不是语义；压成空格，避免时间戳行被切成多行
    const text = typeof item?.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
    if (!text || !Number.isFinite(start)) continue;
    cues.push({
      start: Math.max(0, start),
      end: Number.isFinite(end) && end > start ? end : start,
      text,
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * 抓某个分P的字幕清单。未登录/无字幕时返回空数组，不视为错误。
 *
 * 两个接口都要试：实测 `x/player/wbi/v2` 会稳定带上 `subtitle_url`，
 * 而老接口 `x/player/v2` 会偶发返回 8 条语言却全是空 url —— 过滤掉空 url 后
 * 界面就变成「该视频没有可用的 CC 字幕」，实际视频是有字幕的。
 * 所以先走 wbi，拿不到可用地址再回落老接口；两者都成功但为空才认定没有字幕。
 */
export async function fetchSubtitleTracks(
  bvid: string,
  cid: number,
  acc: BiliAccount | null,
): Promise<BiliSubtitleTrack[]> {
  const ck = cookieHeader(acc);
  const paths = [
    `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
  ];
  let lastError: unknown = null;
  let anySucceeded = false;
  for (const raw of paths) {
    try {
      // no-store：登录前后 URL 相同，浏览器会把未登录时的空清单缓存下来，
      // 导致粘贴 SESSDATA 后仍然一直「无字幕」（实测踩过）。
      const res = await fetch(proxied(raw), {
        headers: ck ? { 'x-bili-cookie': ck } : {},
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`字幕清单接口 ${res.status}`);
      const json = (await res.json()) as { code: number; message?: string; data?: RawPlayerV2 };
      if (json.code !== 0) throw new Error(json.message || `B 站返回错误码 ${json.code}`);
      anySucceeded = true;
      const list = (json.data?.subtitle?.subtitles ?? [])
        .map((t) => ({
          lan: (t.lan || '').trim(),
          lanDoc: (t.lan_doc || '').trim(),
          url: normalizeSubtitleUrl(t.subtitle_url || ''),
          ai: Boolean(t.ai_type) || t.type === 1,
        }))
        .filter((t) => t.url);
      if (list.length) return list;
    } catch (e) {
      lastError = e;
    }
  }
  if (!anySucceeded && lastError) throw lastError;
  return [];
}

/**
 * 下载并解析一条字幕。B 站「字幕文件」绝大多数是自家 JSON，
 * 但历史稿件有 SRT，所以按内容首字符分流，两种都能读。
 */
export async function fetchSubtitleCues(
  track: BiliSubtitleTrack,
  acc: BiliAccount | null,
): Promise<Cue[]> {
  if (!track.url) return [];
  const ck = cookieHeader(acc);
  const res = await fetch(proxied(track.url), {
    headers: ck ? { 'x-bili-cookie': ck } : {},
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`字幕文件 ${res.status}`);
  const text = await res.text();
  return text.trimStart().startsWith('{') ? parseBiliSubtitleJson(text) : parseSubtitle(text);
}

export interface TranscriptOptions {
  /** 每行合并到多少字：太小会让时间戳密度过高，太大又失去定位精度 */
  maxChars?: number;
}

/**
 * 字幕 → 带时间锚点的讲义输入。连续短句合并成一行，行首只留该行第一句的时间，
 * 这样既保留「回看定位」又能把行数压到 LLM 上下文能接受的程度。
 */
export function cuesToTranscript(cues: readonly Cue[], opts: TranscriptOptions = {}): string {
  const maxChars = Math.max(60, Math.floor(opts.maxChars ?? 400));
  const lines: string[] = [];
  let buf: string[] = [];
  let start = 0;
  let len = 0;
  const flush = (): void => {
    if (!buf.length) return;
    lines.push(`[${formatTime(start)}] ${buf.join('')}`);
    buf = [];
    len = 0;
  };
  for (const cue of cues) {
    if (!cue.text) continue;
    if (!buf.length) start = cue.start;
    // 中文句末补一个空格会显得碎；这里只在英文/数字结尾时补空格
    const piece = /[A-Za-z0-9]$/.test(buf[buf.length - 1] ?? '') ? ` ${cue.text}` : cue.text;
    buf.push(piece);
    len += piece.length;
    if (len >= maxChars) flush();
  }
  flush();
  return lines.join('\n');
}

/**
 * 防呆：B 站偶发把别的稿件的 AI 字幕挂在当前 cid 下（实测同一条视频拿到过
 * 778 秒的字幕，而视频只有 211 秒）。字幕跨度明显超出视频时长时直接判为抓错，
 * 避免拿错文件生成一页看似正常、内容全错的精华。
 */
export function subtitleOutOfRange(cues: readonly Cue[], durationSec: number): boolean {
  if (!cues.length || !(durationSec > 0)) return false;
  const last = cues[cues.length - 1]?.end ?? 0;
  return last > durationSec + 30;
}

/** 反方向：字幕只覆盖到视频的一小段，多半是抓到了片段或别的稿件，同样不该拿去生成 */
export function subtitleIncomplete(cues: readonly Cue[], durationSec: number): boolean {
  if (!cues.length || !(durationSec >= 120)) return false;
  const last = cues[cues.length - 1]?.end ?? 0;
  return last < durationSec * 0.4;
}

/** 整门课的字幕抓取结果；cues 为空表示这个分P没有可用字幕 */
export interface PartTranscript {
  page: number;
  cid: number;
  part: string;
  track: BiliSubtitleTrack | null;
  cues: Cue[];
}
