/**
 * 课程工坊：B 站课程（BV / 链接）→ 分P 字幕 → 讲义笔记 + 讲师人格卡。
 *
 * 边界（明确写在界面上，不偷偷越界）：
 * - 只读 B 站已有的 CC 字幕，不下载音频、不做 ASR；没有字幕的分P 列进「未收录」。
 * - 字幕清单多数要登录态，未登录时只会得到空清单——这里给出去「视频笔记」登录的指引。
 * - 生成走 AI 助手的同一份配置（core/agentSettings），不另存一套接口。
 * - 笔记落盘走 vault（createNote / save），人格卡落到「AI命令/人格/」，交给
 *   agentSkills 的常驻注入机制；界面会提醒「只有排序第一张卡会生效」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkAccount, clearAccount, fetchView, loadAccount, type BiliAccount } from '../core/biliPlay';
import { loadAgentSettings } from '../core/agentSettings';
import {
  COURSE_DIR,
  LOCAL_COURSE_DIR,
  assembleCourseNote,
  assembleEssenceNote,
  auditEssence,
  buildDigestMessages,
  buildEssenceMessages,
  buildLectureMessages,
  buildPersonaCard,
  buildPersonaMessages,
  courseNotePath,
  normalizeMaterialUrl,
  personaPath,
  safeTitle,
  splitTranscript,
  stripCodeFence,
  transcriptLines,
  type CourseMeta,
  type CourseOutline,
  type CourseVideoTarget,
  type NoteMode,
  type PartDigest,
  type LectureSection,
  type SkippedPart,
} from '../core/courseNotes';
import {
  fetchSubtitleCues,
  fetchSubtitleTracks,
  cuesToTranscript,
  parseBiliSubtitleJson,
  pickSubtitleTrack,
  subtitleOutOfRange,
  subtitleIncomplete,
} from '../core/biliSubtitles';
import { isAbortError, runAgent, type WireMessage } from '../core/aiAgent';
import { formatTime, parseSubtitle } from '../core/subtitle';
import { confirmBox } from '../core/feedback';
import { parseBilibili } from '../core/videoSource';
import { QR_POLL_MS, persistQrLogin, pollQrLogin, startQrLogin } from '../core/biliLogin';
import { encodeQr, qrPathData } from '../core/qrcode';
import {
  loadWorkshopSession,
  saveWorkshopSession,
  type CourseState,
  type PartRow,
} from '../core/courseSession';
import { escThenClose, useEsc } from './useEsc';
import PanelOverlay from './PanelOverlay';

interface Props {
  onClose: () => void;
  onToast: (msg: string, kind?: 'ok' | 'info' | 'err') => void;
  /** 现有笔记（判断重名，也给人格卡冲突提示） */
  docs: ReadonlyMap<string, string>;
  /** 写入已有笔记 */
  onSave: (path: string, content: string) => Promise<void>;
  /** 新建笔记（内部会切换当前笔记） */
  createNote: (dir: string, title: string, content: string) => Promise<string>;
  /** 保存后打开笔记 */
  onOpenNote: (path: string) => void;
  /** 在视频笔记里打开某个分P（会关闭本面板，但会话保持） */
  onOpenVideo?: (target: CourseVideoTarget) => void;
  /** 读取到课程后把大纲交给 Workspace：视频笔记据此显示课程名 / 分P名 */
  onCourseMeta?: (meta: CourseOutline) => void;
  /** 从视频笔记「返回课程工坊」时带回来的 BV 号 */
  initialBvid?: string;
}

type Busy = 'load' | 'probe' | 'gen' | 'persona' | null;

const BV_RE = /^BV[0-9A-Za-z]{10}$/;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 导入的文件当作一个「分P」：文件名去扩展名作小节标题。
 * 字幕类先按时间轴解析（B 站 JSON / SRT / VTT 都认），解析不出就保留原文，
 * 这样纯讲解稿、课件文本也能进来，不至于「导入成功但正文是空的」。
 */
function transcriptFromFile(name: string, raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'json') {
    try {
      const cues = parseBiliSubtitleJson(text);
      if (cues.length) return cuesToTranscript(cues);
    } catch {
      // 不是 B 站字幕 JSON：按纯文本处理
    }
  }
  if (ext === 'srt' || ext === 'vtt') {
    const cues = parseSubtitle(text);
    if (cues.length) return cuesToTranscript(cues);
  }
  return text;
}

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || name;
}

/** 登录二维码：直接画 SVG，避免为一次登录引入第三方库；四周留 4 个模块的静区才能扫 */
function QrSvg({ text }: { text: string }) {
  const code = useMemo(() => {
    try {
      const matrix = encodeQr(text);
      return { path: qrPathData(matrix), size: matrix.length };
    } catch {
      return { path: '', size: 0 };
    }
  }, [text]);
  if (!code.path) return <span className="cw-hint">二维码生成失败，请点「刷新二维码」重试</span>;
  const quiet = 4;
  return (
    <svg
      className="cw-qr__svg"
      viewBox={`${-quiet} ${-quiet} ${code.size + quiet * 2} ${code.size + quiet * 2}`}
      role="img"
      aria-label="B 站登录二维码"
    >
      <rect x={-quiet} y={-quiet} width={code.size + quiet * 2} height={code.size + quiet * 2} fill="#fff" />
      <path d={code.path} fill="#000" />
    </svg>
  );
}

export default function CourseWorkshopView({
  onClose,
  onToast,
  docs,
  onSave,
  createNote,
  onOpenNote,
  onOpenVideo,
  onCourseMeta,
  initialBvid,
}: Props) {
  useEsc(escThenClose(onClose));

  /** 上一次关闭面板时留下的课程 / 分P / 已生成内容：播放视频回来不用重新抓一遍 */
  const [restored] = useState(loadWorkshopSession);

  const [input, setInput] = useState(restored?.input ?? '');
  /** 整门课附带的网盘 / 资料链接：只记录与打开，不抓取视频或字幕 */
  const [materialUrl, setMaterialUrl] = useState(restored?.materialUrl ?? '');
  const [course, setCourse] = useState<CourseState | null>(restored?.course ?? null);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState(restored ? '已恢复上次课程' : '');
  const [stream, setStream] = useState('');
  const [noteTitle, setNoteTitle] = useState(restored?.noteTitle ?? '');
  const [persona, setPersona] = useState(restored?.persona ?? '');
  const [personaName, setPersonaName] = useState(restored?.personaName ?? '');
  const [error, setError] = useState('');
  /** 默认给精华：用户要的是「这节课讲了什么」，不是逐P讲义 */
  const [mode, setMode] = useState<NoteMode>(restored?.mode ?? 'essence');
  const [essence, setEssence] = useState(restored?.essence ?? '');
  /** 展开看字幕的分P；null = 全收起 */
  const [transcriptPage, setTranscriptPage] = useState<number | null>(null);

  /** 会话写回：只存内存，关面板去视频笔记再回来时原样恢复 */
  useEffect(() => {
    saveWorkshopSession({ input, course, noteTitle, mode, essence, persona, personaName, materialUrl });
  }, [input, course, noteTitle, mode, essence, persona, personaName, materialUrl]);

  /** 读取到的课程大纲交给 Workspace：视频笔记据此显示「哪门课 · 哪个分P」 */
  const courseMetaRef = useRef(onCourseMeta);
  courseMetaRef.current = onCourseMeta;
  useEffect(() => {
    // 本地导入没有 BV：不要把空 bvid 交给视频笔记
    if (!course || !course.view.bvid) return;
    courseMetaRef.current?.({
      bvid: course.view.bvid,
      title: course.view.title,
      ...(course.view.owner ? { owner: course.view.owner } : {}),
      parts: course.view.parts.map((p) => ({ page: p.page, part: p.part })),
    });
  }, [course]);

  const abortRef = useRef<AbortController | null>(null);
  const streamBuf = useRef('');
  const streamAt = useRef(0);
  /** 抓取日期固定成一次，避免每次渲染都换 clipped 导致预览抖动 */
  const clippedAt = useMemo(() => new Date(), []);

  const [account, setAccount] = useState<BiliAccount | null>(() => loadAccount());
  const settings = useMemo(() => loadAgentSettings(), []);
  /** 有效链接才算数：非 http(s) 的粘贴文本只提示，不写进笔记 */
  const materialLink = normalizeMaterialUrl(materialUrl);
  /** 本地导入的课程没有 BV：不抓字幕、不生成 B 站跳转，保存到「课程笔记」 */
  const isLocal = Boolean(course && !course.view.bvid);

  /** 扫码登录：二维码只在面板内展示，收起或成功即停止轮询 */
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<{ url: string; key: string } | null>(null);
  const [qrState, setQrState] = useState<{ status: string; message: string }>({
    status: 'waiting',
    message: '',
  });
  const fileRef = useRef<HTMLInputElement | null>(null);

  const meta = useMemo<CourseMeta | null>(() => {
    if (!course) return null;
    const v = course.view;
    return {
      ...(v.bvid ? { bvid: v.bvid } : { sourceLabel: '本地导入' }),
      title: v.title,
      ...(v.owner ? { owner: v.owner } : {}),
      partCount: v.parts.length,
      duration: v.duration,
      ...(materialLink ? { materialUrl: materialLink } : {}),
    };
  }, [course, materialLink]);

  const picked = course?.rows.filter((r) => r.picked) ?? [];
  const readyRows = picked.filter((r) => r.phase === 'ready' && r.transcript);
  const doneRows = picked.filter((r) => r.notePhase === 'done' && r.note);
  /** 视频笔记登录入口：已读取课程就用课程；还没读就用输入框里的 BV/链接 */
  const loginBvid =
    course?.view.bvid ?? (BV_RE.test(input.trim()) ? input.trim() : parseBilibili(input)?.bvid);
  const canSave =
    Boolean(meta) && busy !== 'gen' && (mode === 'essence' ? Boolean(essence) : doneRows.length > 0);

  const assembled = useMemo(() => {
    if (!meta || !course) return '';
    // 依赖只写 course：picked / doneRows 是每次渲染新建的数组，写进依赖会让整篇讲义重拼
    const rows = course.rows.filter((r) => r.picked);
    const sections: LectureSection[] = rows
      .filter((r): r is PartRow & { note: string } => r.notePhase === 'done' && Boolean(r.note))
      .map((r) => ({ page: r.page, part: r.part, duration: r.duration, body: r.note as string }));
    const skipped: SkippedPart[] = rows
      .filter((r) => r.phase === 'empty' || r.phase === 'error')
      .map((r) => ({
        page: r.page,
        part: r.part,
        reason: r.phase === 'empty' ? '该分P没有 CC 字幕' : `字幕抓取失败：${r.error || '未知错误'}`,
      }));
    if (mode === 'essence') return essence ? assembleEssenceNote(meta, essence, skipped, clippedAt) : '';
    return assembleCourseNote(meta, sections, skipped, clippedAt);
  }, [meta, course, mode, essence, clippedAt]);

  /** 生成后的确定性自检：结构/锚点/预算，不判断内容对错 */
  const essenceAudit = useMemo(
    () => (essence ? auditEssence(essence, { anchors: !isLocal }) : null),
    [essence, isLocal],
  );

  const patchRow = useCallback((page: number, patch: Partial<PartRow>) => {
    setCourse((prev) =>
      prev ? { ...prev, rows: prev.rows.map((r) => (r.page === page ? { ...r, ...patch } : r)) } : prev,
    );
  }, []);

  const loadCourse = async (rawInput = input): Promise<void> => {
    const raw = rawInput.trim();
    const bvid = BV_RE.test(raw) ? raw : parseBilibili(raw)?.bvid;
    if (!bvid) {
      setError('没认出 BV 号：粘视频链接或 BV1xxxxxxxxx 都可以。');
      return;
    }
    setBusy('load');
    setError('');
    setStatus('正在读取课程信息…');
    setPersona('');
    setStream('');
    setEssence('');
    try {
      const view = await fetchView(bvid, account);
      setCourse({
        view,
        rows: view.parts.map((p) => ({
          page: p.page,
          cid: p.cid,
          part: p.part,
          duration: p.duration ?? 0,
          picked: true,
          phase: 'idle',
          notePhase: 'idle',
          digestPhase: 'idle',
        })),
      });
      setNoteTitle(safeTitle(view.title));
      setPersonaName(view.owner || '讲师');
      setStatus(`已读取：${view.parts.length} 个分P · 总时长 ${formatTime(view.duration)}`);
    } catch (e) {
      setError(errText(e));
      setStatus('');
    } finally {
      setBusy(null);
    }
  };

  /**
   * 本地 / 网盘导入：每个文件当作一个「分P」，不依赖 B 站字幕。
   * 支持 .srt / .vtt / .txt / .md / B 站字幕 .json；标题用第一个文件名去扩展名。
   */
  const importFiles = async (files: FileList | null): Promise<void> => {
    const list = files ? [...files] : [];
    if (!list.length) return;
    setError('');
    setStatus('正在读取导入文件…');
    try {
      const rows: PartRow[] = [];
      for (const [i, file] of list.entries()) {
        const transcript = transcriptFromFile(file.name, await file.text());
        if (!transcript) continue;
        rows.push({
          page: i + 1,
          cid: 0,
          part: fileStem(file.name),
          duration: 0,
          picked: true,
          phase: 'ready',
          transcript,
          notePhase: 'idle',
          digestPhase: 'idle',
        });
      }
      if (!rows.length) {
        setError('这些文件里没有可读文本：支持 .srt / .vtt / .txt / .md / B 站字幕 .json。');
        setStatus('');
        return;
      }
      const title = fileStem(list[0].name);
      setCourse({
        view: {
          bvid: '',
          title,
          duration: 0,
          cid: 0,
          parts: rows.map((r) => ({ page: r.page, cid: r.cid, part: r.part, duration: r.duration })),
        },
        rows,
      });
      setNoteTitle(safeTitle(title));
      setEssence('');
      setStream('');
      setPersona('');
      setStatus(`已导入 ${rows.length} 个文件 · 选好生成方式后直接点「生成精华 / 生成讲义」`);
    } catch (e) {
      setError(errText(e));
      setStatus('');
    }
  };

  /** 扫码登录：拿到二维码内容 → 面板里画出来 → 轮询到成功就把 cookie 落盘 */
  const beginQr = async (): Promise<void> => {
    setQrOpen(true);
    setQr(null);
    setQrState({ status: 'waiting', message: '正在获取二维码…' });
    try {
      const ticket = await startQrLogin();
      setQr(ticket);
      setQrState({ status: 'waiting', message: '用手机 B 站扫码，扫码后在手机上确认' });
    } catch (e) {
      setQrState({ status: 'error', message: errText(e) });
    }
  };

  useEffect(() => {
    if (!qrOpen || !qr) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await pollQrLogin(qr.key);
          if (!alive) return;
          setQrState(res);
          if (res.status === 'ok' && res.cookie) {
            const acc = persistQrLogin(res.cookie);
            if (!acc) {
              setQrState({ status: 'error', message: '登录成功但 cookie 解析失败，请重试' });
              return;
            }
            // 本地写入成功不代表 B 站认这段 Cookie：再问一次 nav，别把失效会话当已登录
            const check = await checkAccount(acc);
            if (!alive) return;
            if (!check.loggedIn) {
              clearAccount();
              setQrState({ status: 'error', message: 'B 站没有认可这次登录，请重新扫码' });
              return;
            }
            setAccount(acc);
            setQrOpen(false);
            setQr(null);
            onToast(`B 站登录成功${check.name ? `：${check.name}` : ''}，现在可以抓字幕了`, 'ok');
          }
          if (res.status === 'expired' || res.status === 'error') window.clearInterval(timer);
        } catch (e) {
          if (!alive) return;
          setQrState({ status: 'error', message: errText(e) });
          window.clearInterval(timer);
        }
      })();
    }, QR_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [qrOpen, qr, onToast]);

  /** 从视频笔记回来时带了 BV：同一门课不重拉，不同课才重新读取 */
  const didInitial = useRef(false);
  useEffect(() => {
    const bvid = initialBvid?.trim();
    if (!bvid || didInitial.current) return;
    didInitial.current = true;
    if (course?.view.bvid === bvid) return;
    setInput(bvid);
    void loadCourse(bvid);
    // 只在首次挂载时按 initialBvid 拉一次；loadCourse 每帧新建，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBvid]);

  const probe = async (): Promise<void> => {
    if (!course) return;
    if (!course.view.bvid) {
      setError('本地导入的课程没有 CC 字幕可抓，直接点「生成精华 / 生成讲义」即可。');
      return;
    }
    const rows = course.rows.filter((r) => r.picked);
    if (!rows.length) {
      setError('先勾选至少一个分P。');
      return;
    }
    setBusy('probe');
    setError('');
    let ok = 0;
    let empty = 0;
    let failed = 0;
    for (const [i, row] of rows.entries()) {
      patchRow(row.page, { phase: 'probing', error: undefined });
      setStatus(`抓字幕 ${i + 1}/${rows.length}：P${row.page} ${row.part}`);
      try {
        const tracks = await fetchSubtitleTracks(course.view.bvid, row.cid, account);
        const track = pickSubtitleTrack(tracks);
        if (!track) {
          empty += 1;
          patchRow(row.page, { phase: 'empty', transcript: undefined });
          continue;
        }
        const cues = await fetchSubtitleCues(track, account);
        if (subtitleOutOfRange(cues, row.duration)) {
          patchRow(row.page, {
            phase: 'error',
            error: `字幕跨度 ${Math.round(cues[cues.length - 1]?.end ?? 0)} 秒，超过视频时长 ${row.duration} 秒，疑似抓到了别的稿件`,
          });
          failed += 1;
          continue;
        }
        if (subtitleIncomplete(cues, row.duration)) {
          patchRow(row.page, {
            phase: 'error',
            error: `字幕只覆盖到 ${Math.round(cues[cues.length - 1]?.end ?? 0)} 秒（视频 ${row.duration} 秒），可能不完整`,
          });
          failed += 1;
          continue;
        }
        const transcript = cuesToTranscript(cues);
        if (!transcript) {
          empty += 1;
          patchRow(row.page, { phase: 'empty', lan: track.lanDoc || track.lan });
          continue;
        }
        ok += 1;
        patchRow(row.page, {
          phase: 'ready',
          lan: track.lanDoc || track.lan,
          transcript,
          chars: transcript.length,
        });
      } catch (e) {
        failed += 1;
        patchRow(row.page, { phase: 'error', error: errText(e) });
      }
    }
    setBusy(null);
    setStatus(
      `字幕抓取完成：${ok} 个分P可用${empty ? `，${empty} 个没有字幕` : ''}${failed ? `，${failed} 个失败` : ''}` +
        (ok ? '' : '。若是未登录，请先在「视频笔记」里粘贴一次 SESSDATA'),
    );
    if (!ok) {
      if (failed) {
        // 把第一条具体原因带进摘要，省得用户去列表里找红字
        const first = rows.map((r) => r.error).find(Boolean);
        setError(`部分分P字幕抓取失败：${first || '原因见分P列表'}。`);
        return;
      }
      if (!account) {
        setError('未登录 B 站：字幕清单需要登录态，先用上方「扫码登录」，或在「视频笔记」粘贴一次 SESSDATA。');
        return;
      }
      // 有登录记录但清单为空：先分辨「登录已失效」与「视频确实没字幕」
      const check = await checkAccount(account);
      if (!check.loggedIn) {
        // 本地这段 Cookie 已经不被 B 站认可：清掉，否则顶部会一直谎报「已登录」
        clearAccount();
        setAccount(null);
      }
      setError(
        check.loggedIn
          ? '该视频没有可用的 CC 字幕（登录态正常）。可以改用「导入字幕 / 文本」，或在下方填写网盘资料后继续。'
          : 'B 站登录态已失效（B 站不认这段 Cookie）。请点上方「扫码登录」重新登录，再回来抓字幕。',
      );
    }
  };

  const generate = async (): Promise<void> => {
    if (!course || !meta) return;
    if (!settings) {
      setError('还没配置 AI：先到「AI 助手 → 设置」填接口地址、密钥与模型名，再回来生成。');
      return;
    }
    if (!readyRows.length) {
      setError('还没有可用字幕：先抓字幕，或换几个有 CC 字幕的分P。');
      return;
    }
    const cfg = settings;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy('gen');
    setError('');

    /** 两条链路共用：调用模型并把增量节流刷到预览区 */
    const runOnce = async (messages: WireMessage[]): Promise<string> => {
      streamBuf.current = '';
      streamAt.current = 0;
      setStream('');
      const res = await runAgent({
        settings: cfg,
        messages,
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 2,
        signal: ctrl.signal,
        onDelta: (delta) => {
          streamBuf.current += delta;
          const now = Date.now();
          // 打字机节流：每 80ms 刷一次，避免长文本把渲染打满
          if (now - streamAt.current > 80) {
            streamAt.current = now;
            setStream(streamBuf.current);
          }
        },
      });
      return stripCodeFence(res.content);
    };

    try {
      if (mode === 'essence') {
        // 第一级：逐P删减成要点（已有要点就跳过，支持断点续跑）
        const digests: PartDigest[] = [];
        for (const [i, row] of readyRows.entries()) {
          if (row.digest) {
            digests.push({ page: row.page, part: row.part, digest: row.digest });
            continue;
          }
          setStatus(`压缩要点 ${i + 1}/${readyRows.length}：P${row.page} ${row.part}`);
          patchRow(row.page, { digestPhase: 'running' });
          const digest = await runOnce(
            buildDigestMessages({ meta, page: row.page, part: row.part, transcript: row.transcript || '' }),
          );
          patchRow(row.page, { digest, digestPhase: 'done' });
          digests.push({ page: row.page, part: row.part, digest });
        }
        if (!digests.length) throw new Error('没有可压缩的字幕要点');
        // 第二级：跨P去重合并成一页复习卡
        setStatus('合并成一页精华…');
        const merged = await runOnce(buildEssenceMessages({ meta, digests }));
        setEssence(merged);
        setStatus(`精华已生成：${digests.length} 个分P合并为一页，记得保存`);
      } else {
        const targets = readyRows.filter((r) => r.notePhase !== 'done');
        if (!targets.length) throw new Error('没有待生成的分P：先抓字幕，或换几个有字幕的分P。');
        for (const [i, row] of targets.entries()) {
          patchRow(row.page, { notePhase: 'running', noteError: undefined });
          const chunks = splitTranscript(row.transcript || '');
          const bodies: string[] = [];
          for (const [ci, chunk] of chunks.entries()) {
            setStatus(
              `生成讲义 ${i + 1}/${targets.length}：P${row.page} ${row.part}${chunks.length > 1 ? `（${ci + 1}/${chunks.length} 段）` : ''}`,
            );
            bodies.push(
              await runOnce(
                buildLectureMessages({
                  meta,
                  page: row.page,
                  part: row.part,
                  duration: row.duration,
                  transcript: chunk,
                  chunkIndex: ci + 1,
                  chunkCount: chunks.length,
                }),
              ),
            );
          }
          patchRow(row.page, { note: bodies.join('\n\n'), notePhase: 'done' });
        }
        setStatus(`讲义已生成：${targets.length} 个分P，记得保存到笔记库`);
      }
    } catch (e) {
      if (isAbortError(e)) {
        setStatus('已停止生成，已完成的部分仍可保存');
      } else {
        setError(`生成失败：${errText(e)}`);
      }
    } finally {
      setBusy(null);
      setStream('');
      abortRef.current = null;
      // 把仍然标着 running 的行复位，避免界面一直转圈
      setCourse((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) =>
                r.digestPhase === 'running'
                  ? { ...r, digestPhase: 'idle' as const }
                  : r.notePhase === 'running'
                    ? { ...r, notePhase: 'idle' as const }
                    : r,
              ),
            }
          : prev,
      );
    }
  };

  const stop = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
    setStream('');
    setStatus('已停止生成，已完成的讲次仍可保存');
  };

  const saveNote = async (): Promise<void> => {
    if (!assembled || !noteTitle.trim()) return;
    // 本地导入的课程落到「课程笔记」，和 B 站课程分开
    const dir = isLocal ? LOCAL_COURSE_DIR : COURSE_DIR;
    const path = courseNotePath(noteTitle, dir);
    try {
      if (docs.has(path)) {
        const yes = await confirmBox({
          title: '覆盖同名笔记？',
          detail: `${path}\n\n整篇内容会被本次生成的讲义替换。`,
          danger: true,
          okText: '覆盖',
        });
        if (!yes) return;
        await onSave(path, assembled);
      } else {
        await createNote(dir, safeTitle(noteTitle), assembled);
      }
      onToast(`课程笔记已保存：${path}`, 'ok');
      onOpenNote(path);
      onClose();
    } catch (e) {
      setError(`保存失败：${errText(e)}`);
    }
  };

  const makePersona = async (): Promise<void> => {
    if (!meta) return;
    if (!settings) {
      setError('还没配置 AI：先到「AI 助手 → 设置」填接口地址与模型名。');
      return;
    }
    // 精华只有结论，人格的「语言风格」层需要一点原话来支撑（只取每P开头，避免爆预算）
    const raw = picked.map((r) => (r.transcript ?? '').slice(0, 1_500)).join('\n\n');
    const evidence = (assembled || raw).slice(0, 8_000);
    const styleSample = raw.slice(0, 5_000);
    if (evidence.trim().length < 200) {
      setError('证据太少：先生成至少一个分P的讲义，再蒸人格。');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy('persona');
    setError('');
    setStatus('正在归纳讲师人格…');
    try {
      const res = await runAgent({
        settings,
        messages: buildPersonaMessages({ meta, evidence, styleSample }),
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 2,
        signal: ctrl.signal,
      });
      setPersona(stripCodeFence(res.content));
      setStatus('人格卡已生成，确认无误后保存');
    } catch (e) {
      setError(`人格卡生成失败：${errText(e)}`);
      setStatus('');
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const savePersona = async (): Promise<void> => {
    const name = safeTitle(personaName || meta?.owner || '讲师');
    if (!persona.trim()) return;
    const path = personaPath(name);
    const others = [...docs.keys()].filter((p) => p.startsWith('AI命令/人格/') && p.endsWith('.md') && p !== path);
    try {
      if (docs.has(path)) {
        const yes = await confirmBox({
          title: '覆盖同名人格卡？',
          detail: path,
          danger: true,
          okText: '覆盖',
        });
        if (!yes) return;
        await onSave(path, buildPersonaCard(name, persona, meta ?? undefined));
      } else {
        if (others.length) {
          const yes = await confirmBox({
            title: '已有其他人格卡',
            detail: `「AI命令/人格/」里已有 ${others.length} 张卡（${others[0]} 等）。AI 面板只注入排序第一张；新卡可能不会生效。`,
            okText: '仍然保存',
          });
          if (!yes) return;
        }
        await createNote('AI命令/人格', `${name}-perspective`, buildPersonaCard(name, persona, meta ?? undefined));
      }
      onToast(`人格卡已保存：${path}`, 'ok');
      onClose();
    } catch (e) {
      setError(`人格卡保存失败：${errText(e)}`);
    }
  };

  const statusLine =
    stream || status || (course
        ? isLocal
          ? '本地导入 → 生成精华 / 讲义'
          : mode === 'essence'
            ? '抓字幕 → 生成精华（一页复习卡）'
            : '抓字幕 → 生成讲义（按分P）'
        : '粘贴课程链接或 BV 号，或导入本地字幕/文本');

  return (
    <PanelOverlay tone="plain" onClose={onClose}>
      <div className="panel panel--full cw-panel" aria-label="课程工坊">
        <div className="panel__head cw-head">
          <span className="panel__title">课程工坊</span>
          <span className="cw-head__meta" aria-live="polite">
            {statusLine.length > 90 ? `${statusLine.slice(0, 90)}…` : statusLine}
          </span>
          <div className="panel__actions">
            {busy === 'gen' && (
              <button type="button" className="btn-small" onClick={stop} title="停止生成，已完成的讲次保留">
                停止
              </button>
            )}
            <button
              type="button"
              className="btn-small"
              onClick={() => void probe()}
              disabled={!course?.view.bvid || busy !== null || picked.length === 0}
              title={isLocal ? '本地导入的课程没有 CC 字幕' : '读取所选分P的 CC 字幕（需要 B 站登录态）'}
            >
              抓字幕
            </button>
            <button
              type="button"
              className="btn-small btn-primary"
              onClick={() => void generate()}
              disabled={!meta || busy !== null || readyRows.length === 0}
              title="用已抓到的字幕生成内容（走 AI 助手同一份配置）"
            >
              {mode === 'essence' ? '生成精华' : '生成讲义'}
            </button>
            <button
              type="button"
              className="btn-small"
              onClick={() => void saveNote()}
              disabled={!canSave}
              title="把生成的内容存进笔记库"
            >
              保存笔记
            </button>
            <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭课程工坊">
              ✕
            </button>
          </div>
        </div>

        <div className="cw-body">
          <section className="cw-col cw-col--left" aria-label="课程与分P">
            <div className="cw-card">
              <label className="cw-field">
                <span className="cw-field__label">B 站课程链接或 BV 号</span>
                <input
                  className="cw-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && busy === null) void loadCourse();
                  }}
                  placeholder="https://www.bilibili.com/video/BV…"
                  spellCheck={false}
                />
              </label>
              <div className="cw-row">
                <button
                  type="button"
                  className="btn-small btn-primary"
                  onClick={() => void loadCourse()}
                  disabled={busy !== null || !input.trim()}
                >
                  读取课程
                </button>
                <button type="button" className="btn-small" onClick={() => fileRef.current?.click()}>
                  导入字幕 / 文本
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".srt,.vtt,.txt,.md,.markdown,.json"
                  className="cw-file"
                  aria-label="导入字幕或文本文件"
                  onChange={(e) => {
                    const el = e.currentTarget;
                    void importFiles(el.files);
                    el.value = '';
                  }}
                />
                <span className="cw-chip" data-state={account ? 'ok' : 'warn'}>
                  {account ? 'B 站已登录' : '未登录 B 站'}
                </span>
                {!account && (
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => void beginQr()}
                    disabled={busy !== null}
                    title="用手机 B 站扫码，成功后自动保存登录态"
                  >
                    扫码登录
                  </button>
                )}
                <span className="cw-chip" data-state={settings ? 'ok' : 'warn'}>
                  {settings ? `AI：${settings.model}` : 'AI 未配置'}
                </span>
              </div>
              <p className="cw-hint">
                导入支持 .srt / .vtt / .txt / .md / B 站字幕 .json：不上传、不联网，文件只在本机读成文本。
              </p>
              {qrOpen && (
                <div className="cw-qr">
                  <div className="cw-qr__code">
                    {qr ? <QrSvg text={qr.url} /> : <span className="cw-hint">二维码加载中…</span>}
                  </div>
                  <div className="cw-qr__side">
                    <p className="cw-hint" data-state={qrState.status}>
                      {qrState.message || '正在获取二维码…'}
                    </p>
                    <div className="cw-row">
                      <button type="button" className="btn-small" onClick={() => void beginQr()}>
                        刷新二维码
                      </button>
                      <button
                        type="button"
                        className="btn-small"
                        onClick={() => {
                          setQrOpen(false);
                          setQr(null);
                        }}
                      >
                        收起
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <div className="cw-field">
                <label className="cw-field__label" htmlFor="cw-material-url">
                  网盘 / 资料链接（可选）
                </label>
                <input
                  id="cw-material-url"
                  className="cw-input"
                  value={materialUrl}
                  onChange={(e) => setMaterialUrl(e.target.value)}
                  placeholder="https://pan.baidu.com/s/…"
                  spellCheck={false}
                />
              </div>
              {materialLink ? (
                <div className="cw-row">
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => window.open(materialLink, '_blank', 'noopener,noreferrer')}
                  >
                    打开网盘
                  </button>
                  <span className="cw-hint cw-hint--inline">
                    整门课一份资料；只记进笔记并打开原页，不下载视频、不抓字幕。
                  </span>
                </div>
              ) : materialUrl.trim() ? (
                <p className="cw-hint cw-hint--warn">链接要以 http(s):// 开头，否则不会写进笔记。</p>
              ) : (
                <p className="cw-hint">网盘分享页要登录与提取码，这里只记录链接并一键打开。</p>
              )}
              <label className="cw-field">
                <span className="cw-field__label">生成方式</span>
                <select
                  className="cw-input cw-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as NoteMode)}
                  aria-label="生成方式"
                >
                  <option value="essence">精华 · 一页复习卡（默认）</option>
                  <option value="lecture">完整讲义 · 按分P展开</option>
                </select>
              </label>
              {!account && (
                <div className="cw-row">
                  <p className="cw-hint">
                    字幕清单多为登录后可见：先去「视频笔记」粘贴一次 SESSDATA，再回来抓字幕。
                  </p>
                  {loginBvid && onOpenVideo && (
                    <button
                      className="btn-small"
                      type="button"
                      onClick={() =>
                        onOpenVideo({
                          bvid: loginBvid,
                          page: 1,
                          ...(course?.view.parts[0]?.part ? { part: course.view.parts[0].part } : {}),
                          ...(course?.view.title ? { courseTitle: course.view.title } : {}),
                        })
                      }
                    >
                      去视频笔记登录
                    </button>
                  )}
                </div>
              )}
              {!settings && (
                <p className="cw-hint">
                  AI 未配置：打开「AI 助手 → 设置」填接口地址与模型名后，才能生成精华与人格卡。
                </p>
              )}
              {!course && (
                <p className="cw-hint">
                  先点「读取课程」；读取成功后，顶部的「抓字幕」「生成精华」才会启用。
                </p>
              )}
            </div>

            {course && (
              <div className="cw-card cw-card--grow">
                <div className="cw-course">
                  <h2 className="cw-course__title" title={course.view.title}>
                    {course.view.title}
                  </h2>
                  <p className="cw-course__meta">
                    {course.view.owner || '未知 UP 主'} · {course.view.parts.length} 个分P ·{' '}
                    {formatTime(course.view.duration)}
                  </p>
                  <div className="cw-row">
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() =>
                        setCourse((prev) =>
                          prev ? { ...prev, rows: prev.rows.map((r) => ({ ...r, picked: true })) } : prev,
                        )
                      }
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() =>
                        setCourse((prev) =>
                          prev ? { ...prev, rows: prev.rows.map((r) => ({ ...r, picked: false })) } : prev,
                        )
                      }
                    >
                      全不选
                    </button>
                    <span className="cw-hint cw-hint--inline">
                      已选 {picked.length} 段 · 可用字幕 {readyRows.length} 段
                    </span>
                  </div>
                </div>

                <ul className="cw-parts">
                  {course.rows.map((row) => (
                    <li key={row.page}>
                      <div className="cw-part-row">
                        <label className="cw-part" data-state={row.phase}>
                          <input
                            type="checkbox"
                            checked={row.picked}
                            onChange={(e) => patchRow(row.page, { picked: e.target.checked })}
                            aria-label={`选择 P${row.page} ${row.part}`}
                          />
                          <span className="cw-part__page">P{row.page}</span>
                          <span className="cw-part__title" title={row.part}>
                            {row.part}
                          </span>
                          <span className="cw-part__state">
                            {row.phase === 'probing' && '抓取中…'}
                            {row.phase === 'ready' && `${row.lan || '字幕'} · ${row.chars ?? 0} 字`}
                            {row.phase === 'empty' && '无字幕'}
                            {row.phase === 'error' && (row.error ? '失败（见下方原因）' : '失败')}
                            {row.digestPhase === 'running' && ' · 提炼中'}
                            {row.digestPhase === 'done' && mode === 'essence' && ' · 已提炼'}
                            {row.notePhase === 'running' && ' · 生成中'}
                            {row.notePhase === 'done' && ' · 已生成'}
                            {row.notePhase === 'error' && ' · 生成失败'}
                          </span>
                        </label>
                        {!isLocal && onOpenVideo && row.transcript && (
                          <button
                            className="cw-part__sub"
                            type="button"
                            aria-label={`查看 P${row.page} 字幕`}
                            aria-expanded={transcriptPage === row.page}
                            title="看这一节的字幕，点时间点去视频笔记"
                            onClick={() =>
                              setTranscriptPage((cur) => (cur === row.page ? null : row.page))
                            }
                          >
                            字幕
                          </button>
                        )}
                        {!isLocal && onOpenVideo && (
                          <button
                            className="cw-part__play"
                            type="button"
                            aria-label={`播放 P${row.page} ${row.part}`}
                            title="在视频笔记里打开这个分P"
                            onClick={() =>
                              onOpenVideo({
                                bvid: course.view.bvid,
                                page: row.page,
                                part: row.part,
                                courseTitle: course.view.title,
                              })
                            }
                          >
                            ▶
                          </button>
                        )}
                      </div>
                      {!isLocal && transcriptPage === row.page && row.transcript && onOpenVideo && (
                        <div className="cw-transcript" aria-label={`P${row.page} 字幕`}>
                          <div className="cw-transcript__head">
                            <span>P{row.page} 字幕 · 点时间点去视频笔记</span>
                            <button className="btn-small" type="button" onClick={() => setTranscriptPage(null)}>
                              收起
                            </button>
                          </div>
                          <div className="cw-transcript__body">
                            {transcriptLines(row.transcript).map((line, i) => (
                              <button
                                key={`${row.page}-${line.stamp}-${i}`}
                                className="cw-transcript__line"
                                type="button"
                                onClick={() =>
                                  onOpenVideo({
                                    bvid: course.view.bvid,
                                    page: row.page,
                                    part: row.part,
                                    courseTitle: course.view.title,
                                    seconds: line.seconds,
                                  })
                                }
                              >
                                <span className="cw-transcript__time">{line.stamp}</span>
                                <span>{line.text}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {row.phase === 'error' && row.error && (
                        <p className="cw-hint cw-hint--warn">{row.error}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="cw-col cw-col--right" aria-label="讲义与人格">
            <div className="cw-card cw-card--grow">
              <label className="cw-field">
                <span className="cw-field__label">笔记标题（保存为「B站课程/标题.md」）</span>
                <input
                  className="cw-input"
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="课程名"
                  spellCheck={false}
                />
              </label>
              <div className="cw-preview" aria-live="off">
                {stream || (assembled && doneRows.length ? assembled : '') || (
                  <span className="cw-preview__empty">
                    {mode === 'essence'
                      ? '生成后这里只显示一页精华：一句话总结、核心概念、机制与步骤、易错与考点、自测；不会贴字幕。'
                      : '生成后的讲义会显示在这里。它只使用 B 站已有的 CC 字幕；没有字幕的分P会写进文末的「未收录」。'}
                  </span>
                )}
              </div>
              {essenceAudit && !essenceAudit.ok && (
                <p className="cw-hint cw-hint--warn">
                  自检：{essenceAudit.issues.join('；')}。可以重生成，或直接改下面的预览再保存。
                </p>
              )}
            </div>

            <div className="cw-card">
              <div className="cw-row cw-row--between">
                <span className="cw-field__label">讲师人格卡</span>
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => void makePersona()}
                  disabled={busy !== null || !meta || (mode === 'essence' ? !essence : doneRows.length === 0)}
                  title="根据已生成的讲义归纳讲解方式（不猜生平）"
                >
                  蒸人格
                </button>
              </div>
              <label className="cw-field">
                <span className="cw-field__label">人格名（写进 frontmatter 的 persona）</span>
                <input
                  className="cw-input"
                  value={personaName}
                  onChange={(e) => setPersonaName(e.target.value)}
                  placeholder="讲师名"
                  spellCheck={false}
                />
              </label>
              <textarea
                className="cw-textarea"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                placeholder="生成后可在这里改。它只影响表达方式，不写具体知识点。"
                rows={6}
                aria-label="讲师人格卡正文"
                spellCheck={false}
              />
              <div className="cw-row cw-row--between">
                <span className="cw-hint cw-hint--inline">
                  {persona.length} 字 · AI 面板只注入排序第一张人格卡
                </span>
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => void savePersona()}
                  disabled={!persona.trim() || busy !== null}
                >
                  保存人格卡
                </button>
              </div>
            </div>
          </section>
        </div>

        {error && (
          <div className="cw-error" role="alert">
            {error}
            <button type="button" className="btn-icon" onClick={() => setError('')} aria-label="关闭错误提示">
              ✕
            </button>
          </div>
        )}
      </div>
    </PanelOverlay>
  );
}
