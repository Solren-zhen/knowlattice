/**
 * M7 · 错题本 + 薄弱点热力图：
 * 复习中点「忘了」自动收录；顶部按章节聚合失败次数生成热力条，
 * 点击章节可过滤列表，点击条目直达对应笔记，✕ 清除记录。
 */
import { useMemo, useState } from 'react';
import { loadMistakes, clearMistake, chapterHeat, type MistakeMap } from '../core/mistakes';

interface Props {
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

export default function MistakeBook({ onOpenPath, onClose }: Props) {
  const [mistakes, setMistakes] = useState<MistakeMap>(loadMistakes);
  const [filterChapter, setFilterChapter] = useState<string | null>(null);

  const heat = useMemo(() => chapterHeat(mistakes), [mistakes]);
  const maxCount = Math.max(1, ...heat.map((h) => h.count));

  const items = useMemo(() => {
    const list = Object.values(mistakes).sort((a, b) => b.lastFailedAt - a.lastFailedAt);
    return filterChapter ? list.filter((r) => r.chapter === filterChapter) : list;
  }, [mistakes, filterChapter]);

  const fmtTime = (t: number) => {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const toggleFilter = (chapter: string) =>
    setFilterChapter((cur) => (cur === chapter ? null : chapter));

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <div className="panel mistake-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span>
            错题本 · {items.length} 条
            {filterChapter && (
              <span className="mistake-filter muted" onClick={() => setFilterChapter(null)}>
                　当前章节：{filterChapter} ✕
              </span>
            )}
          </span>
          <button className="btn-small" onClick={onClose}>关闭</button>
        </div>

        {heat.length === 0 ? (
          <div className="mistake-empty">
            <h2>暂无错题</h2>
            <p className="muted">复习时点「忘了」会自动收录到这里，按章节统计薄弱点。</p>
          </div>
        ) : (
          <>
            <div className="heat-section">
              <div className="heat-title">薄弱点热力图</div>
              {heat.map(({ chapter, count }) => (
                <div key={chapter} className="heat-row" onClick={() => toggleFilter(chapter)}>
                  <span className="heat-label">{chapter}</span>
                  <div className="heat-track">
                    <div
                      className={`heat-fill ${filterChapter === chapter ? 'active' : ''}`}
                      style={{ width: `${Math.max(4, (count / maxCount) * 100)}%` }}
                    />
                  </div>
                  <span className="heat-count">{count} 次</span>
                </div>
              ))}
            </div>

            <div className="panel__body mistake-list">
              {items.map((r) => (
                <div key={r.path} className="mistake-item" onClick={() => onOpenPath(r.path)}>
                  <div className="mistake-item-main">
                    <div className="panel__title mistake-title">{r.title}</div>
                    <div className="mistake-meta muted">
                      {r.chapter} · 错 {r.count} 次 · {fmtTime(r.lastFailedAt)}
                    </div>
                  </div>
                  <button
                    className="btn-icon"
                    title="已掌握，移出错题本"
                    aria-label="移出错题本"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMistakes(clearMistake(r.path));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}