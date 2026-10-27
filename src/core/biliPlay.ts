/**
 * B 站「登录一次、按账号权益取最高清晰度」的核心。
 *
 * 为什么不用内嵌播放器：player.bilibili.com 的 iframe 是黑盒——
 *   ① 跨域拿不到进度（跳时间点只能重载 iframe）；
 *   ② 清晰度由播放器自己决定，外部既读不到也改不了，账号登录态在第三方 iframe 里也常被挡；
 *   ③ 微信/QQ 之类内置浏览器直接不给播。
 * 官方接口则给得很清楚：`/x/player/playurl` 带上账号 cookie 后返回
 * `accept_quality`（这个账号**实际**能取到的清晰度全集）和 DASH 音视频分轨地址。
 * 于是「登录一次」= 存一次 cookie，「最高清晰度」= 从 accept_quality 里挑最大。
 *
 * 请求必须经 dev server 的 /bili-proxy 转发（见 scripts/vite-bili-proxy.ts）：
 * api 不发 CORS 头、媒体地址校验 Referer，两件事 <video> 自己都做不到。
 */

export const BILI_COOKIE_KEY = 'knowlattice-bili-cookie'
export const BILI_PROXY = '/bili-proxy'

/** 清晰度代码 → 中文标签（B 站自家文案，接口的 accept_description 也带，作为兜底） */
export const QUALITY_LABEL: Record<number, string> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

export interface BiliAccount {
  /** SESSDATA 是登录态主 cookie；bili_jct 用于写操作（本功能不需要，但登录页会给） */
  sessdata: string
  biliJct?: string
}

export interface BiliPart {
  cid: number
  page: number
  part: string
}

export interface BiliView {
  bvid: string
  title: string
  duration: number
  cid: number
  parts: BiliPart[]
}

export interface BiliStream {
  /** 清晰度代码（DASH 里就是 video[].id） */
  qn: number
  label: string
  url: string
  bandwidth: number
  codecs?: string
}

export interface BiliPlayInfo {
  /** 这个账号能取到的全部清晰度（升序） */
  qualities: { qn: number; label: string }[]
  /** 实际拿到的这一档 */
  qn: number
  label: string
  video: BiliStream | null
  audio: BiliStream | null
  /** 老接口给的整段地址（DASH 缺失时的退路，通常是 720P/480P 的 mp4） */
  durl: string[]
  /** 是否因为未登录/无权益而受限（用来在界面上解释「为什么只有 480P」） */
  limited: boolean
}

/** 解析用户粘进来的 cookie 文本：支持整段 "SESSDATA=…; bili_jct=…" 或只粘 SESSDATA 的值 */
export function parseCookieInput(raw: string): BiliAccount | null {
  const text = (raw || '').trim()
  if (!text) return null
  const get = (name: string): string | null => {
    const m = new RegExp(`(?:^|[;\\s])${name}=([^;\\s]+)`).exec(text)
    return m ? m[1] : null
  }
  const sess = get('SESSDATA')
  if (sess) {
    const jct = get('bili_jct')
    return { sessdata: sess, ...(jct ? { biliJct: jct } : {}) }
  }
  // 只粘了值：SESSDATA 的值本身含逗号与 %2C，长度可观且不含空白/分号
  if (/^[^\s;]{20,}$/.test(text) && !text.includes('=')) return { sessdata: text }
  return null
}

export function loadAccount(): BiliAccount | null {
  try {
    const raw = localStorage.getItem(BILI_COOKIE_KEY)
    if (!raw) return null
    const parsed = parseCookieInput(raw)
    if (!parsed) localStorage.removeItem(BILI_COOKIE_KEY)
    return parsed
  } catch {
    return null;
  }
}

export function saveAccount(raw: string): BiliAccount | null {
  const parsed = parseCookieInput(raw)
  if (!parsed) return null
  try {
    localStorage.setItem(BILI_COOKIE_KEY, raw.trim())
  } catch {
    return null
  }
  return parsed
}

export function clearAccount(): void {
  try {
    localStorage.removeItem(BILI_COOKIE_KEY)
  } catch {
    // 存储被禁用时本来也没存上，不必报错
  }
}

export function cookieHeader(acc: BiliAccount | null): string {
  if (!acc) return ''
  return acc.biliJct ? `SESSDATA=${acc.sessdata}; bili_jct=${acc.biliJct}` : `SESSDATA=${acc.sessdata}`
}

/**
 * 把真实地址改写成同源代理地址。媒体地址也要改写：
 * 直连 *.bilivideo.com 会因为 Referer 校验 403，而 <video> 改不了 Referer。
 */
export function proxied(url: string, kind?: 'video' | 'audio'): string {
  const u = url.replace(/^https?:\/\//, '')
  const cut = u.indexOf('/')
  if (cut <= 0) return url
  const base = `${BILI_PROXY}/${u.slice(0, cut)}${u.slice(cut)}`
  /**
   * 分轨 DASH 的音频段常被 CDN 报成 application/octet-stream，<audio> 会拒播。
   * 所以由调用方声明这是音轨还是视轨，代理据此改写 content-type。
   */
  if (!kind) return base
  return `${base}${base.includes('?') ? '&' : '?'}__ct=${kind}`
}

async function api<T>(path: string, acc: BiliAccount | null): Promise<T> {
  const ck = cookieHeader(acc)
  const res = await fetch(proxied(`https://api.bilibili.com${path}`), {
    headers: ck ? { 'x-bili-cookie': ck } : {},
  })
  if (!res.ok) throw new Error(`接口 ${res.status}：${path}`)
  const json = (await res.json()) as { code: number; message?: string; data?: T }
  if (json.code !== 0) throw new Error(biliErrorText(json.code, json.message))
  if (json.data === undefined) throw new Error('接口没有返回数据')
  return json.data
}

/** 把 B 站错误码翻成人话——原始 code 对使用者没有信息量 */
export function biliErrorText(code: number, message?: string): string {
  switch (code) {
    case -101:
      return 'B 站账号未登录：在面板里粘贴一次 SESSDATA 即可（只需一次）'
    case -403:
      return '这个账号没有该视频的播放权限（可能需要大会员或已购买）'
    case -404:
      return '视频不存在或已下架'
    case -10403:
      return '该视频有地区/年龄限制，接口不给地址'
    case 87007:
      return '该视频仅限客户端播放（P2P），网页接口拿不到地址'
    case 87008:
      return '该视频仅限特定客户端播放，接口拿不到地址'
    default:
      return message ? `B 站返回 ${code}：${message}` : `B 站返回错误码 ${code}`
  }
}

export async function fetchView(bvid: string, acc: BiliAccount | null): Promise<BiliView> {
  const data = await api<{
    bvid: string
    title: string
    duration: number
    cid: number
    pages?: { cid: number; page: number; part: string }[]
  }>(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, acc)
  return {
    bvid: data.bvid,
    title: data.title,
    duration: data.duration,
    cid: data.cid,
    parts: data.pages ?? [{ cid: data.cid, page: 1, part: data.title }],
  }
}

interface RawDash {
  video?: { id: number; baseUrl?: string; base_url?: string; bandwidth: number; codecs?: string }[]
  audio?: { id: number; baseUrl?: string; base_url?: string; bandwidth: number; codecs?: string }[]
  dolby?: { audio?: { id: number; baseUrl?: string; base_url?: string; bandwidth: number }[] }
  flac?: { audio?: { id: number; baseUrl?: string; base_url?: string; bandwidth: number } | null }
}

interface RawPlayurl {
  quality: number
  accept_quality?: number[]
  accept_description?: string[]
  dash?: RawDash
  durl?: { url: string }[]
}

/**
 * 取播放地址。qn 传这个账号能取的最大值即可；接口会自己回落到可用档位
 * （所以 **不能** 假设返回的 quality 就等于请求的 qn，必须用返回的 quality 显示）。
 */
export async function fetchPlayurl(
  bvid: string,
  cid: number,
  acc: BiliAccount | null,
  qn = 127,
): Promise<BiliPlayInfo> {
  // fnval=4048 = DASH + 4K + HDR + 杜比 + 8K 全特性；fourk=1 才允许 4K 分轨
  const data = await api<RawPlayurl>(
    `/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=4048&fnver=0&fourk=1`,
    acc,
  )
  const qs = (data.accept_quality ?? []).map((code, i) => ({
    qn: code,
    label: data.accept_description?.[i] ?? QUALITY_LABEL[code] ?? `qn${code}`,
  }))
  qs.sort((a, b) => a.qn - b.qn)

  const dash = data.dash
  const pickVideo = (): BiliStream | null => {
    const list = dash?.video ?? []
    if (!list.length) return null
    // 优先要请求的档；没有就取不超过它的最大档（4K/8K 无权限时接口会给 1080P）
    const usable = list.filter((v) => v.baseUrl || v.base_url)
    if (!usable.length) return null
    const exact = usable.find((v) => v.id === data.quality) ?? usable[0]
    const best = usable.reduce((a, b) => (b.id > a.id ? b : a), exact)
    return {
      qn: best.id,
      label: QUALITY_LABEL[best.id] ?? `qn${best.id}`,
      url: best.baseUrl ?? best.base_url ?? '',
      bandwidth: best.bandwidth,
      ...(best.codecs ? { codecs: best.codecs } : {}),
    }
  }
  const pickAudio = (): BiliStream | null => {
    const candidates = [
      ...(dash?.flac?.audio ? [dash.flac.audio] : []),
      ...(dash?.dolby?.audio ?? []),
      ...(dash?.audio ?? []),
    ].filter((a) => a.baseUrl || a.base_url)
    if (!candidates.length) return null
    const best = candidates.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a))
    return {
      qn: best.id,
      label: best.bandwidth >= 900000 ? '无损/杜比' : best.bandwidth >= 180000 ? '192K' : '132K',
      url: best.baseUrl ?? best.base_url ?? '',
      bandwidth: best.bandwidth,
    }
  }

  const video = pickVideo()
  const audio = pickAudio()
  return {
    qualities: qs,
    qn: video?.qn ?? data.quality,
    label: video?.label ?? QUALITY_LABEL[data.quality] ?? `qn${data.quality}`,
    video,
    audio,
    durl: (data.durl ?? []).map((d) => d.url),
    // 未登录或没权益时，接口只给到 480P 及以下：把这个判断留给界面解释
    limited: qs.length > 0 && qs[qs.length - 1].qn <= 32,
  }
}

/** 这个账号理论上能取到的最高清晰度（用于登录后立即告诉用户「你现在最高能看什么」） */
export function topQuality(info: BiliPlayInfo): { qn: number; label: string } | null {
  return info.qualities.length ? info.qualities[info.qualities.length - 1] : null
}
