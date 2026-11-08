/**
 * 不依赖商业 UI 包的 PDF 阅读器。
 *
 * 页面渲染、文本层、链接、查找与虚拟滚动都由 pdfjs-dist 自带的 Apache-2.0
 * PDFViewer 负责；本组件只提供与 KnowLattice 设计系统一致的工具栏和生命周期。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnnotationMode } from 'pdfjs-dist';
import {
  EventBus,
  FindState,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { loadPdfjs, pdfDocumentParams } from '../core/pdfLib';
import Loading from './Loading';

interface Props {
  data: Uint8Array;
  name: string;
  onPageChange: (page: number) => void;
}

type FindMatches = { current?: number; total?: number };
type FindStateEvent = { state: number; matchesCount?: FindMatches; rawQuery?: string | null };
type FindCountEvent = { matchesCount?: FindMatches };

function clampPage(value: number, pages: number): number {
  if (!Number.isFinite(value) || pages < 1) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), pages);
}

function FindLabel({ query, state, matches }: { query: string; state: number | null; matches: FindMatches | null }) {
  if (!query.trim()) return null;
  if (state === FindState.PENDING) return <>查找中…</>;
  if (state === FindState.NOT_FOUND) return <>无结果</>;
  if (!matches?.total) return <>无结果</>;
  return <>{matches.current ?? 0} / {matches.total}</>;
}

export default function NativePdfViewer({ data, name, onPageChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  const [pages, setPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [scalePct, setScalePct] = useState(100);
  const [fitWidth, setFitWidth] = useState(true);
  const [query, setQuery] = useState('');
  const [findState, setFindState] = useState<number | null>(null);
  const [matches, setMatches] = useState<FindMatches | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    let disposed = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    let pdfViewer: PDFViewer | null = null;
    let eventBus: EventBus | null = null;

    const boot = async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (disposed || !scrollRef.current || !viewerRef.current) return;

        eventBus = new EventBus();
        eventBusRef.current = eventBus;
        const linkService = new PDFLinkService({
          eventBus,
          externalLinkTarget: LinkTarget.BLANK,
          externalLinkRel: 'noopener noreferrer',
        });
        const findController = new PDFFindController({ eventBus, linkService });
        pdfViewer = new PDFViewer({
          container: scrollRef.current,
          viewer: viewerRef.current,
          eventBus,
          linkService,
          findController,
          annotationMode: AnnotationMode.ENABLE_FORMS,
          enableAutoLinking: false,
          removePageBorders: true,
        });
        pdfViewerRef.current = pdfViewer;
        linkService.setViewer(pdfViewer);

        eventBus.on('pagesinit', () => {
          if (disposed || !pdfViewer) return;
          setPages(pdfViewer.pagesCount);
          pdfViewer.currentScaleValue = 'page-width';
          setFitWidth(true);
          setCurrentPage(pdfViewer.currentPageNumber);
          setPageDraft(String(pdfViewer.currentPageNumber));
          onPageChangeRef.current(pdfViewer.currentPageNumber);
        });
        eventBus.on('pagechanging', (event: { pageNumber?: number }) => {
          if (disposed || !event.pageNumber) return;
          setCurrentPage(event.pageNumber);
          setPageDraft(String(event.pageNumber));
          onPageChangeRef.current(event.pageNumber);
        });
        eventBus.on('scalechanging', (event: { scale?: number; presetValue?: string }) => {
          if (disposed || typeof event.scale !== 'number') return;
          setScalePct(Math.round(event.scale * 100));
          setFitWidth(event.presetValue === 'page-width');
        });
        eventBus.on('updatefindcontrolstate', (event: FindStateEvent) => {
          if (disposed) return;
          setFindState(event.state);
          if (event.matchesCount) setMatches(event.matchesCount);
        });
        eventBus.on('updatefindmatchescount', (event: FindCountEvent) => {
          if (!disposed && event.matchesCount) setMatches(event.matchesCount);
        });
        eventBus.on('pagerendered', () => {
          if (!disposed) setLoading(false);
        });

        const task = pdfjs.getDocument({ data: data.slice(), ...pdfDocumentParams() });
        loadingTask = task;
        const pdf = await task.promise;
        if (disposed) {
          await task.destroy();
          return;
        }
        pdfViewer.setDocument(pdf);
        linkService.setDocument(pdf, null);
        findController.setDocument(pdf);
      } catch (e) {
        if (!disposed) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void boot();
    return () => {
      disposed = true;
      eventBus?.dispatch('findbarclose', { source: eventBus });
      pdfViewer?.cleanup();
      pdfViewer?.setDocument(null);
      if (eventBusRef.current === eventBus) eventBusRef.current = null;
      if (pdfViewerRef.current === pdfViewer) pdfViewerRef.current = null;
      void loadingTask?.destroy();
    };
  }, [data, name]);

  const goToPage = () => {
    const viewer = pdfViewerRef.current;
    if (!viewer) return;
    viewer.currentPageNumber = clampPage(Number(pageDraft), pages);
  };

  const submitPage = (event: FormEvent) => {
    event.preventDefault();
    goToPage();
  };

  const changePage = (delta: number) => {
    const viewer = pdfViewerRef.current;
    if (!viewer) return;
    viewer.currentPageNumber = clampPage(viewer.currentPageNumber + delta, pages);
  };

  const changeScale = (steps: number) => {
    const viewer = pdfViewerRef.current;
    if (!viewer) return;
    setFitWidth(false);
    viewer.updateScale({ steps });
  };

  const dispatchFind = (type: '' | 'again', findPrevious = false) => {
    const eventBus = eventBusRef.current;
    if (!eventBus) return;
    eventBus.dispatch('find', {
      source: eventBus,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
      phraseSearch: true,
    });
  };

  useEffect(() => {
    if (!query.trim() || !pages) return;
    const timer = window.setTimeout(() => dispatchFind(''), 250);
    return () => window.clearTimeout(timer);
    // dispatchFind 读取最新的 query；这里只按输入和文档就绪状态触发搜索。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pages]);

  return (
    <div className="pdfjs-native-viewer">
      <div className="pdfjs-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <button className="btn-icon" type="button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => changePage(-1)}>‹</button>
        <form className="pdfjs-page-form" onSubmit={submitPage}>
          <input
            aria-label="页码"
            type="number"
            min={1}
            max={pages || 1}
            value={pageDraft}
            disabled={!pages}
            onChange={(event) => setPageDraft(event.target.value)}
            onBlur={goToPage}
          />
          <span className="pdfjs-page-total">/ {pages || '…'}</span>
        </form>
        <button className="btn-icon" type="button" aria-label="下一页" disabled={!pages || currentPage >= pages} onClick={() => changePage(1)}>›</button>
        <span className="pdfjs-toolbar__divider" aria-hidden="true" />
        <button className="btn-small" type="button" aria-label="缩小" disabled={!pages} onClick={() => changeScale(-1)}>−</button>
        <span className="pdfjs-scale" aria-live="polite">{scalePct}%</span>
        <button className="btn-small" type="button" aria-label="放大" disabled={!pages} onClick={() => changeScale(1)}>＋</button>
        <button
          className={`btn-small${fitWidth ? ' on' : ''}`}
          type="button"
          aria-pressed={fitWidth}
          disabled={!pages}
          onClick={() => {
            if (!pdfViewerRef.current) return;
            pdfViewerRef.current.currentScaleValue = 'page-width';
            setFitWidth(true);
          }}
        >适合宽度</button>
        <button
          className="btn-small"
          type="button"
          aria-label="顺时针旋转"
          disabled={!pages}
          onClick={() => {
            const viewer = pdfViewerRef.current;
            if (viewer) viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
          }}
        >旋转</button>
        <span className="pdfjs-toolbar__divider" aria-hidden="true" />
        <div className="pdfjs-find">
          <input
            type="search"
            aria-label="在 PDF 中搜索"
            placeholder="搜索全文"
            value={query}
            disabled={!pages}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              if (!next.trim()) {
                setFindState(null);
                setMatches(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                dispatchFind('again', event.shiftKey);
              }
            }}
          />
          <span className="pdfjs-find-count" aria-live="polite">
            <FindLabel query={query} state={findState} matches={matches} />
          </span>
          <button className="btn-icon" type="button" aria-label="上一个匹配" disabled={!query.trim()} onClick={() => dispatchFind('again', true)}>↑</button>
          <button className="btn-icon" type="button" aria-label="下一个匹配" disabled={!query.trim()} onClick={() => dispatchFind('again', false)}>↓</button>
        </div>
      </div>

      {loading && !error && <div className="pdfjs-loading"><Loading label="PDF 渲染中…" /></div>}
      {error && (
        <div className="pdf-error-hint" role="alert">
          <p>PDF 渲染失败</p>
          <p className="muted">{error}</p>
        </div>
      )}
      <div className="pdfjs-scroll-frame">
        <div ref={scrollRef} className="pdfjs-scroll">
          <div ref={viewerRef} className="pdfViewer" />
        </div>
      </div>
    </div>
  );
}
