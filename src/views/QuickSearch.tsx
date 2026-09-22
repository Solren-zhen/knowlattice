/**
 * Ctrl+K 快速唤起（M2）：标题模糊匹配 + 全文搜索 + 最近打开排序。
 * 搜索走全库共享的 vaultSearch 引擎（懒构建 + 增量同步）：
 * 打开弹窗或输入查询时索引已就绪/增量更新，绝不全库重建。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc } from './useEsc';
import { vaultSearch, type SearchDoc } from '../core/searchIndex';
import { buildSnippet, segment, titleHits, type Hit } from '../core/searchHit';

interface Props {
  open: boolean;
  docs: Map<string, string>;
  recents: string[];
  onClose: () => void;
  /** 打开笔记；第二个参数是命中词，交给编辑器跳转 + 高亮 */
  onOpenPath: (path: string, highlight?: string) => void;
}

/** 把命中区间渲染成 <mark>；片段里可能有多处命中，逐段切 */
function Marked({ text, hits }: { text: string; hits: Hit[] }) {
  return (
    <>
      {segment(text, hits).map((s, i) => (s.hit ? <mark key={i} className="qs-mark">{s.text}</mark> : s.text))}
    </>
  );
}

export default function QuickSearch({ open, docs, recents, onClose, onOpenPath }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [searchReady, setSearchReady] = useState(vaultSearch.isReady());
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // docs 变化 → 增量同步到共享搜索引擎（未构建时只登记，成本近零）
  useEffect(() => {
    vaultSearch.sync(docs);
  }, [docs]);

  // 用户开始输入时若索引还没建好：异步分块构建，构建期间显示「索引构建中」
  useEffect(() => {
    if (!open || !query.trim() || vaultSearch.isReady()) return;
    let cancelled = false;
    void vaultSearch.warm().then(() => {
      if (!cancelled) setSearchReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query]);

  // 打开时重置搜索状态（渲染期调整，避免 effect 内同步 setState 引发级联渲染）
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery('');
      setSel(0);
      setSearchReady(vaultSearch.isReady());
    }
  }

  const results: { doc: SearchDoc; score: number }[] = useMemo(() => {
    if (!query.trim()) {
      // 无输入：最近打开优先，最多取 20 条（避免空查询把全库 5000+ 篇排序一遍）
      const recentDocs = recents
        .map((p) => vaultSearch.getDoc(p))
        .filter((d): d is SearchDoc => d !== undefined);
      const seen = new Set(recentDocs.map((d) => d.id));
      const fill = vaultSearch.listSome(seen, Math.max(0, 20 - recentDocs.length));
      return [...recentDocs, ...fill].slice(0, 20).map((doc) => ({ doc, score: 0 }));
    }
    if (!searchReady) return [];
    return vaultSearch
      .search(query)
      .map((h) => ({ doc: vaultSearch.getDoc(h.id)!, score: h.score }))
      .filter((r) => r.doc);
  }, [query, recents, searchReady]);

  /** 渲染用行：结果 + 标题命中 + 正文片段。依赖里**不含 sel**——
   *  上下键和鼠标悬停都会改 sel，若把它算进来，每移动一格都要把 20 条结果
   *  重新定位、重新切片段。 */
  const rows = useMemo(
    () =>
      results.slice(0, 20).map((r) => ({
        id: r.doc.id,
        title: r.doc.title,
        recent: !query && recents.includes(r.doc.id),
        titleHits: query.trim() ? titleHits(r.doc.title, query) : [],
        snip: buildSnippet(r.doc.content, query),
      })),
    [results, query, recents]
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // Esc 关闭走全局 Esc 栈。传 open 而不是只靠挂载：本组件目前是条件挂载的，
  // 但万一将来改成常挂（open 当 prop），没有这个开关就会一直占着栈顶把 Esc 吞掉。
  useEsc(onClose, open);

  // 键盘 ↓ 越出可视区后把高亮项滚进视口：否则高亮条看不见，
  // 此时按回车会打开一篇用户根本没看到的笔记。
  useEffect(() => {
    if (!open) return;
    const el = resultsRef.current?.querySelectorAll('.qs-item')[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, sel, results.length]);

  if (!open) return null;

  const pick = (i: number) => {
    const r = results[i];
    if (r) {
      // 把命中词一起带过去：编辑器会跳到第一处并高亮全部命中
      onOpenPath(r.doc.id, query.trim() || undefined);
      onClose();
    }
  };

  return (
    <div className="panel-backdrop qs-overlay" onClick={onClose}>
      <div className="panel qs-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qs-input"
          placeholder="搜索笔记标题或全文…（↑↓ 选择，回车打开，Esc 关闭）"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              pick(sel);
            }
          }}
        />
        <div className="qs-results" ref={resultsRef}>
          {!searchReady && query.trim() && <div className="qs-empty">正在构建全文索引…（仅首次需要几秒）</div>}
            {searchReady && results.length === 0 && <div className="qs-empty">没有匹配「{query}」的笔记</div>}
          {rows.map((row, i) => (
            <div
              key={row.id}
              className={`qs-item ${i === sel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <div className="qs-title">
                <Marked text={row.title} hits={row.titleHits} />
                {row.recent && <span className="qs-recent">最近</span>}
              </div>
              <div className="qs-snippet"><Marked text={row.snip.text} hits={row.snip.hits} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
