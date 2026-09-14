/**
 * ③ PDF 讲义对照视图：左 PDF 原文（react-pdf-viewer，自带高 DPI/文本层/缩放/适应宽度/翻页），
 *    右智能草稿 + 摘录历史。划选重点 → ✨生成草稿（noteGen 规则引擎）→ 审核 → 入库。
 */
import {
  useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Viewer, Worker } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { renderAsync } from 'docx-preview';
import { detectScannedPdf, saveLastPdf, getLastPdf } from '../core/pdfLib';
import { toast } from '../core/feedback';
import { generateDraft, draftToMarkdown, type Draft } from '../core/noteGen';
import { normalizePdfSelection } from '../core/pdfText';
import {
  beginGeometrySelection, clearHighlights, endGeometrySelection, selectByGeometry,
} from '../core/pdfCharSelect';
import { IconPlus } from './icons';

/** 静态资源根：base './' 时构建产物为 './'，GitHub Pages 子路径也能正确加载 */
const BASE = import.meta.env.BASE_URL;

interface Props {
  onSave: (dir: string, title: string, content: string) => Promise<string>;
  onAppend: (path: string, excerpt: string) => Promise<string>;
  noteTargets: Array<{ path: string; title: string; chapter: string }>;
  onClose: () => void;
}

interface Excerpt {
  id: string;
  ts: number;
  text: string;
  page: number;
  file: string;
  title: string;
  body: string;
  chapter: string;
  source: string;
  savedPath?: string;
}

const EX_KEY = 'medvault-excerpts';
const loadExcerpts = (): Excerpt[] => {
  try { return JSON.parse(localStorage.getItem(EX_KEY) ?? '[]') as Excerpt[]; } catch { return []; }
};
const saveExcerpts = (list: Excerpt[]) => {
  try {
    localStorage.setItem(EX_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded: retry with truncated bodies, then give up quietly.
    try {
      const slim = list.map((x) => ({ ...x, body: x.body.slice(0, 2000) }));
      localStorage.setItem(EX_KEY, JSON.stringify(slim));
    } catch { /* keep the in-memory list usable */ }
  }
};

/** 划选自动成稿开关（默认关：选中后先问要不要成稿，不再自动写入右侧） */
const AUTODRAFT_KEY = 'medvault-pdf-autodraft';
/** 几何选区开关（默认开：原生划选在绝对定位的文字层上向下拖会把整页框进选区、反复闪烁） */
const GEOMSEL_KEY = 'medvault-pdf-geomsel';
/** Column mode (default off): middle lines stay inside the drag x band. */
const COLMODE_KEY = 'medvault-pdf-colmode';

export default function PdfSplitView({ onSave, onAppend, noteTargets, onClose }: Props) {
  const defaultLayoutPluginInstance = useRef(defaultLayoutPlugin()).current;
  const [doc, setDoc] = useState<{ data: Uint8Array; name: string } | null>(null);
  const [docType, setDocType] = useState<'pdf' | 'docx' | null>(null);
  const [docBuf, setDocBuf] = useState<ArrayBuffer | null>(null); // docx → 源 buffer（docx-preview 渲染）
  const [fileName, setFileName] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ text: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'draft' | 'history'>('draft');
  const [excerpts, setExcerpts] = useState<Excerpt[]>(loadExcerpts);
  const [savedMsg, setSavedMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [currentExcerptIds, setCurrentExcerptIds] = useState<string[]>([]);
  const [autoDraft, setAutoDraft] = useState(() => localStorage.getItem(AUTODRAFT_KEY) === '1');
  const [geomSel, setGeomSel] = useState(() => localStorage.getItem(GEOMSEL_KEY) !== '0');
  const [colMode, setColMode] = useState(() => localStorage.getItem(COLMODE_KEY) === '1');
  const [scanned, setScanned] = useState(false);

  const paneRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const docRenderRef = useRef<HTMLDivElement>(null); // docx 渲染容器
  /** 最后一次划选的原文（供「重新生成」用） */
  const lastSelRef = useRef('');
  /** 划选→自动生成草稿 的去抖定时器（仅在开启「自动成稿」时使用） */
  const autoGenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 「按行选取」模式下 pointerdown 的锚点 */
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  /** rAF throttle for geometry selection during pointermove */
  const rafRef = useRef<number | null>(null);
  const movePointRef = useRef<{ x: number; y: number } | null>(null);
  /** savedMsg auto-clear timer (cleared on unmount) */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Clear pending timers on unmount so they cannot fire after the view closes.
  useEffect(() => () => {
    if (autoGenTimer.current) clearTimeout(autoGenTimer.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    const raf = rafRef.current;
    if (typeof raf === 'number') cancelAnimationFrame(raf);
  }, []);

  // 划选弹层出现时，Enter / Alt+V = 粘贴到右侧，省去鼠标移到弹层
  useEffect(() => {
    if (!selected) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // 正在输入时不抢键
      if (e.key === 'Enter' || (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyV')) {
        e.preventDefault();
        pasteToRight(selected.text);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // 打开文档：按扩展名分流 PDF / Word / PPT（都可选中文字生成草稿）
  const openDoc = async (name: string, source: File | ArrayBuffer) => {
    setBusy(true);
    try {
      const buf = source instanceof File ? await source.arrayBuffer() : source;
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (ext === 'docx') {
        // 用 docx-preview 渲染原始版式（保留段落/表格/图片/分页，可划选）
        setDoc(null); setDocType('docx'); setDocBuf(buf);
      } else {
        setDoc({ data: new Uint8Array(buf), name });
        setDocType('pdf'); setDocBuf(null);
        setPage(1);
        setSelected(null);
        setScanned(false);
        endGeometrySelection();
        clearHighlights(paneRef.current);
        // 几何选区回到用户偏好（默认开）；扫描件随后强制开启
        setGeomSel(localStorage.getItem(GEOMSEL_KEY) !== '0');
        if (source instanceof File) void saveLastPdf(name, buf);
        // 采样前几页文字层判断扫描件；必须传副本，pdf.js 会 detach 传入的 ArrayBuffer
        void detectScannedPdf(buf.slice(0)).then((isScanned) => {
          setScanned(isScanned);
          if (isScanned) setGeomSel(true);
        });
      }
      setFileName(name);
    } catch (e) {
      toast(`文档打开失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  // 启动时恢复上次的 PDF
  useEffect(() => {
    void (async () => {
      const last = await getLastPdf();
      if (last) await openDoc(last.name, last.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // docx：用 docx-preview 渲染原始 Word 版式（保留段落/表格/图片/分页，可划选）
  useEffect(() => {
    if (docType !== 'docx' || !docBuf || !docRenderRef.current) return;
    docRenderRef.current.innerHTML = '';
    void renderAsync(docBuf, docRenderRef.current, undefined, {
      inWrapper: true,
      breakPages: true,
      ignoreWidth: false,
    }).catch((e) => console.error('docx 渲染失败：', e));
  }, [docType, docBuf]);

  /** 清掉选区反馈：自绘高亮 + 原生选区 */
  const clearPdfSelection = () => {
    clearHighlights(paneRef.current);
    window.getSelection()?.removeAllRanges();
  };

  /** 划选完成 → 弹层给出「粘贴到右侧」入口；坐标钳制在视口内，避免贴边溢出 */
  const handleSelection = (raw: string, x: number, y: number) => {
    const txt = normalizePdfSelection(raw);
    if (txt.length < 4) { setSelected(null); return; }
    const clampX = Math.min(Math.max(x, 170), window.innerWidth - 170);
    const clampY = Math.min(Math.max(y - 46, 12), window.innerHeight - 60);
    setSelected({ text: txt, x: clampX, y: clampY });
    lastSelRef.current = txt;
    if (autoDraft) {
      // 只有用户主动开启「自动粘贴」时才去抖自动写入右栏
      if (autoGenTimer.current) clearTimeout(autoGenTimer.current);
      autoGenTimer.current = setTimeout(() => pasteToRight(txt), 320);
    }
  };

  /** 原生划选（几何选区关闭时）：读取浏览器选区 */
  const onMouseUp = (e: ReactMouseEvent) => {
    if (geomSel) return; // 几何选区模式下走下面的 pointer 自绘选区
    if ((e.target as HTMLElement).closest('.pdf-popover')) return;
    const sel = window.getSelection();
    const txt = normalizePdfSelection(sel?.toString() ?? '');
    if (!sel || sel.isCollapsed || txt.length < 4) { setSelected(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    handleSelection(txt, rect.left + rect.width / 2, rect.top);
  };

  // ---- 几何选区：按屏幕几何位置自己算选区，绕开文字层 DOM 顺序 ----
  const onPanePointerDown = (e: ReactPointerEvent) => {
    if (!geomSel || e.pointerType !== 'mouse') return;
    if (!(e.target as HTMLElement).closest('.rpv-core__text-layer')) return;
    clearPdfSelection();
    setSelected(null);
    beginGeometrySelection(paneRef.current);
    anchorRef.current = { x: e.clientX, y: e.clientY };
    // 捕获指针：拖出左栏松开也能收到 pointerup，避免高亮卡在半选状态
    try { paneRef.current?.setPointerCapture(e.pointerId); } catch { /* 指针已失效则忽略 */ }
  };
  const onPanePointerMove = (e: ReactPointerEvent) => {
    if (!geomSel || e.pointerType !== 'mouse' || !anchorRef.current || e.buttons === 0) return;
    movePointRef.current = { x: e.clientX, y: e.clientY };
    if (typeof rafRef.current === 'number') return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pane = paneRef.current;
      const point = movePointRef.current;
      const anchor = anchorRef.current;
      if (pane && point && anchor) selectByGeometry(pane, anchor, point, { columnMode: colMode });
    });
  };
  const onPanePointerUp = (e: ReactPointerEvent) => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!geomSel || !anchor) return;
    const pane = paneRef.current;
    if (!pane) return;
    const raf = rafRef.current;
    if (typeof raf === 'number') { cancelAnimationFrame(raf); rafRef.current = null; }
    const txt = selectByGeometry(pane, anchor, { x: e.clientX, y: e.clientY }, { columnMode: colMode });
    endGeometrySelection();
    handleSelection(txt, e.clientX, e.clientY);
  };

  /** 粘贴到右侧：选中段落的原文直接追加进右栏草稿正文。
   *  不走 noteGen 生成标题/章节，不记摘录历史——攒多段后选目标笔记一次追加，
   *  避免每段划选都单独形成一份笔记。 */
  const pasteToRight = (text?: string) => {
    const txt = normalizePdfSelection(text ?? selected?.text ?? '');
    if (!txt) return;
    const source = `PDF《${fileName ?? '未命名'}》第 ${page} 页`;
    setDraft((prev) =>
      prev
        ? { ...prev, body: `${prev.body.trimEnd()}\n\n${txt}` }
        : { title: '', chapter: '', source, tags: [], body: txt },
    );
    setTab('draft');
    setSelected(null);
    clearPdfSelection();
  };

  /** 生成原文摘录（可传入文本：划选或粘贴；PDF 对照不做语义分类） */
  const genDraft = (text?: string, replace = false) => {
    const src = normalizePdfSelection(text ?? selected?.text ?? '');
    if (!src) return;
    const source = `PDF《${fileName ?? '未命名'}》第 ${page} 页`;
    const d = generateDraft(src, { source, format: 'excerpt' });
    const excerptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (draft && !replace) {
      setDraft({ ...draft, body: `${draft.body.trimEnd()}\n\n${d.body}` });
      setCurrentExcerptIds((ids) => [...ids, excerptId]);
    } else {
      setDraft(d);
      setCurrentExcerptIds([excerptId]);
    }
    setTab('draft');
    const item: Excerpt = {
      id: excerptId, ts: Date.now(),
      text: src.slice(0, 300), page, file: fileName ?? '',
      title: d.title, body: d.body, chapter: d.chapter, source,
    };
    setExcerpts((prev) => {
      // Dedupe by content + file + page; keep the newest copy at the front.
      const same = (x: Excerpt) => x.text === item.text && x.file === item.file && x.page === item.page;
      const rest = prev.filter((x) => same(x) === false);
      const next = [item, ...rest].slice(0, 50);
      saveExcerpts(next);
      return next;
    });
    setSelected(null);
    setPasteText('');
    clearPdfSelection();
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    // 未选目标笔记且没填标题时，入库会产生「.md」这种坏路径，挡下并提示
    if (!targetPath && !draft.title.trim()) {
      toast('先选择目标笔记追加，或填写标题后入库', 'err');
      return;
    }
    setSaving(true);
    try {
      const path = targetPath
        ? await onAppend(targetPath, draft.body)
        : await onSave(draft.chapter.trim(), draft.title.trim(), draftToMarkdown(draft));
      setSavedMsg(targetPath ? `已追加到：${path}` : `已入库：${path}`);
      setExcerpts((prev) => {
        const next = prev.map((x) =>
          currentExcerptIds.includes(x.id) ? { ...x, savedPath: path } : x
        );
        saveExcerpts(next);
        return next;
      });
      if (!targetPath) setTargetPath(path);
      setDraft(null);
      setCurrentExcerptIds([]);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedMsg(''), 4000);
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const openExcerpt = (x: Excerpt) => {
    setDraft({ title: x.title, chapter: x.chapter, source: x.source, tags: [], body: x.body });
    setCurrentExcerptIds([x.id]);
    if (x.savedPath) setTargetPath(x.savedPath);
    setTab('draft');
  };
  const clearExcerpts = () => {
    setExcerpts([]);
    saveExcerpts([]);
  };

  const exportExcerpts = () => {
    try {
      const blob = new Blob([JSON.stringify(excerpts, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'medvault-excerpts.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const removeExcerpt = (id: string) => {
    setExcerpts((prev) => { const next = prev.filter((x) => x.id !== id); saveExcerpts(next); return next; });
  };

  return (
    <div className="panel panel--full pdf-overlay">
      <div className="panel__head pdf-topbar">
        <button className="btn-small" onClick={onClose}>← 退出对照</button>
        <span className="pdf-file">{fileName ?? '未选择 PDF'}</span>
        <span className="spacer" />
        <label className="pdf-toggle" title="选中文字后自动粘贴到右栏草稿；默认关闭，选中后点「粘贴到右侧」">
          <input
            type="checkbox"
            checked={autoDraft}
            onChange={(e) => {
              setAutoDraft(e.target.checked);
              if (e.target.checked === false && autoGenTimer.current) {
                clearTimeout(autoGenTimer.current);
                autoGenTimer.current = null;
              }
              localStorage.setItem(AUTODRAFT_KEY, e.target.checked ? '1' : '0');
            }}
          />
          自动粘贴
        </label>
        <label className="pdf-toggle" title="按视觉位置自绘选区（推荐）：文字层 DOM 顺序与视觉顺序不一致时，原生划选会整页闪烁、跨行跳选；关闭则用浏览器原生划选">
          <input
            type="checkbox"
            checked={geomSel}
            onChange={(e) => {
              setGeomSel(e.target.checked);
              localStorage.setItem(GEOMSEL_KEY, e.target.checked ? '1' : '0');
              if (!e.target.checked) {
                // 切回原生划选时清掉残留的自绘高亮
                clearHighlights(paneRef.current);
              }
              setSelected(null);
            }}
          />
          几何选区
        </label>
        <label className="pdf-toggle" title="2-column PDF: keep each line inside the drag x range">
          <input
            type="checkbox"
            checked={colMode}
            onChange={(e) => {
              setColMode(e.target.checked);
              localStorage.setItem(COLMODE_KEY, e.target.checked ? '1' : '0');
              setSelected(null);
            }}
          />
          双栏模式
        </label>
        <button className="btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '打开中…' : '选择 PDF / Word'}
        </button>
        <input
          ref={fileRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openDoc(f.name, f); e.target.value = ''; }}
        />
        <button
          className="btn-small" disabled={busy}
          onClick={async () => {
            try {
              const buf = await fetch(`${BASE}sample-lecture.pdf`).then((r) => r.arrayBuffer());
              await openDoc('sample-lecture.pdf', buf);
            } catch (e) { toast((e as Error).message, 'err'); }
          }}
        >
          载入示例
        </button>
      </div>

      <div className="pdf-ocr-tip">
        {scanned
          ? '这个 PDF 几乎没有文字层（扫描件）：已自动用「几何选区」按视觉位置精确选字。选好后按 Enter 或点「粘贴到右侧」，原文会直接粘进右栏。'
          : '划选文字后按 Enter（或 Alt+V）直接把原文粘进右栏草稿，攒多段后选目标笔记一次追加（不会每段单独成笔记）。默认「几何选区」按视觉位置选字，拖动不会整页闪烁/跳行；选字如需浏览器原生划选可关闭。'}
      </div>

      <div className="panel__body pdf-split">
        {/* 左：文档原文（PDF→react-pdf-viewer；Word→mammoth HTML；PPT→每页文本，都支持划选） */}
        <div
          className={`pdf-pane${geomSel ? ' pdf-line-mode' : ''}`}
          ref={paneRef}
          onPointerDown={onPanePointerDown}
          onPointerMove={onPanePointerMove}
          onPointerUp={onPanePointerUp}
          onMouseUp={onMouseUp}
        >
          {docType === 'pdf' && doc && (
            <div className="pdf-viewer-host">
              <Worker workerUrl={workerUrl}>
                <Viewer
                  fileUrl={doc.data}
                  plugins={[defaultLayoutPluginInstance]}
                  onPageChange={(e) => { setPage(e.currentPage + 1); endGeometrySelection();
                    clearHighlights(paneRef.current); setSelected(null); }}
                />
              </Worker>
            </div>
          )}
          {docType === 'docx' && docBuf && (
            <div className="pdf-doc-scroll"><div ref={docRenderRef} className="pdf-doc-render" /></div>
          )}
          {!docType && (
            <div className="pdf-empty">
              <p>选择 PDF / Word 开始对照阅读</p>
              <p className="muted">Word 会还原原版排版；PDF 渲染原版页面。划选重点即可粘贴到右侧</p>
              <button className="btn-small" onClick={() => fileRef.current?.click()}>📄 选择 PDF / Word</button>
              <button
                className="btn-small"
                onClick={async () => {
                  try {
                    const buf = await fetch(`${BASE}sample-lecture.pdf`).then((r) => r.arrayBuffer());
                    await openDoc('sample-lecture.pdf', buf);
                  } catch (e) { toast((e as Error).message, 'err'); }
                }}
              >载入示例</button>
            </div>
          )}
          {selected && (
            <div className="pdf-popover" style={{ left: selected.x, top: selected.y }}>
              <span className="pdf-popover-btn" onClick={() => pasteToRight(selected.text)}>
                <IconPlus /> 粘贴到右侧 <kbd>⏎</kbd>
              </span>
              <span
                className="pdf-popover-btn"
                onClick={() => { void navigator.clipboard.writeText(selected.text); setSelected(null); }}
              >
                仅复制
              </span>
              <span
                className="pdf-popover-btn"
                onClick={() => { setSelected(null); clearPdfSelection(); }}
              >
                取消
              </span>
            </div>
          )}
        </div>

        {/* 右：草稿 / 摘录历史 */}
        <div className="pdf-right">
          <div className="pdf-tabs">
            <button className={`pdf-tab ${tab === 'draft' ? 'on' : ''}`} onClick={() => setTab('draft')}>草稿</button>
            <button className={`pdf-tab ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>摘录历史 · {excerpts.length}</button>
          </div>

          {tab === 'draft' && (
            <div className="pdf-draft">
              <div className="pdf-paste">
                <textarea
                  className="quiz-paste" rows={2}
                  placeholder="没有文字层？粘一段教材文字，生成原文摘录"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                <button className="btn-small" disabled={!pasteText.trim()} onClick={() => genDraft(pasteText)}>
                  生成原文摘录
                </button>
              </div>
              {savedMsg && <div className="pdf-saved">✓ {savedMsg}</div>}
              {!draft ? (
                <div className="pdf-draft-empty">
                  <p>在左侧划选一段重点，点「粘贴到右侧」直接粘进来</p>
                  <p className="muted">多段摘录会在这里累积，选好目标笔记后一次追加</p>
                </div>
              ) : (
                <>
                  <div className="draft-review">
                    <div className="draft-row pdf-target-row">
                      <label htmlFor="pdf-target-note">目标笔记</label>
                      <select
                        id="pdf-target-note"
                        value={targetPath}
                        onChange={(e) => setTargetPath(e.target.value)}
                      >
                        <option value="">新建笔记</option>
                        {noteTargets.map((n) => (
                          <option key={n.path} value={n.path}>
                            {n.title}{n.chapter ? ` · ${n.chapter}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="draft-row">
                      <label>标题</label>
                      <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                    </div>
                    <div className="draft-row">
                      <label>目录/章节</label>
                      <input value={draft.chapter} onChange={(e) => setDraft({ ...draft, chapter: e.target.value })} placeholder="如 生理学/呼吸" />
                    </div>
                    <textarea
                      className="quiz-paste draft-body" rows={12}
                      value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    />
                    <div className="quiz-actions">
                      <button className="btn-primary draft-gen" disabled={saving} onClick={() => void saveDraft()}>
                        {saving ? '保存中…' : targetPath ? '追加到目标笔记' : '入库为新笔记'}
                      </button>
                      <button className="btn-small" disabled={!lastSelRef.current} onClick={() => pasteToRight(lastSelRef.current)}>把上次划选粘进来</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="pdf-history">
              {excerpts.length > 0 && (
                <div className="pdf-paste">
                  <button className="btn-small" onClick={exportExcerpts}>导出</button>
                  <button className="btn-small" onClick={clearExcerpts}>清空</button>
                </div>
              )}
              {excerpts.length === 0 && <div className="pdf-draft-empty"><p>还没有摘录</p><p className="muted">划选生成的原文摘录会自动记入历史，可随时回填修改</p></div>}
              {excerpts.map((x) => (
                <div key={x.id} className="excerpt-item">
                  <div className="excerpt-main">
                    <div className="excerpt-title">
                      {x.title}
                      {x.savedPath && <span className="excerpt-saved">✓ 已入库</span>}
                    </div>
                    <div className="muted excerpt-text">{x.text.slice(0, 60)}…</div>
                    <div className="muted">《{x.file}》第 {x.page} 页 · {new Date(x.ts).toLocaleString()}</div>
                  </div>
                  <button className="btn-small" onClick={() => openExcerpt(x)}>回填</button>
                  <button className="btn-icon" aria-label="删除摘录" onClick={() => removeExcerpt(x.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
