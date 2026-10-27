/**
 * 视频来源识别：把用户粘的链接归一成「面板怎么放它」。
 *
 * 现实约束（决定了这里只有三种可播放形态）：
 * - 本地文件 / 直链 mp4-webm → `<video>`，能读 currentTime，锚点精确到帧；
 * - B 站 → 默认走面板里的原生播放器（可读进度）；解析层仍保留官方 iframe 兜底地址，
 *   原生播放不可用时「跳转」用重载 iframe 带 `t=` 实现；
 * - 抖音 / 网盘 → 没有可用的站内播放器（抖音禁 iframe、网盘要登录态与提取码），
 *   只做识别 + 打开原页 + 锚点带上时间参数跳浏览器。不伪装成能播。
 */
import { parseTimestamp } from './subtitle';

export type VideoSourceKind =
  | 'local'
  | 'direct'
  | 'bilibili'
  | 'douyin'
  | 'netdisk'
  | 'page'
  | 'unknown';

export interface VideoSource {
  kind: VideoSourceKind;
  /** 面板标题 */
  title: string;
  /** 可直接喂给 <video> 的地址（local/direct 才有） */
  playUrl: string | null;
  /** iframe 播放器地址（bilibili 才有） */
  embedUrl: string | null;
  /** 「在浏览器打开」的地址（全部来源都有，作为兜底） */
  pageUrl: string | null;
  /** 能否从播放器读到当前位置（决定「记时间点」是自动还是手填） */
  seekable: boolean;
  /** 给用户看的一句限制说明；空串表示没有额外限制 */
  note: string;
}

const DIRECT_EXT = /\.(mp4|webm|ogg|ogv|m4v|mov|mkv)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const BILI_HOST = /^(?:www\.|m\.)?bilibili\.com$/i;
const BILI_SHORT = /^b23\.tv$/i;
const DOUYIN_HOST = /(^|\.)douyin\.com$/i;
const NETDISK_HOST =
  /(^|\.)(pan\.baidu\.com|aliyundrive\.com|alipan\.com|pan\.quark\.cn|115\.com|115cdn\.com|123pan\.com|123684\.com|caiyun\.139\.com|cloud\.189\.cn)$/i;

/** `BV1xx411c7mD` / `av170001` / 分P / 起始秒 */
export interface BilibiliRef {
  bvid?: string;
  aid?: string;
  page: number;
  start: number;
}

function biliRef(u: URL): BilibiliRef | null {
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(u.pathname);
  const ref: BilibiliRef = { page: 1, start: 0 };
  if (m) {
    if (/^BV/i.test(m[1])) ref.bvid = m[1];
    else ref.aid = m[1];
  } else {
    // 部分页面用 query 传 id（手机端/短链跳转后）
    const q = u.searchParams.get('bvid') ?? '';
    if (/^BV[0-9A-Za-z]{10}$/.test(q)) ref.bvid = q;
  }
  if (!ref.bvid && !ref.aid) return null;
  const p = Number(u.searchParams.get('p'));
  if (Number.isFinite(p) && p > 0) ref.page = Math.floor(p);
  // 站内播放位置参数是 `t=754`（也见过 `t=12m34s`），页内锚点会出现 `#t=754`
  const raw = u.searchParams.get('t') ?? /[#&]t=([^&]+)/.exec(u.hash)?.[1] ?? '';
  const parsedAt = raw ? parseTimestamp(raw) : 0;
  ref.start = parsedAt == null ? 0 : Math.max(0, Math.floor(parsedAt));
  return ref;
}

/** 从任意 B 站地址里取出视频号与分P；认不出返回 null。 */
export function parseBilibili(url: string): BilibiliRef | null {
  try {
    return biliRef(new URL(url));
  } catch {
    return null;
  }
}

/** B 站 iframe 播放器：`t` 以秒为单位，重载即跳转（跨域拿不到播放位置，只能这么跳）。 */
export function bilibiliEmbed(ref: BilibiliRef & { at?: number }, autoplay = true): string {
  const q = new URLSearchParams();
  if (ref.bvid) q.set('bvid', ref.bvid);
  else if (ref.aid) q.set('aid', ref.aid.replace(/^av/i, ''));
  q.set('page', String(ref.page));
  q.set('t', String(Math.max(0, Math.floor(ref.at ?? ref.start))));
  if (autoplay) q.set('autoplay', '1');
  q.set('danmaku', '0');
  q.set('high_quality', '1');
  return `https://player.bilibili.com/player.html?${q.toString()}`;
}

/** 让浏览器在原站打开并直接落到某一秒（B 站/抖音都认 `t=`）。 */
export function withStart(url: string, seconds: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 识别来源。`input` 可以是 http(s) 链接、blob:/file: 本地地址或纯文件名。
 * 判断顺序有意义：先看是不是本地/直链（能播得上），再认平台（有专用播放器），
 * 最后才是网盘与普通网页——网盘链接里也可能带 `.mp4` 字样，但那是分享页不是媒体流。
 */
export function parseVideoSource(input: string): VideoSource {
  const raw = input.trim();
  const base: VideoSource = {
    kind: 'unknown',
    title: raw.split('/').pop() || raw,
    playUrl: null,
    embedUrl: null,
    pageUrl: null,
    seekable: false,
    note: '',
  };
  if (!raw) return { ...base, title: '' };

  if (/^(blob:|file:|asset:)/i.test(raw) || !/^[a-z]+:\/\//i.test(raw)) {
    return { ...base, kind: 'local', playUrl: raw, seekable: true, title: raw.split(/[\\/]/).pop() || raw };
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return base;
  }

  if (BILI_HOST.test(u.hostname)) {
    const ref = biliRef(u);
    if (ref) {
      return {
        kind: 'bilibili',
        title: `B站 ${ref.bvid ?? ref.aid}${ref.page > 1 ? ` · P${ref.page}` : ''}`,
        playUrl: null,
        embedUrl: bilibiliEmbed(ref, false),
        pageUrl: raw,
        seekable: false,
        note: 'B 站只能跳时间点，读不到播放位置：记时间点时手填（如 12:34），或先看当前秒数再填。',
      };
    }
    return { ...base, kind: 'page', pageUrl: raw, note: '这个 B 站链接里没认出视频号（BV/av）。' };
  }

  if (BILI_SHORT.test(u.hostname)) {
    return { ...base, kind: 'page', pageUrl: raw, note: 'b23.tv 短链要先在浏览器打开，把跳转后的完整地址粘回来。' };
  }

  if (DOUYIN_HOST.test(u.hostname)) {
    return {
      ...base,
      kind: 'douyin',
      title: '抖音视频',
      pageUrl: raw,
      note: '抖音禁止站外内嵌播放：这里只能记锚点，点锚点会在浏览器打开并落到该秒。',
    };
  }

  if (NETDISK_HOST.test(u.hostname)) {
    return {
      ...base,
      kind: 'netdisk',
      title: `网盘 ${u.hostname}`,
      pageUrl: raw,
      note: '网盘分享页要登录/提取码，拿不到媒体流：只能记锚点并在浏览器打开原页。直链（.mp4 或 .m3u8）可以播。',
    };
  }

  if (HLS_EXT.test(u.pathname)) {
    return {
      ...base,
      kind: 'direct',
      pageUrl: raw,
      note: 'm3u8 是 HLS 切片，桌面 Chrome 内核不原生支持（本地文件建议 mp4）。',
    };
  }

  if (DIRECT_EXT.test(u.pathname)) {
    return { ...base, kind: 'direct', playUrl: raw, pageUrl: raw, seekable: true, title: base.title };
  }

  return { ...base, kind: 'page', pageUrl: raw, note: '这个地址不是视频文件，也不是已知视频站点。' };
}

/** 网盘/网页来源的「这个视频是谁」——片段归属用它，别用整条链接（带一堆跟踪参数）。 */
export function mediaKeyOf(source: VideoSource, rawInput: string): string {
  if (source.kind === 'netdisk' || source.kind === 'page' || source.kind === 'douyin') return rawInput.trim();
  if (source.kind === 'bilibili') {
    try {
      const u = new URL(rawInput);
      const ref = biliRef(u);
      if (ref) return `bili:${ref.bvid ?? ref.aid}:p${ref.page}`;
    } catch {
      // 落到下面的通用值
    }
  }
  return rawInput.trim();
}
