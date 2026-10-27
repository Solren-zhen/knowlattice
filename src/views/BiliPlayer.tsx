/**
 * B 站原生播放（登录一次 → 按账号权益取最高清晰度）。
 *
 * 为什么不用内嵌 iframe：清晰度由播放器自己定、跨域读不到进度、账号态在第三方 iframe 里不可靠。
 * 这里走官方 playurl 接口，拿到 DASH 音视频分轨，用自己的 <video> 播：
 *   · 进度可读可写 → 「记时间点 / A-B 复读 / 截帧」全部对 B 站视频生效；
 *   · 清晰度可切 → 从接口返回的 accept_quality 里点；
 *   · 账号只存一次 cookie（SESSDATA），之后每次打开自动取这个账号能拿到的最高档。
 *
 * 音画分轨：DASH 的视频流不含音轨，所以另挂一个 <audio> 跟随 <video>。
 * 以 video 为主时钟，只在明显漂移时纠正 —— 每帧都 set 会让声音断续。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  QUALITY_LABEL,
  clearAccount,
  fetchPlayurl,
  fetchView,
  loadAccount,
  proxied,
  saveAccount,
  topQuality,
  type BiliAccount,
  type BiliPlayInfo,
  type BiliView,
} from '../core/biliPlay'

interface Props {
  bvid: string
  /** 分P（1 起） */
  page: number
  /** 外部请求的跳转秒数（点笔记锚点） */
  seekTo?: number | null
  onSeekConsumed?: () => void
  /** 面板自己的「记时间点 / 截帧」要用这个元素 */
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 原生播放器已挂载且元数据可读（上层据此开放进度、锚点与 A-B 控件） */
  onReady?: (video: HTMLVideoElement) => void
  /** 原生播放不可用（比如没走 dev 代理）时，退回内嵌播放器 */
  onFallback: (reason: string) => void
}

/** 音画对齐容差：小于这个差距不动手，否则每次 timeupdate 都 set 会让声音顿一下 */
const DRIFT_TOLERANCE = 0.35

export default function BiliPlayer({
  bvid,
  page,
  seekTo = null,
  onSeekConsumed,
  videoRef,
  onReady,
  onFallback,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /**
   * 请求序号：每次取地址自增，回来时对不上就整段丢弃。
   * 切分P / 切画质会并发两三次请求，先发的若后回来会把界面覆盖成过期结果
   * （地址是 4K 的、按钮高亮 720P，`busy` 也会被提前按掉）。
   */
  const reqIdRef = useRef(0)
  const [acc, setAcc] = useState<BiliAccount | null>(() => loadAccount())
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<BiliView | null>(null)
  const [info, setInfo] = useState<BiliPlayInfo | null>(null)
  const [wantQn, setWantQn] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cid = useMemo(() => {
    if (!view) return null
    const p = view.parts.find((x) => x.page === page) ?? view.parts[0]
    return p?.cid ?? view.cid
  }, [view, page])

  /** 拉视频信息（cid）+ 播放地址。wantQn 为空时先要 127（8K），接口按权益回落 */
  const load = useCallback(
    async (qn: number | null) => {
      const reqId = ++reqIdRef.current
      setBusy(true)
      setErr(null)
      try {
        const v = await fetchView(bvid, acc)
        if (reqId !== reqIdRef.current) return
        setView(v)
        const target =
          v.parts.find((x) => x.page === page)?.cid ?? v.cid
        const p = await fetchPlayurl(bvid, target, acc, qn ?? 127)
        if (reqId !== reqIdRef.current) return
        setInfo(p)
        if (!p.video && !p.durl.length) {
          setErr('这个视频接口没给可播地址（可能仅限客户端播放）')
        }
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        const msg = (e as Error).message
        setErr(msg)
        // 代理不可用 / 接口被墙这类硬失败，退回内嵌播放器比干瞪眼强
        if (/Failed to fetch|接口 4\d\d|proxy error/i.test(msg)) onFallback(msg)
      } finally {
        // 只有仍是最新那次请求才能清 busy：过期请求提前清掉会让界面在还在加载时显示可点
        if (reqId === reqIdRef.current) setBusy(false)
      }
    },
    [acc, bvid, page, onFallback],
  )

  useEffect(() => {
    void load(wantQn)
    // 只跟「换视频 / 换分P / 换账号」重建。wantQn 由 switchQn 自己发请求（它还要恢复进度与播放态），
    // 放进依赖会让一次切画质发两次请求。这里读到的 wantQn 只是「上次选的档位」，用于重新取地址。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bvid, page, acc])

  /** 点清晰度：重取地址，保留当前播放进度与播放状态 */
  const switchQn = (qn: number) => {
    const v = videoRef.current
    const at = v?.currentTime ?? 0
    const wasPlaying = v ? !v.paused : false
    setWantQn(qn)
    void (async () => {
      const reqId = ++reqIdRef.current
      setBusy(true)
      setErr(null)
      try {
        if (!cid) return
        const p = await fetchPlayurl(bvid, cid, acc, qn)
        if (reqId !== reqIdRef.current) return
        setInfo(p)
        // 换 source 会重置进度：等下一次 loadedmetadata 再跳回去。
        // rAF 等一帧是为了拿「新地址已经写进 DOM」之后的那个元素；旧元素不会再来
        // loadedmetadata，监听到它身上就是永久等待。已就绪（缓存命中、不触发事件）时直接跳。
        requestAnimationFrame(() => {
          const el = videoRef.current
          if (!el) return
          const restore = () => {
            el.removeEventListener('loadedmetadata', restore)
            el.currentTime = at
            if (wasPlaying) void el.play().catch(() => undefined)
          }
          if (el.readyState >= 1) restore()
          else el.addEventListener('loadedmetadata', restore)
        })
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        setErr((e as Error).message)
      } finally {
        if (reqId === reqIdRef.current) setBusy(false)
      }
    })()
  }

  /** 音画同步：video 是主时钟 */
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const a = audioRef.current
    const sync = () => {
      if (!a) return
      if (Math.abs(a.currentTime - v.currentTime) > DRIFT_TOLERANCE) a.currentTime = v.currentTime
      a.playbackRate = v.playbackRate
    }
    const onPlay = () => {
      sync()
      void a?.play().catch(() => undefined)
    }
    const onPause = () => a?.pause()
    const onSeeked = () => sync()
    const onRate = () => {
      if (a) a.playbackRate = v.playbackRate
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeking', onSeeked)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('ratechange', onRate)
    v.addEventListener('timeupdate', sync)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeking', onSeeked)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('ratechange', onRate)
      v.removeEventListener('timeupdate', sync)
      a?.pause()
    }
  }, [videoRef, info])

  /** 点笔记里的锚点 */
  useEffect(() => {
    if (seekTo == null) return
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, seekTo)
    onSeekConsumed?.()
  }, [seekTo, onSeekConsumed, videoRef, info])

  const src = info?.video ? proxied(info.video.url, 'video') : (info?.durl[0] ? proxied(info.durl[0], 'video') : null)
  const top = info ? topQuality(info) : null

  return (
    <div className="bili">
      {src ? (
        <>
          <video
            ref={videoRef}
            className="vn__video"
            src={src}
            controls
            playsInline
            onLoadedMetadata={(e) => onReady?.(e.currentTarget)}
            // 不设 crossOrigin：CDN 不带 CORS 头时设了它连播放都会被拒；取帧失败由上层提示
          />
          {info?.audio ? <audio ref={audioRef} src={proxied(info.audio.url, 'audio')} preload="auto" /> : null}
        </>
      ) : (
        <div className="vn__empty">
          {busy ? '正在取播放地址…' : err ? err : '没有可播地址'}
        </div>
      )}

      <div className="bili__bar">
        <span className="vn__hint">
          {info ? `当前 ${info.label}` : '清晰度：—'}
          {top && info ? ` · 这个账号最高 ${top.label}` : ''}
        </span>
        <button className="btn-small" disabled={busy} onClick={() => void load(wantQn)}>
          重新取地址
        </button>
      </div>

      {info && info.qualities.length > 1 ? (
        <div className="bili__row">
          {info.qualities
            .slice()
            .reverse()
            .map((q) => (
              <button
                key={q.qn}
                className={`chip${q.qn === info.qn ? ' on' : ''}`}
                disabled={busy}
                onClick={() => switchQn(q.qn)}
                title={`${QUALITY_LABEL[q.qn] ?? q.label}（${q.qn}）`}
              >
                {q.label}
              </button>
            ))}
        </div>
      ) : null}

      {info?.limited && !acc ? (
        <p className="vn__warn">
          未登录只能取到 480P 及以下。粘贴一次 SESSDATA 后，自动按你账号的权益取最高清晰度。
        </p>
      ) : null}
      {err ? <p className="vn__warn">{err}</p> : null}

      <div className="bili__row bili__row--auth">
        {acc ? (
          <>
            <span className="vn__hint">已登录（SESSDATA 已存本机，只属于这台机器）</span>
            <button
              className="btn-small"
              onClick={() => {
                clearAccount()
                setAcc(null)
                setInfo(null)
                setWantQn(null)
                void load(null)
              }}
            >
              退出登录
            </button>
          </>
        ) : (
          <>
            <input
              className="vn__input"
              placeholder="粘贴 SESSDATA（登录一次即可，浏览器 DevTools → Application → Cookies）"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="btn-small"
              onClick={() => {
                const saved = saveAccount(draft)
                if (!saved) {
                  setErr('没认出 SESSDATA：整段 "SESSDATA=…; bili_jct=…" 或只粘 SESSDATA 的值都行')
                  return
                }
                setErr(null)
                setDraft('')
                setAcc(saved)
                setWantQn(null)
              }}
            >
              保存并取最高清晰度
            </button>
          </>
        )}
      </div>
    </div>
  )
}
