/**
 * ③ PDF 讲义对照视图：左 PDF 原文（react-pdf-viewer，自带高 DPI/文本层/缩放/适应宽度/翻页），
 *    右智能草稿 + 摘录历史。划选重点 → ✨生成草稿（noteGen 规则引擎）→ 审核 → 入库。
 */
import {
  useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEsc, escThenClose } from './useEsc';
import { Viewer } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
// worker 地址由 core/pdfLib 统一设置（pdfWorkerSrc 指向 public/pdfjs/ 的稳定路径，
// 不走 ?url —— 见该文件注释）；这里只需保证打开文档前调用过 loadPdfjs。
import {
  detectScannedPdf, loadPdfjs, listPdfBooks, getPdfBook, putPdfBook,
  removePdfBook, savePdfPage, setCurrentPdfBook, getCurrentPdfName,
  migrateLegacyPdf, type PdfBook,
} from '../core/pdfLib';
import { renderAsync } from 'docx-preview';
import { sanitizeRenderedHyperlinks } from '../core/domSanitize';
import { confirmBox, toast } from '../core/feedback';
import { netErrorHint } from '../core/netError';
import { generateDraft, draftToMarkdown, type Draft } from '../core/noteGen';
import { normalizePdfSelection } from '../core/pdfText';
import {
  beginGeometrySelection, clearHighlights, endGeometrySelection, selectByGeometry,
} from '../core/pdfCharSelect';
import { IconPlus, IconClose, IconFile, IconBook } from './icons';
import { clickable } from './a11y';
import Loading from './Loading';

/** 静态资源根：base './' 时构建产物为 './'，GitHub Pages 子路径也能正确加载 */
const BASE = import.meta.env.BASE_URL;

/** 载入随包示例 PDF。显式检查 r.ok：以前直接 `.arrayBuffer()`，404 时会把错误页的 HTML
 *  当 PDF 喂给解析器，报出来的是一句和「文件没找到」毫无关系的解析错误。 */
async function fetchSamplePdf(): Promise<ArrayBuffer> {
  const r = await fetch(`${BASE}sample-lecture.pdf`);
  if (!r.ok) throw new Error(`示例文件读取失败 (HTTP ${r.status})`);
  return r.arrayBuffer();
}

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

const EX_KEY = 'knowlattice-excerpts';
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
const AUTODRAFT_KEY = 'knowlattice-pdf-autodraft';
/** 几何选区开关（默认开：原生划选在绝对定位的文字层上向下拖会把整页框进选区、反复闪烁） */
const GEOMSEL_KEY = 'knowlattice-pdf-geomsel';
/** Column mode (default off): middle lines stay inside the drag x band. */
const COLMODE_KEY = 'knowlattice-pdf-colmode';

/** 已打开的 PDF 文档 */
interface OpenDoc {
  data: Uint8Array;
  name: string;
}

/** PDF 页面渲染器：worker 由 core/pdfLib 统一配置（见 loadPdfjs） */
function PdfViewer({ doc, plugin, onPageChange }: {
  doc: OpenDoc;
  plugin: ReturnType<typeof defaultLayoutPlugin>;
  onPageChange: (page: number) => void;
}) {
  return (
    <Viewer
      // 换书必须重挂：<Viewer> 只在挂载时读一次 fileUrl，光改 prop 不会重新加载文档
      // （切书后画布停在上本、或直接空白，就是这里）。key 由调用方给（书名 + 打开序号）。
      fileUrl={doc.data}
      plugins={[plugin]}
      // 说明：这里不设 initialPage —— default-layout 下没人消费它（只被 core 收下），
      // 实测切书后仍停在第 1 页。也没有稳定的跳页途径（jumpToPage 需等插件 store 就绪、
      // 直接改 .rpv-core__inner-pages 的 scrollTop 会被它的虚拟滚动重置）。
      // 因此页码只做「记录 + 显示」（书架里能看到读到第几页），暂不自动跳回。
      renderLoader={(percentages: number) => (
        <Loading label={`PDF 渲染中… ${Math.round(percentages)}%`} />
      )}
      renderError={(error) => (
        <div className="pdf-error-hint">
          <p>PDF 渲染失败</p>
          <p className="muted">{String(error?.message ?? error)}</p>
        </div>
      )}
      onPageChange={(e) => onPageChange(e.currentPage + 1)}
    />
  );
}

export default function PdfSplitView({ onSave, onAppend, noteTargets, onClose }: Props) {
  const defaultLayoutPluginInstance = useRef(defaultLayoutPlugin()).current;
  const [doc, setDoc] = useState<OpenDoc | null>(null);
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
  /** 书架（只含元数据，正文按需单独读） */
  const [books, setBooks] = useState<PdfBook[]>([]);
  const [shelfOpen, setShelfOpen] = useState(false);
  /** 每打开一次文档 +1：作为 viewer 的 key 后缀，保证重开同一本也会重建 */
  const [docSeq, setDocSeq] = useState(0);
  const shelfRef = useRef<HTMLDivElement>(null);

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

  // Esc 关闭。走全局 Esc 栈，并按层退：划选弹层开着先收弹层 → 焦点在输入框里先退出输入框
  // → 都没有才关整个对照面板（以前一次 Esc 会把面板连同右栏草稿一起关掉）。
  useEsc((e) => {
    if (selected) {
      setSelected(null);
      return;
    }
    escThenClose(onClose)(e);
  });

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

  // 打开文档：按扩展名分流 PDF / Word（都可选中文字生成草稿）。
  // opts.persist=false 表示这次打开不写入书架（从书架点一本已有的书时，不该刷新它的排序）。
  const openDoc = async (
    name: string, source: File | ArrayBuffer, opts: { persist?: boolean } = {}
  ) => {
    setBusy(true);
    try {
      const buf = source instanceof File ? await source.arrayBuffer() : source;
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (ext === 'docx') {
        // 用 docx-preview 渲染原始版式（保留段落/表格/图片/分页，可划选）
        setDoc(null); setDocType('docx'); setDocBuf(buf);
      } else {
        // 必须在渲染 <Viewer> 之前把 pdfjs 的 workerSrc 设好，否则 pdfjs 会按自己的
        // 默认路径找 worker（那个路径在生产产物里不存在）→ 静默渲染成空白。
        await loadPdfjs();
        setDoc({ data: new Uint8Array(buf), name });
        setDocType('pdf'); setDocBuf(null);
        setDocSeq((n) => n + 1);
        setPage(1);
        setSelected(null);
        setScanned(false);
        endGeometrySelection();
        clearHighlights(paneRef.current);
        // 几何选区回到用户偏好（默认开）；扫描件随后强制开启
        setGeomSel(localStorage.getItem(GEOMSEL_KEY) !== '0');
        if (opts.persist !== false) {
          // 入架并置为当前书；同名文件重选即覆盖（putPdfBook 的 keyPath 就是书名）。
          // 示例 PDF 走 ArrayBuffer 也照此入架，用户不必每次重新载入。
          void putPdfBook(name, buf).then(() => refreshBooks());
        }
        // 采样前几页文字层判断扫描件；必须传副本，pdf.js 会 detach 传入的 ArrayBuffer
        void detectScannedPdf(buf.slice(0)).then((isScanned) => {
          setScanned(isScanned);
          if (isScanned) setGeomSel(true);
        });
      }
      setFileName(name);
      setShelfOpen(false);
    } catch (e) {
      toast(`文档打开失败：${netErrorHint(e)}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const refreshBooks = async () => setBooks(await listPdfBooks());

  /** 从书架切到另一本书：读正文 → 按它自己记下的页码打开，不改变排序 */
  const openBook = async (book: PdfBook) => {
    if (busy) return;
    setBusy(true);
    try {
      const rec = await getPdfBook(book.name);
      if (!rec) {
        toast('这本书的正文找不到了，请重新选择文件', 'err');
        setBooks(await removePdfBook(book.name));
        return;
      }
      await setCurrentPdfBook(book.name);
      await openDoc(rec.name, rec.data, { persist: false });
      await refreshBooks();
    } finally {
      setBusy(false);
    }
  };

  const deleteBook = async (book: PdfBook) => {
    const wasCurrent = fileName === book.name;
    const rest = await removePdfBook(book.name);
    setBooks(rest);
    if (!wasCurrent) return;
    // 删掉的是正在看的这本：自动切到书架里最近的一本，没有就回到空态
    if (rest[0]) await openBook(rest[0]);
    else {
      setDoc(null); setDocType(null); setDocBuf(null); setFileName(null);
      await setCurrentPdfBook('');
    }
  };

  /** 删除历史书籍：保留当前打开的这本，其余全部移除（先确认，防手滑） */
  const clearBookHistory = async () => {
    const doomed = books.filter((b) => b.name !== fileName);
    if (doomed.length === 0) return;
    const ok = await confirmBox({
      title: `清空另外 ${doomed.length} 本历史书籍？`,
      detail: '只删书架记录，当前这本书与笔记摘录都不受影响。',
      okText: '清空',
      danger: true,
    });
    if (!ok) return;
    for (const b of doomed) await removePdfBook(b.name);
    setBooks(await listPdfBooks());
  };

  // 启动时先迁移旧的单本存储，再恢复上次那本书
  useEffect(() => {
    void (async () => {
      await migrateLegacyPdf();
      await refreshBooks();
      const currentName = await getCurrentPdfName();
      if (!currentName) return;
      const rec = await getPdfBook(currentName);
      if (rec) await openDoc(rec.name, rec.data, { persist: false });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切书下拉：点外面 / Esc 收起（挂在捕获阶段，避免被面板自身的 Esc 处理抢先）
  useEffect(() => {
    if (!shelfOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!shelfRef.current?.contains(e.target as Node)) setShelfOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShelfOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [shelfOpen]);

  // 翻页时把进度记到当前这本书上（防抖：翻页会连发多次）
  useEffect(() => {
    if (docType !== 'pdf' || !fileName) return;
    const timer = setTimeout(() => { void savePdfPage(fileName, page); }, 600);
    return () => clearTimeout(timer);
  }, [page, docType, fileName]);

  // 复制净化：在左侧原文面板里 Ctrl+C / 右键复制时，粘贴出去的就是清理过的文本
  // （原生复制会把 PDF 排版产生的多余空格一起带上；只拦左栏，右栏草稿不受影响）
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const pane = paneRef.current;
      const sel = window.getSelection();
      if (!pane || !sel || sel.isCollapsed || !sel.anchorNode || !pane.contains(sel.anchorNode)) return;
      const cleaned = normalizePdfSelection(sel.toString());
      if (!cleaned) return;
      e.clipboardData?.setData('text/plain', cleaned);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, []);

  // docx：用 docx-preview 渲染原始 Word 版式（保留段落/表格/图片/分页，可划选）
  useEffect(() => {
    if (docType !== 'docx' || !docBuf || !docRenderRef.current) return;
    docRenderRef.current.innerHTML = '';
    void renderAsync(docBuf, docRenderRef.current, undefined, {
      inWrapper: true,
      breakPages: true,
      ignoreWidth: false,
    }).then(() => {
      // 审计 M1：docx-preview 不校验 a[href] 协议，Word 里的 javascript:/file: 链接
      // 会原样落 DOM。渲染完成后做一遍清洗（只动属性，不破坏排版）。
      const n = sanitizeRenderedHyperlinks(docRenderRef.current);
      if (n > 0) console.warn(`docx 内 ${n} 个非安全协议链接已禁用`);
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
      toast(netErrorHint(e), 'err');
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
      a.download = 'knowlattice-excerpts.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(netErrorHint(e), 'err');
    }
  };

  const removeExcerpt = (id: string) => {
    setExcerpts((prev) => { const next = prev.filter((x) => x.id !== id); saveExcerpts(next); return next; });
  };

  return (
    <div className="panel panel--full pdf-overlay">
      <div className="panel__head pdf-topbar">
        <button className="btn-small" onClick={onClose}>← 退出对照</button>
        {/* 书架：书名即按钮，点开切换书籍；没书时退化成一段提示 */}
        <div className="pdf-shelf" ref={shelfRef}>
          <button
            className="pdf-shelf__btn"
            disabled={books.length === 0}
            aria-haspopup="listbox"
            aria-expanded={shelfOpen}
            title={books.length ? '切换书籍' : '还没有书，先选择 PDF / Word'}
            onClick={() => setShelfOpen((v) => !v)}
          >
            <IconBook />
            <span className="pdf-shelf__name">{fileName ?? '未选择 PDF'}</span>
            {books.length > 0 && <span className="pdf-shelf__chevron">▾</span>}
          </button>
          {shelfOpen && (
            <div className="pdf-shelf__menu" role="listbox" aria-label="书架">
              {/* 直白按钮：导入 / 清空历史，不用翻找 */}
              <div className="pdf-shelf__actions">
                <button className="btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>
                  <IconFile /> 导入书籍
                </button>
                {books.length > 1 && (
                  <button
                    className="btn-small pdf-shelf__clear"
                    title="删除当前这本以外的全部书籍（笔记摘录不受影响）"
                    onClick={() => void clearBookHistory()}
                  >
                    删除历史书籍
                  </button>
                )}
              </div>
              <div className="pdf-shelf__title muted">书架 · {books.length} 本 · 点书目切换</div>
              {books.map((b) => (
                <div
                  key={b.name}
                  aria-selected={b.name === fileName}
                  className={`pdf-shelf__item${b.name === fileName ? ' on' : ''}`}
                  onClick={() => void openBook(b)}
                  {...clickable(`打开《${b.name}》`)}
                >
                  <span className="pdf-shelf__item-name">{b.name}</span>
                  <span className="pdf-shelf__item-meta muted">
                    {b.name === fileName && page > 0 ? `第 ${page} 页 · ` : (b.page > 0 ? `读到第 ${b.page} 页 · ` : '')}
                    {new Date(b.at).toLocaleDateString()}
                  </span>
                  <button
                    className="btn-icon pdf-shelf__del"
                    aria-label={`从书架移除《${b.name}》`}
                    title="从书架移除（笔记摘录不受影响）"
                    onClick={(e) => { e.stopPropagation(); void deleteBook(b); }}
                  >
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
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
          {busy ? '导入中…' : '导入书籍'}
        </button>
        <input
          ref={fileRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openDoc(f.name, f); e.target.value = ''; }}
        />
        <button
          className="btn-small" disabled={busy}
          onClick={async () => {
            try {
              const buf = await fetchSamplePdf();
              await openDoc('sample-lecture.pdf', buf, { persist: true });
            } catch (e) { toast(netErrorHint(e), 'err'); }
          }}
        >
          载入示例
        </button>
      </div>

      <div className="pdf-ocr-tip">
        {scanned
          ? '扫描件 · 已开「几何选区」· 划选原文，Enter 粘进右栏'
          : '划选原文 · Enter 粘进右栏草稿 · 多段累积，一次追加'}
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
              {/* key：换书（或重开同一本）时强制重挂 viewer —— 它只在挂载时读 fileUrl，
                  否则切书后画布会停在上本书、或干脆空白。序号保证「重开同一本」也会重建。 */}
              <PdfViewer
                key={`${doc.name}#${docSeq}`}
                doc={doc}
                plugin={defaultLayoutPluginInstance}
                onPageChange={(n) => { setPage(n); endGeometrySelection();
                  clearHighlights(paneRef.current); setSelected(null); }}
              />
            </div>
          )}
          {docType === 'docx' && docBuf && (
            <div className="pdf-doc-scroll"><div ref={docRenderRef} className="pdf-doc-render" /></div>
          )}
          {!docType && (
            <div className="pdf-empty">
              <div className="pdf-empty__badge">PDF 对照</div>
              <div className="pdf-empty__title">左看原文，右记笔记</div>
              <div className="pdf-empty__cta">
                <button className="btn-primary" onClick={() => fileRef.current?.click()}>
                  <IconFile /> 导入书籍
                </button>
                <button
                  className="btn-small"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const buf = await fetchSamplePdf();
                      await openDoc('sample-lecture.pdf', buf, { persist: true });
                    } catch (e) { toast(netErrorHint(e), 'err'); }
                  }}
                >载入示例</button>
              </div>
              <div className="teach-steps pdf-empty__steps">
                <div className="teach-step"><kbd>划选</kbd><span>原文粘进右栏</span></div>
                <div className="teach-step"><kbd>Enter</kbd><span>快速粘贴</span></div>
                <div className="teach-step"><kbd>书架</kbd><span>切换书籍</span></div>
              </div>
              <p className="muted pdf-empty__hint">导入的书籍自动入架 · 随时切换</p>
            </div>
          )}
          {selected && (
            <div className="pdf-popover" style={{ left: selected.x, top: selected.y }}>
              <span className="pdf-popover-btn" onClick={() => pasteToRight(selected.text)} {...clickable()}>
                <IconPlus /> 粘贴到右侧 <kbd>⏎</kbd>
              </span>
              <span
                className="pdf-popover-btn"
                onClick={() => { void navigator.clipboard.writeText(selected.text); setSelected(null); }}
                {...clickable()}
              >
                仅复制
              </span>
              <span
                className="pdf-popover-btn"
                onClick={() => { setSelected(null); clearPdfSelection(); }}
                {...clickable()}
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
                  placeholder="粘一段原文，生成摘录"
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
                  <p>左侧划选重点，粘到这里</p>
                  <p className="muted">多段累积 · 选目标笔记一次追加</p>
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
              {excerpts.length === 0 && <div className="pdf-draft-empty"><p>还没有摘录</p><p className="muted">划选原文自动记入 · 可回填</p></div>}
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
                  <button className="btn-icon" aria-label="删除摘录" onClick={() => removeExcerpt(x.id)}><IconClose /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
