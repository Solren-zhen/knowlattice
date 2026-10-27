/**
 * 视频笔记面板：本地文件 / 直链 / B 站 / 抖音 / 网盘链接，统一进来。
 *
 * 三种形态决定了控件差异（原因写在 core/videoSource 里）：
 * - `<video>`（本地、直链 mp4/webm）：能读 currentTime，锚点、A-B 循环、截帧全部可用；
 * - B 站原生播放：拿到媒体流后同样能读 currentTime、截帧和 A-B；代理失败才退回 iframe；
 * - 抖音 / 网盘 / 普通网页：不能内嵌播放 → 只记锚点，点锚点时在浏览器打开并落到该秒。
 *
 * 不做的两件事写在这里免得后面又找：站内 OCR（没有离线引擎）、抖音直链抓取（要第三方接口）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../core/feedback';
import { formatTime, parseTimestamp } from '../core/subtitle';
import {
  addClip,
  anchorMarkdown,
  clipRange,
  clipMarkdown,
  clipsFor,
  formatClipRange,
  loadClips,
  loopNext,
  removeClip,
  type VideoClip,
} from '../core/videoNotes';
import { bilibiliEmbed, parseBilibili, parseVideoSource, withStart } from '../core/videoSource';
import BiliPlayer from './BiliPlayer';

interface Props {
  /**
   * 真正的播放地址 / 原始页地址（blob: / http(s)）。
   * 本地文件是 blob:（浏览器与 Tauri 都能直接播，不依赖资源协议），
   * B 站是原始视频页（iframe 需要它拼 player 地址），抖音/网盘是分享页。
   * 空串表示还没选。
   */
  src?: string | null;
  /** 片段归属键（B 站按 BV+分P 归并），只用来分组收藏，不参与播放 */
  media: string;
  title?: string;
  /** 外部请求的跳转位置（点笔记里的锚点） */
  seekTo?: number | null;
  /** 锚点位置已被面板采用：让上层清掉，否则用户点片段会被旧锚点覆盖 */
  onSeekConsumed?: () => void;
  onPick: () => void;
  /** 粘一个链接进来（B 站 / 抖音 / 网盘 / 直链） */
  onUrl: (url: string) => void;
  onInsert: (markdown: string) => boolean;
  onAttach: (name: string, blob: Blob) => Promise<string | null>;
  /** 附件是否已占用（截帧重名让位用；不给就退回原始文件名，会覆盖同名的旧帧） */
  hasAttachment?: (path: string) => boolean;
  onClose: () => void;
  /** 折叠区开合后通知宿主：内容量变了，宿主可把钉死的高度回收成自适应 */
  onFoldToggle?: () => void;
  /** 标题栏按下开始拖动（由 usePanelDrag 提供）；双击复位 */
  onDragStart?: (e: React.PointerEvent<HTMLElement>) => void;
  onDragReset?: () => void;
  /** 左上角缩放抓手：指针拖动、键盘调整、双击恢复默认尺寸 */
  onResizeStart?: (e: React.PointerEvent<HTMLElement>) => void;
  onResizeKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
  onResizeReset?: () => void;
}

/**
 * 面板里除「视频本体」外的一切区块都可折叠：来源 / 时间轴 / 控制 / 写作 / 片段库。
 * 收起状态按 id 记进 localStorage —— 每个人关心的区块不同（有人只要片段库，有人只要写作），
 * 不该每次打开都按同一份默认摊开。
 */
const FOLD_KEY = 'knowlattice.video.folds';
function readFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLD_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
  } catch { return {}; }
}
function Foldable({ id, title, hint, onToggle, children }: {
  id: string;
  title: string;
  hint?: string;
  /**
   * 开合之后通知宿主：内容量变了，被分隔条钉死的高度该回收成自适应，
   * 否则收起后会在面板里留一大片空白（用户实测反馈过这一点）。
   * 刻意放在 updater 之外调用——副作用不写进 setState updater。
   */
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readFolds()[id] !== false);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        const all = readFolds();
        all[id] = next;
        localStorage.setItem(FOLD_KEY, JSON.stringify(all));
      } catch { /* 隐私模式：这次会话内照样可折叠 */ }
      return next;
    });
    onToggle?.();
  };
  return (
    <section className={`vn-fold${open ? '' : ' is-closed'}`}>
      <button type="button" className="vn-fold__head" aria-expanded={open} onClick={toggle}>
        <span className="vn-fold__chev" aria-hidden="true" />
        <b>{title}</b>
        {hint ? <span className="vn__hint">{hint}</span> : null}
      </button>
      {open ? <div className="vn-fold__body">{children}</div> : null}
    </section>
  );
}

export default function VideoNoteView({
  src,
  media,
  title,
  seekTo = null,
  onSeekConsumed,
  onPick,
  onUrl,
  onInsert,
  onAttach,
  hasAttachment,
  onClose,
  onDragStart,
  onDragReset,
  onResizeStart,
  onResizeKeyDown,
  onResizeReset,
  onFoldToggle,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 待应用的外部跳转：元数据没就绪时设 currentTime 会被忽略，等 loadedmetadata 再补一次 */
  const pendingSeekRef = useRef<number | null>(null);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [clips, setClips] = useState<VideoClip[]>(loadClips);
  const [label, setLabel] = useState('');
  const [tags, setTags] = useState('');
  const [query, setQuery] = useState('');
  const [broken, setBroken] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  /** iframe 播放器的时间点：改它就换一个带 t 的地址（跨域只能这么跳） */
  const [frameAt, setFrameAt] = useState(0);
  /** 读不到进度的来源，时间只能手填 */
  const [manual, setManual] = useState('');
  /**
   * B 站是否走原生播放。默认走：只有原生播放能读到进度、能按账号权益切清晰度。
   * 代理不可用（比如打包后的桌面版还没接同样的转发）时退回官方 iframe，并说明原因。
   */
  const [nativeBili, setNativeBili] = useState(true);
  /** B 站原生播放器真正挂出 <video> 后才能把 0 秒当成有效位置 */
  const [nativeReady, setNativeReady] = useState(false);

  /**
   * 解析播放来源。**优先用 src**：media 可能是片段归组键（'bili:BV…:p2'），
   * 拿它去解析会得到「本地文件」，于是本地播放器拿一个文件名去请求 → 404 → 什么都不播。
   */
  const effective = src || media;
  const source = useMemo(() => parseVideoSource(effective), [effective]);
  const canSeek = source.seekable || (source.kind === 'bilibili' && nativeBili && nativeReady);
  const visible = useMemo(() => clipsFor(clips, media, query), [clips, media, query]);
  const manualSeconds = parseTimestamp(manual);
  const activeClipId = useMemo(() => {
    const hit = visible.find((clip) => (
      clip.end == null
        ? Math.abs(now - clip.start) < 1.5
        : now >= clip.start && now <= clip.end
    ));
    return hit?.id ?? null;
  }, [visible, now]);

  /**
   * 换视频时的状态清空靠**重挂载**（Workspace 里 `<VideoNoteView key={videoMedia}>`），
   * 不在这里 setState 重置：状态挂在 media 上才是它真正的归属，用 effect 重置既会多一轮渲染
   * （lint 的 set-state-in-effect 拦的就是这个），也容易顺手把「刚设好的 A/B」清掉。
   */

  /**
   * 点笔记锚点（本地 / 直链）：真的设置 currentTime。
   *
   * 两件事都在这里做：
   * ① **元数据没就绪就排队**——尚未 loadedmetadata 时设 currentTime，各内核落地时机并不一致，
   *    常见表现就是「点了锚点没反应」；记进 pendingSeekRef 由 loadedmetadata 补上。
   * ② **立刻采掉这次请求**（onSeekConsumed）。之前只有 B 站分支会采，本地分支不采，
   *    于是 `seekTo` 一直停在同一个值上：用户拖走后再点同一个 `[▶ 12:34]`，
   *    setState 同值不触发重渲染，effect 依赖也没变 —— 第二次点就是没反应。
   */
  useEffect(() => {
    if (seekTo == null) return;
    if (source.kind === 'bilibili') return; // iframe 跳转靠地址推导，见 frameTarget
    if (!source.seekable) return;
    const v = videoRef.current;
    if (!v) return;
    if (v.readyState < 1) {
      pendingSeekRef.current = seekTo;
    } else {
      pendingSeekRef.current = null;
      v.currentTime = Math.max(0, seekTo);
      void v.play().catch(() => undefined);
    }
    onSeekConsumed?.();
  }, [seekTo, source.kind, source.seekable, onSeekConsumed]);

  /** 播放位置同步 + A-B 循环。timeupdate 约 4 次/秒，足够且比逐帧便宜。 */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      setNow(v.currentTime);
      const back = loopNext(v.currentTime, a, b);
      if (back != null) v.currentTime = back;
    };
    const meta = () => {
      setDuration(v.duration || 0);
      const pending = pendingSeekRef.current;
      if (pending == null) return;
      pendingSeekRef.current = null;
      v.currentTime = Math.max(0, pending);
      void v.play().catch(() => undefined);
    };
    const fail = () => setBroken(true);
    v.addEventListener('timeupdate', sync);
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('error', fail);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('loadedmetadata', meta);
      v.removeEventListener('error', fail);
    };
  }, [a, b, canSeek]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t);
    setNow(v.currentTime);
  }, []);

  /** 记锚点用的秒数：能读进度用真实位置，读不到用用户手填的 */
  const anchorSeconds = (): number | null => {
    if (canSeek) return Math.floor(now);
    if (manualSeconds == null) {
      toast('这个来源读不到播放位置：先在上面填时间（如 12:34）', 'info', 5200);
      return null;
    }
    return manualSeconds;
  };

  const insertAnchor = () => {
    const sec = anchorSeconds();
    if (sec == null) return;
    const tagList = tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
    const annotation = [label.trim(), ...tagList.map((tag) => `#${tag.replace(/^#+/, '')}`)]
      .filter(Boolean)
      .join(' ');
    if (!onInsert(anchorMarkdown(sec, annotation))) {
      toast('先打开一篇笔记，再记时间点', 'info');
      return;
    }
    toast(`已记下 ${formatTime(sec)}`, 'ok', 2200);
  };

  const saveClip = () => {
    if (!media) {
      toast('先选一个视频（本地文件或粘贴链接），收藏才有归属', 'info', 4200);
      return;
    }
    const sec = anchorSeconds();
    if (sec == null) return;
    // 设了 A/B 就收藏那一段（与当前播放位置无关）；没设满才是当前秒的单点收藏
    const range = clipRange(a, b, sec);
    const tagList = tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
    const r = addClip({
      media,
      start: range.start,
      end: range.end,
      label: label.trim(),
      tags: tagList,
    });
    setClips(r.clips);
    if (!r.ok) toast('收藏没写进本机存储（可能满了）', 'err', 6000);
    else {
      toast(range.end == null ? '已收藏片段' : '已收藏这一段', 'ok', 1800);
      setLabel('');
      setTags('');
    }
  };

  const saveClipOnShortcut = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || (!e.ctrlKey && !e.metaKey)) return;
    e.preventDefault();
    saveClip();
  };

  /** 截当前帧：canvas 取原像素尺寸 → Blob → vault → 插进笔记 */
  /** 截当前帧：canvas 取原像素尺寸 → Blob → vault → 插进笔记 */
  const captureFrame = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) {
      toast('画面还没准备好（远端 iframe 读不到画面，截帧只对本地/直链视频有效）', 'info', 5200);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    try {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((x) => resolve(x), 'image/png'));
    } catch {
      // 跨域直链没开 CORS 时画布被污染，toBlob 抛 SecurityError
      toast('这个视频不允许抓帧（跨域限制）：换本地文件，或让直链服务器给 CORS 头', 'err', 6000);
      return;
    }
    if (!blob) {
      toast('截图失败', 'err');
      return;
    }
    // 文件名让位：两个视频的同一秒都叫「帧-12-34.png」，直接落库会覆盖前一张，
    // 于是先前那篇笔记里的图静默变成另一个视频的画面（错图不报错，事后无法归因）。
    const name = uniqueFrameName(`帧-${formatTime(now).replace(/:/g, '-')}`, hasAttachment);
    let path: string | null = null;
    try {
      path = await onAttach(name, blob);
    } catch (e) {
      toast(`截图没存进 vault：${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
      return;
    }
    if (!path) {
      toast('截图没存进 vault', 'err');
      return;
    }
    if (!onInsert(`![](${path})`)) toast('先打开一篇笔记，截图才能插进去', 'info');
    else toast(`截图已插入（${formatTime(now)}）`, 'ok', 2200);
  };

  /** 点片段：能读进度的直接跳；B 站改 iframe 地址；其余开浏览器落到该秒 */
  const jumpClip = useCallback((clip: VideoClip) => {
    if (canSeek) seek(clip.start);
    else if (source.kind === 'bilibili') {
      onSeekConsumed?.();
      setFrameAt(clip.start);
    } else if (source.pageUrl) window.open(withStart(source.pageUrl, clip.start), '_blank', 'noopener');
  }, [source.kind, source.pageUrl, canSeek, onSeekConsumed, seek]);

  const deleteClip = useCallback((id: string) => {
    const r = removeClip(id);
    setClips(r.clips);
  }, []);

  const insertVisibleClips = () => {
    if (visible.length === 0) return;
    if (!onInsert(visible.map(clipMarkdown).join('\n'))) {
      toast('先打开一篇笔记，片段才能插进去', 'info');
      return;
    }
    toast(`已插入 ${visible.length} 条片段`, 'ok', 1800);
  };

  const insertClipNote = useCallback((clip: VideoClip) => {
    if (!onInsert(clipMarkdown(clip))) {
      toast('先打开一篇笔记，片段才能插进去', 'info');
      return;
    }
    toast(`已插入 ${formatClipRange(clip)}`, 'ok', 1800);
  }, [onInsert]);

  const loopClip = useCallback((clip: VideoClip) => {
    if (clip.end == null) return;
    setA(clip.start);
    setB(clip.end);
    seek(clip.start);
    toast(`A-B 循环：${formatClipRange(clip)}`, 'ok', 1800);
  }, [seek]);

  const submitUrl = () => {
    const raw = urlDraft.trim();
    if (!raw) return;
    onUrl(raw);
    setUrlDraft('');
  };

  const bili =
    source.kind === 'bilibili' ? parseBilibili(source.pageUrl ?? effective) : null;
  const markNativeReady = useCallback((video: HTMLVideoElement) => {
    setNativeReady(true);
    setNow(video.currentTime);
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
  }, []);
  /** iframe 要跳到的秒数：锚点请求优先；点片段时上层会清掉 seekTo，于是用 frameAt */
  const frameTarget = useMemo(
    () => (source.kind === 'bilibili' && seekTo != null ? Math.floor(seekTo) : frameAt),
    [source.kind, seekTo, frameAt],
  );
  const timelineProgress = duration > 0 ? Math.min(100, (now / duration) * 100) : 0;

  return (
    <section className="vn" aria-label="视频笔记">
      <header
        // 拖动/缩放能力由外部注入（浮窗时代传 usePanelDrag/usePanelResize）。
        // 停靠进「视频 + AI 笔记」那一栏后外部不再传，于是这里也不能再挂 grab 光标和
        // 「拖动可移动面板」的 title —— 否则界面承诺了一个做不到的动作。
        className={`vn__head${onDragStart ? ' vn__head--drag' : ''}`}
        onPointerDown={onDragStart}
        onDoubleClick={onDragReset}
        title={onDragStart ? '拖动可移动面板，双击复位' : undefined}
      >
        {onResizeStart && (
          <button
            type="button"
            className="vn__resize"
            aria-label="调整视频窗口大小"
            title="向左上拖放大，向右下拖缩小；双击恢复默认大小"
            onPointerDown={onResizeStart}
            onKeyDown={onResizeKeyDown}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onResizeReset?.();
            }}
          >
            <span aria-hidden="true" />
          </button>
        )}
        <b className="vn__title">{title || source.title || '视频笔记'}</b>
        {canSeek ? (
          <span className="vn__time">
            {formatTime(now)}
            {duration ? ` / ${formatTime(duration)}` : ''}
          </span>
        ) : (
          <span className="vn__time">
            {source.kind === 'bilibili' ? `跳到 ${formatTime(frameTarget)}` : source.pageUrl ? '外部来源' : '未选择'}
          </span>
        )}
        <span className="spacer" />
        <button className="btn-small" onClick={onPick}>本地文件</button>
        <button className="btn-small" onClick={onClose} aria-label="关闭视频笔记">关闭</button>
      </header>

      <div className="vn__body">
      {/* 视频常驻区：视频、时间轴、控制都在这里，不随笔记区一起滚走 */}
      <div className="vn__stage">
      {/* 粘贴链接：B 站 / 抖音 / 网盘 / 直链都从这里进 */}
      <Foldable onToggle={onFoldToggle} id="source" title="视频来源">
      <div className="vn__row vn__source">
        <input
          className="vn__input"
          value={urlDraft}
          placeholder="粘贴视频链接（B站 BV/av、抖音、网盘分享页、mp4 直链）"
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
        />
        <button className="btn-small" onClick={submitUrl}>打开链接</button>
      </div>
      </Foldable>

      {source.kind === 'bilibili' && bili && nativeBili ? (
        <BiliPlayer
          bvid={bili.bvid ?? ''}
          page={bili.page}
          seekTo={seekTo}
          onSeekConsumed={onSeekConsumed}
          videoRef={videoRef}
          onReady={markNativeReady}
          onFallback={() => setNativeBili(false)}
        />
      ) : source.kind === 'bilibili' && bili ? (
        <iframe
          className="vn__frame"
          // 换 key + 带 t 的地址 = 跳到指定秒（跨域读不到进度，只能靠重载）
          key={`${bili.bvid ?? bili.aid}:${bili.page}:${frameTarget}`}
          title={source.title}
          src={bilibiliEmbed({ ...bili, at: frameTarget }, frameTarget > 0)}
          allow="autoplay; fullscreen; encrypted-media"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      ) : canSeek ? (
        <video
          ref={videoRef}
          className="vn__video"
          src={source.playUrl ?? effective ?? undefined}
          controls
          playsInline
          // 不设 crossOrigin：跨域直链缺 CORS 头时，设了它连播放都会被拒。
          // 取帧失败（画布被污染）由 capture() 的 catch 提示用户。
        />
      ) : (
        <div className="vn__empty">
          {source.note || '还没有视频。点「本地文件」选一个，或在上面的输入框粘贴 B 站 / 抖音 / 网盘 / mp4 直链后按「打开链接」。'}
        </div>
      )}

      {canSeek && duration > 0 && (
        <Foldable onToggle={onFoldToggle} id="timeline" title="时间轴" hint={visible.length > 0 ? `${visible.length} 个时间点` : '拖动定位'}>
        <div className="vn__timeline-wrap">
          <div className="vn__timeline">
            {visible.map((clip) => (
              <span
                key={clip.id}
                className="vn__timeline-mark"
                style={{ left: `${Math.min(100, (clip.start / duration) * 100)}%` }}
                title={`${formatClipRange(clip)}${clip.label ? ` · ${clip.label}` : ''}`}
                aria-hidden="true"
              />
            ))}
            <input
              className="vn__range"
              type="range"
              min="0"
              max={duration}
              step="0.1"
              value={Math.min(now, duration)}
              style={{ '--vn-progress': `${timelineProgress}%` } as React.CSSProperties}
              aria-label="播放进度"
              onChange={(e) => seek(Number(e.currentTarget.value))}
            />
          </div>
          <div className="vn__timeline-meta">
            <span>{formatTime(now)}</span>
            <span>{visible.length > 0 ? `${visible.length} 个时间点` : '拖动定位'}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
        </Foldable>
      )}

      {source.kind === 'bilibili' && bili && !nativeBili ? (
        <p className="vn__warn">
          原生播放不可用（多半是没走 dev 转发），已退回官方内嵌播放器：能看，但跨域读不到进度，
          清晰度由播放器自己决定。想用账号的最高清晰度，用 `npm run dev` 打开本应用。
        </p>
      ) : null}

      {broken && (
        <p className="vn__warn">
          这个视频浏览器解不了（编码不支持，或直链需要登录/CORS）。本地文件建议 mp4(H.264) 或 webm。
        </p>
      )}

      {/* 读不到进度的来源：手动时间 + 跳转 + 打开原页 */}
      {!canSeek && source.pageUrl && (
        <div className="vn__row">
          <input
            className="vn__input vn__input--time"
            value={manual}
            placeholder="时间 12:34"
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            className="btn-small"
            disabled={manualSeconds == null}
            onClick={() => {
              if (manualSeconds == null) return;
              if (source.kind === 'bilibili') setFrameAt(manualSeconds);
              else window.open(withStart(source.pageUrl ?? '', manualSeconds), '_blank', 'noopener');
            }}
          >
            {source.kind === 'bilibili' ? '跳到该时间' : '浏览器打开该时间'}
          </button>
          <button className="btn-small" onClick={() => window.open(source.pageUrl ?? '', '_blank', 'noopener')}>
            打开原页
          </button>
        </div>
      )}

      {canSeek && (
        <Foldable onToggle={onFoldToggle} id="controls" title="播放控制" hint={a != null || b != null ? 'A-B 已设' : undefined}>
        <div className="vn__row vn__controls">
          <button className="btn-small" onClick={() => seek(now - 3)}>−3 秒</button>
          <button className="btn-small" onClick={() => seek(now + 3)}>+3 秒</button>
          <button className="btn-small" onClick={() => void captureFrame()}>截当前帧</button>
          <button className="btn-small" onClick={() => setA(now)}>
            设 A{a != null ? `（${formatTime(a)}）` : ''}
          </button>
          <button className="btn-small" onClick={() => setB(now)}>
            设 B{b != null ? `（${formatTime(b)}）` : ''}
          </button>
          <button
            className="btn-small"
            disabled={a == null && b == null}
            onClick={() => { setA(null); setB(null); }}
          >
            清除循环
          </button>
        </div>
        </Foldable>
      )}

      </div>

      {/* 笔记区：写备注 + 片段库，自己滚动，不挤压上面的视频 */}
      <div className="vn__note">
      <Foldable onToggle={onFoldToggle} id="compose" title="写下这一刻" hint="备注会随「记时间点」和「收藏片段」写入">
      <div className="vn__composer">
        <div className="vn__composer-fields">
          <input
            className="vn__input"
            value={label}
            placeholder="这一段是什么（可空）"
            aria-label="片段备注"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={saveClipOnShortcut}
          />
          <input
            className="vn__input vn__input--tags"
            value={tags}
            placeholder="标签，用空格分开"
            aria-label="片段标签"
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={saveClipOnShortcut}
          />
        </div>
        <div className="vn__composer-actions">
          <span className="vn__hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> 收藏</span>
          <span className="spacer" />
          <button className="btn-small" onClick={insertAnchor}>记时间点</button>
          <button className="btn-small vn__capture" onClick={saveClip}>收藏片段</button>
        </div>
      </div>
      </Foldable>

      <Foldable onToggle={onFoldToggle} id="library" title="片段库" hint={`${visible.length} 条`}>
      <div className="vn__library-head">
        <input
          className="vn__input vn__input--search"
          value={query}
          placeholder="搜备注、标签或时间"
          aria-label="搜索片段"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="vn__count">{visible.length}</span>
        <button className="btn-small" disabled={visible.length === 0} onClick={insertVisibleClips}>
          全部入笔记
        </button>
      </div>

      <ClipList
        clips={visible}
        activeId={activeClipId}
        canLoop={canSeek}
        onJump={jumpClip}
        onInsert={insertClipNote}
        onLoop={loopClip}
        onRemove={deleteClip}
      />
      </Foldable>
      </div>

      </div>
    </section>
  );
}

/** 截帧文件名让位：同名的帧不覆盖。极端情况（同名太多）退化成时间戳，宁可名字丑也不覆盖。 */
function uniqueFrameName(base: string, taken?: (p: string) => boolean): string {
  if (!taken || !taken(`_attachments/${base}.png`)) return `${base}.png`;
  for (let i = 1; i <= 200; i++) {
    const cand = `${base}-${i}.png`;
    if (!taken(`_attachments/${cand}`)) return cand;
  }
  return `帧-${Date.now().toString(36)}.png`;
}

/**
 * 片段清单单独成一个 memo 组件：
 * 播放位置走 timeupdate（约 4 次/秒），每次都让整个面板重渲染。内联写在这里的话，
 * 几十条片段的表格每秒被重建四次——看着只是「有点钝」，实际是白白跑满主线程。
 * 清单只依赖 clips 与两个稳定回调，与 `now` 无关。
 */
const ClipList = memo(function ClipList({ clips, activeId, canLoop, onJump, onInsert, onLoop, onRemove }: {
  clips: VideoClip[];
  activeId: string | null;
  canLoop: boolean;
  onJump: (clip: VideoClip) => void;
  onInsert: (clip: VideoClip) => void;
  onLoop: (clip: VideoClip) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="vn__clips">
      {clips.map((c) => (
        <li key={c.id} className={c.id === activeId ? 'is-active' : undefined}>
          <button className="vn__jump" onClick={() => onJump(c)}>
            <span className="vn__clip-dot" aria-hidden="true" />
            {formatClipRange(c)}
          </button>
          <div className="vn__clip-copy">
            <span className="vn__label">{c.label || '（无备注）'}</span>
            {c.tags.length > 0 && (
              <span className="vn__tags">
                {c.tags.map((tag) => <span key={tag} className="vn__tag">{tag}</span>)}
              </span>
            )}
          </div>
          <span className="spacer" />
          <div className="vn__clip-actions">
            {canLoop && c.end != null && (
              <button
                className="btn-small"
                aria-label={`把片段 A-B 循环设为 ${formatClipRange(c)}`}
                onClick={() => onLoop(c)}
              >
                循环
              </button>
            )}
            <button
              className="btn-small"
              aria-label={`把片段 ${formatClipRange(c)} 插入笔记`}
              onClick={() => onInsert(c)}
            >
              入笔记
            </button>
            <button
              className="btn-small danger"
              aria-label={`删除片段 ${formatClipRange(c)}`}
              onClick={() => onRemove(c.id)}
            >
              删
            </button>
          </div>
        </li>
      ))}
      {clips.length === 0 && <li className="vn__hint">还没有收藏。播放到关键处点「收藏片段」。</li>}
    </ul>
  );
});
