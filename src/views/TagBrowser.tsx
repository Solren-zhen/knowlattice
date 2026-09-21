/**
 * 标签聚合页：把全库 #标签 按使用次数聚合成标签云。
 * 点标签 → 列出该标签下的笔记 → 点笔记直达编辑。定位以标签组织为主的知识库。
 */
import { useMemo, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { parseFrontmatter } from '../core/parser';
import { IconTag, IconClose } from './icons';
import { clickable } from './a11y';

interface Props {
  docs: Map<string, string>;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

export default function TagBrowser({ docs, onOpenPath, onClose }: Props) {
  // Esc 关闭；焦点在标签搜索框里时先退出输入框，再按一次才关面板
  useEsc(escThenClose(onClose));
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');

  /** tag → 笔记路径集合（仅 .md，一次构建） */
  const tagMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [path, content] of docs) {
      if (!path.endsWith('.md')) continue;
      const { meta } = parseFrontmatter(content);
      for (const t of meta.tags) {
        if (!t) continue;
        if (!m.has(t)) m.set(t, new Set());
        m.get(t)!.add(path);
      }
    }
    return m;
  }, [docs]);

  const tags = useMemo(
    () => [...tagMap.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'zh')),
    [tagMap]
  );

  const shownTags = useMemo(() => (q ? tags.filter(([t]) => t.includes(q.trim())) : tags), [tags, q]);
  const selNotes = sel ? [...(tagMap.get(sel) ?? [])] : [];

  const openNote = (p: string) => {
    onOpenPath(p);
    onClose();
  };

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <div className="panel mistake-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title"><IconTag /> 标签 <span className="muted">· {tags.length} 个</span></span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="tag-search">
          <input
            className="todo-input"
            placeholder="筛选标签…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {sel && (
            <button className="btn-small" onClick={() => setSel(null)}>返回全部标签</button>
          )}
        </div>

        <div className="panel__body mistake-list">
          {!sel ? (
            shownTags.length === 0 ? (
              <div className="mistake-empty">
                <h2>没有匹配的标签</h2>
                <p className="muted">笔记里的 #标签 会在这里聚合。</p>
              </div>
            ) : (
              <div className="tag-cloud">
                {shownTags.map(([t, set]) => (
                  <button
                    key={t}
                    className="tag-chip"
                    onClick={() => setSel(t)}
                    title={`${set.size} 篇笔记`}
                  >
                    #{t} <span className="muted">{set.size}</span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <>
              <h4 className="tag-note-list-title">#{sel} · {selNotes.length} 篇</h4>
              {selNotes.map((p) => {
                const { title } = parseFrontmatter(docs.get(p) ?? '');
                const label = title || p.replace(/\.md$/, '').split('/').pop() || p;
                return (
                  <div key={p} className="mistake-item tag-note-item" onClick={() => openNote(p)} {...clickable(`打开笔记：${label}`)}>
                    <div className="mistake-item-main">
                      <div className="panel__title mistake-title">{label}</div>
                      <div className="mistake-meta muted">{p}</div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
