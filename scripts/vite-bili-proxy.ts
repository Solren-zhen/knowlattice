/**
 * B 站请求代理（仅 dev server 生效）。
 *
 * 为什么必须有它：浏览器直连 api.bilibili.com 会被 CORS 拒（对方不发 ACAO），
 * 而 api 要拿「这个账号真实能播的最高清晰度」就必须带上 SESSDATA，cookie 只能由服务端转发。
 * 播放地址（*.bilivideo.com）还要求 Referer=https://www.bilibili.com，否则 403 ——
 * <video> 也无法自己加 Referer，所以媒体流同样要过这层代理。
 *
 * 用法：/bili-proxy/<host>/<path...>
 *   - 请求头 x-bili-cookie 会作为 Cookie 转发（不要放进 URL，URL 会进日志）
 *   - Range 原样转发，视频拖动依赖它
 *
 * 只放行 B 站相关域名（白名单），不做开放代理。
 */
import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const PREFIX = '/bili-proxy/'
/** 允许转发的主机后缀：只认 B 站自家的域名，避免变成任意站点的开放代理 */
const ALLOWED_SUFFIX = [
  '.bilibili.com',
  '.hdslb.com',
  '.bilivideo.com',
  '.bilivideo.cn',
  '.bilivideo.net',
  '.szbdyd.com',
  '.akamaized.net',
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/**
 * 播放地址会落到 B 站的第三方 PCDN 上（实测出现过 *.edge.mountaintoys.cn:4483 这种），
 * 域名名单既不可能枚举全、也不该为一个播放器无限放宽。改成**自证名单**：
 * 只有我们代理过一次 playurl、且该响应里真的出现过的主机，才允许再被代理。
 * 效果同样是「不做开放代理」，但不会因为对方换了 CDN 就整条链路 403。
 */
const MEDIA_HOSTS = new Set<string>()

/** 把一条媒体地址的主机记进自证名单（只认真实媒体后缀，避免顺带放行无关主机） */
function rememberMediaHost(url: string): void {
  try {
    const u = new URL(url)
    if (!/\.(m4s|mp4|m4a|flv|ts)$/i.test(u.pathname)) return
    MEDIA_HOSTS.add(u.host.toLowerCase())
  } catch {
    // 不是绝对地址（相对路径 / 空串）就跳过
  }
}

/** 递归找出响应里所有媒体地址（playurl 的 baseUrl/base_url/backupUrl 结构会变，不硬编码键名） */
function rememberMediaHostsDeep(node: unknown): void {
  if (typeof node === 'string') {
    if (node.startsWith('http')) rememberMediaHost(node)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) rememberMediaHostsDeep(v)
    return
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) rememberMediaHostsDeep(v)
  }
}

function allowedHost(host: string): boolean {
  /**
   * 真实播放地址常常带端口（如 xy1.mcdn.bilivideo.cn:8082），
   * 端口不是主机的一部分：不去掉的话，白名单一条都匹配不上，媒体请求全被 403。
   */
  const h = host.toLowerCase().replace(/:\d+$/, '')
  if (MEDIA_HOSTS.has(host.toLowerCase()) || MEDIA_HOSTS.has(h)) return true
  if (h === 'bilibili.com') return true
  return ALLOWED_SUFFIX.some((s) => h.endsWith(s))
}

function pass(req: IncomingMessage, res: ServerResponse, host: string, path: string): void {
  /**
   * __ct=video|audio：B 站分轨媒体常被 CDN 报成 application/octet-stream，
   * <audio>/<video> 会因此拒绝播放。这个参数只用于改写返回的 content-type，
   * 转发给上游前必须剔掉（它不属于对方的接口）。
   */
  const ctMark = /[?&]__ct=(video|audio)(?:&|$)/.exec(path)?.[1] as 'video' | 'audio' | undefined
  // 剔除标记（我们总是把它追加在末尾）
  if (ctMark) path = path.replace(/[?&]__ct=(video|audio)(?:&|$)/, '')
  const headers: Record<string, string | string[] | undefined> = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com',
    origin: 'https://www.bilibili.com',
    accept: req.headers.accept ?? '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  // cookie 走自定义头，前端显式给；没有就匿名（此时 api 只返回 480p 上限）
  const cookie = req.headers['x-bili-cookie']
  if (typeof cookie === 'string' && cookie) headers.cookie = cookie
  if (req.headers.range) headers.range = req.headers.range

  /**
   * host 可能带端口（PCDN 常见 :8082）。必须拆开：
   * `host` 选项里带端口时 node 会把它整串当主机名交给 TLS，SNI 就错了，
   * 对端直接断握手（实测报 "socket disconnected before secure TLS connection was established"）。
   */
  const m = /^(.*?)(?::(\d+))?$/.exec(host)
  const hostname = m?.[1] ?? host
  const port = m?.[2] ? Number(m[2]) : undefined

  const up = https.request(
    { hostname, port, path, method: req.method, headers, servername: hostname },
    (r) => {
    // 逐跳/安全头不转发：content-encoding 已由 node 解压语义决定，传输编码由本层决定
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(r.headers)) {
      if (v == null) continue
      if (['connection', 'transfer-encoding', 'content-encoding', 'set-cookie'].includes(k)) continue
      out[k] = v as string | string[]
    }
    // 让浏览器愿意把这段响应当作媒体/接口数据
    out['access-control-allow-origin'] = '*'
    if (ctMark) out['content-type'] = ctMark === 'audio' ? 'audio/mp4' : 'video/mp4'
    res.writeHead(r.statusCode ?? 502, out)
    // playurl 的响应要留一遍：里面的媒体主机是后续 <video>/<audio> 请求的通行证
    if (path.includes('/x/player/playurl')) {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => {
        const body = Buffer.concat(chunks)
        try {
          rememberMediaHostsDeep(JSON.parse(body.toString('utf8')))
        } catch {
          // 不是 JSON 就原样透传，不因为「记不住主机」把响应弄坏
        }
        res.end(body)
      })
      return
    }
    r.pipe(res)
  })
  up.on('error', (e: Error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`proxy error: ${e.message}`)
  })
  req.pipe(up)
}

export function biliProxy(): Plugin {
  return {
    name: 'knowlattice-bili-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(PREFIX)) return next()
        const rest = url.slice(PREFIX.length)
        const qi = rest.indexOf('?')
        const pathPart = qi >= 0 ? rest.slice(0, qi) : rest
        const query = qi >= 0 ? rest.slice(qi) : ''
        const cut = pathPart.indexOf('/')
        if (cut <= 0) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('用法：/bili-proxy/<host>/<path>')
          return
        }
        const host = pathPart.slice(0, cut)
        if (!allowedHost(host)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`不允许代理的主机：${host}`)
          return
        }
        pass(req, res, host, pathPart.slice(cut) + query)
      })
    },
  }
}

/** 供 node 侧自检：解析 /bili-proxy/... 的宿主与路径 */
export function parseProxyUrl(raw: string): { host: string; path: string } | null {
  if (!raw.startsWith(PREFIX)) return null
  const rest = raw.slice(PREFIX.length)
  const q = rest.indexOf('?')
  const pathOnly = q >= 0 ? rest.slice(0, q) : rest
  const cut = pathOnly.indexOf('/')
  if (cut <= 0) return null
  const host = pathOnly.slice(0, cut)
  const p = rest.slice(cut)
  return allowedHost(host) ? { host, path: p } : null
}

export default biliProxy

/** 仅用于本地自检脚本 */
export const _test = { allowedHost, http }
