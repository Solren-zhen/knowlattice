/**
 * Ctrl+K 快速唤起（M2）：标题模糊匹配 + 全文搜索 + 最近打开排序。
 * 搜索走全库共享的 vaultSearch 引擎（懒构建 + 增量同步）：
 * 打开弹窗或输入查询时索引已就绪/增量更新，绝不全库重建。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc } from './useEsc';
import BottomSheet from './BottomSheet';
import { vaultSearch, type SearchDoc } from '../core/searchIndex';
import { buildSnippet, segment, titleHits, type Hit } from '../core/searchHit';

/** 窄屏阈值：只跟「手指能不能够到居中弹窗」有关 */
const NARROW_QUERY = '(max-width: 700px)';
/** 抽屉两档：近处一档（默认，输入框与结果同屏）与全开一档 */
const QS_SHEET_STOPS = [0.62, 0.94] as const;

function narrowNow(): boolean {
  const media = typeof window === 'undefined' ? null : window.matchMedia?.(NARROW_QUERY);
  return media ? media.matches === true : false;
}

interface Props {
  open: boolean;
  docs: Map<string, string>;
  recents: string[];
  onClose: () => void;
  /** 打开笔记；第二个参数是命中词，交给编辑器跳转 + 高亮 */
  /** 打开笔记；第二参是命中词（编辑器跳转 + 高亮），第三参是触发的行元素（共享元素转场来源） */
  onOpenPath: (path: string, highlight?: string, origin?: Element | null) => void;
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

  // 窄屏（≤700px）改用底部抽屉呈现。判断写法与 Rail / Workspace 的窄屏判断一致，
  // 但多包一层「matchMedia 可能不存在」的防御（测试环境里有的用例不 stub 它）。
  // 呈现方式在「打开这一刻」定下来就够：搜索面板本身就是打开时挂载、关闭即卸载的，
  // 不需要再挂一个 resize 监听去追（拖窗口改变宽度的同时正在搜索是极少数情况）。
  const [isNarrow] = useState(narrowNow);

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

  /**
   * 命中条目只留 `{ id, score }` 这种轻量结构，**doc 到真正要用时才取**（见 rows 与 pick）。
   * 原来这里对全部命中逐步 `getDoc(h.id)`（每条都新建一个对象、还各做一次 titleOf 字符串处理），
   * 而界面最多显示 20 条 → 宽泛查询下每敲一个键都白算几千次。
   * 命中数组本身不截断：↓ 键的可达范围、pick(i) 的取值都与改动前一致（只是取 doc 的时机后移）。
   */
  const results: { id: string; score: number }[] = useMemo(() => {
    if (!query.trim()) {
      // 无输入：最近打开优先，最多取 20 条（避免空查询把全库 5000+ 篇排序一遍）
      const recentDocs = recents
        .map((p) => vaultSearch.getDoc(p))
        .filter((d): d is SearchDoc => d !== undefined);
      const seen = new Set(recentDocs.map((d) => d.id));
      const fill = vaultSearch.listSome(seen, Math.max(0, 20 - recentDocs.length));
      return [...recentDocs, ...fill].slice(0, 20).map((doc) => ({ id: doc.id, score: 0 }));
    }
    if (!searchReady) return [];
    // MiniSearch 的命中本身就是 { id, score, ... }，直接当轻量条目用，不再逐条建 doc 对象
    return vaultSearch.search(query);
  }, [query, recents, searchReady]);

  /** 渲染用行：结果 + 标题命中 + 正文片段。依赖里**不含 sel**——
   *  上下键和鼠标悬停都会改 sel，若把它算进来，每移动一格都要把 20 条结果
   *  重新定位、重新切片段。
   *
   *  这里按**命中顺序**逐条取 doc，一边取一边丢失效条目，凑满 20 条就停：
   *  与原来的「先对全部命中建对象、过滤、再 slice(0, 20)」得到的列表逐条相同
   *  （同样的条目、同样的顺序、最多 20 条），但只为真正要显示的那 20 条建对象。
   */
  const rows = useMemo(() => {
    const docs: SearchDoc[] = [];
    for (const r of results) {
      const doc = vaultSearch.getDoc(r.id);
      if (!doc) continue; // 索引里已没有这篇（失效条目）：跳过，不占一格
      docs.push(doc);
      if (docs.length >= 20) break;
    }
    return docs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      recent: !query && recents.includes(doc.id),
      titleHits: query.trim() ? titleHits(doc.title, query) : [],
      snip: buildSnippet(doc.content, query),
    }));
  }, [results, query, recents]);

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

  const pick = (i: number, origin?: Element | null) => {
    const r = results[i];
    const doc = r ? vaultSearch.getDoc(r.id) : undefined;
    // 条目的 doc 现在是在这里才取的（见 results 的注释）。索引里已经查不到这篇时什么都不做：
    // 旧写法拿的是渲染时那份快照，会带着已经不存在的路径去打开笔记。
    if (doc) {
      // 把命中词一起带过去：编辑器会跳到第一处并高亮全部命中；
      // origin 是点中的那一行，带它去做「列表卡片 → 笔记标题」的共享元素转场（第 3 项）
      onOpenPath(doc.id, query.trim() || undefined, origin);
      onClose();
    }
  };

  const panel = (
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
            {/* 空态判据用 rows（= 过滤掉失效条目后真正要显示的条数）：results 现在是命中数，
                它的空只说明「一条命中都没有」；列表空而 results 非空只可能是命中全部失效，
                那时按旧写法也该显示这个空态。 */}
            {searchReady && rows.length === 0 && <div className="qs-empty">没有匹配「{query}」的笔记</div>}
          {rows.map((row, i) => (
            <div
              key={row.id}
              className={`qs-item ${i === sel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={(e) => pick(i, e.currentTarget)}
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
  );

  if (isNarrow) {
    // 窄屏：居中的搜索框够不着、软键盘弹出后更挤，改用底部抽屉（第 5 项）。
    // 桌面端保持原来的居中弹窗，一点没变。
    return (
      <BottomSheet open={open} onClose={onClose} label="快速搜索" stops={QS_SHEET_STOPS}>
        {panel}
      </BottomSheet>
    );
  }

  return (
    <div className="panel-backdrop qs-overlay" onClick={onClose}>
      {panel}
    </div>
  );
}
