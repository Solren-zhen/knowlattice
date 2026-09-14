/**
 * Ctrl+K 快速唤起（M2）：标题模糊匹配 + 全文搜索 + 最近打开排序。
 * 搜索走全库共享的 vaultSearch 引擎（懒构建 + 增量同步）：
 * 打开弹窗或输入查询时索引已就绪/增量更新，绝不全库重建。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { vaultSearch, type SearchDoc } from '../core/searchIndex';

interface Props {
  open: boolean;
  docs: Map<string, string>;
  recents: string[];
  onClose: () => void;
  onOpenPath: (path: string) => void;
}

/** 从正文提取命中片段（含查询词的上下文） */
function snippet(content: string, query: string, len = 60): string {
  const body = content.replace(/^---[\s\S]*?---\n?/, '');
  const q = query.trim();
  if (!q) return body.slice(0, len);
  // 用 bigram 的首字符做简单定位
  const idx = body.toLowerCase().indexOf(q[0].toLowerCase());
  if (idx < 0) return body.slice(0, len);
  const start = Math.max(0, idx - 15);
  return (start > 0 ? '…' : '') + body.slice(start, start + len).replace(/\n/g, ' ');
}

export default function QuickSearch({ open, docs, recents, onClose, onOpenPath }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [searchReady, setSearchReady] = useState(vaultSearch.isReady());
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const pick = (i: number) => {
    const r = results[i];
    if (r) {
      onOpenPath(r.doc.id);
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
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <div className="qs-results">
          {!searchReady && query.trim() && <div className="qs-empty">正在构建全文索引…（仅首次需要几秒）</div>}
            {searchReady && results.length === 0 && <div className="qs-empty">没有匹配「{query}」的笔记</div>}
          {results.slice(0, 20).map((r, i) => (
            <div
              key={r.doc.id}
              className={`qs-item ${i === sel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <div className="qs-title">
                {r.doc.title}
                {!query && recents.includes(r.doc.id) && <span className="qs-recent">最近</span>}
              </div>
              <div className="qs-snippet">{snippet(r.doc.content, query)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
