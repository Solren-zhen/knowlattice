/**
 * M7 · 错题本 + 薄弱点热力图：
 * 复习中点「忘了」自动收录；顶部按章节聚合失败次数生成热力条，
 * 点击章节可过滤列表，点击条目直达对应笔记，✕ 清除记录。
 */
import { useMemo, useState } from 'react';
import { useEsc } from './useEsc';
import { loadMistakes, clearMistake, chapterHeat, reasonCounts, setMistakeReason, MISTAKE_REASONS, MISTAKE_REASON_LABELS, type MistakeMap } from '../core/mistakes';
import { IconClose } from './icons';
import { clickable } from './a11y';

interface Props {
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

export default function MistakeBook({ onOpenPath, onClose }: Props) {
  // Esc 关闭（接进全局 Esc 栈，与其余面板一致）
  useEsc(onClose);
  const [mistakes, setMistakes] = useState<MistakeMap>(loadMistakes);
  const [filterChapter, setFilterChapter] = useState<string | null>(null);

  const heat = useMemo(() => chapterHeat(mistakes), [mistakes]);
  const maxCount = Math.max(1, ...heat.map((h) => h.count));

  // 错因分布按全表算（不随章节筛选变），并随 mistakes 重算：
  // setMistakeReason/clearMistake 会把模块缓存一起换掉，所以这里读得到刚写入的值。
  // 依赖 mistakes 是刻意的（reasonCounts 读的是模块缓存，但它的变化只由 mistakes 引起）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reasons = useMemo(() => reasonCounts(), [mistakes]);
  const total = Object.keys(mistakes).length;
  const unlabeled = reasons[0]?.unlabeled ?? 0;

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
              <span className="mistake-filter muted" onClick={() => setFilterChapter(null)} {...clickable('清除章节筛选')}>
                　当前章节：{filterChapter} ✕
              </span>
            )}
          </span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
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
                <div key={chapter} className="heat-row" onClick={() => toggleFilter(chapter)} {...clickable(`按章节筛选：${chapter}`)}>
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

            {/* 错因分布：堆叠条给一眼比例，图例给绝对数（只画条读不出 3 和 30 的差别） */}
            <div className="reason-section">
              <div className="heat-title">错因分布</div>
              <div className="reason-bar">
                {reasons.map(({ reason, count }) =>
                  count > 0 ? (
                    <span
                      key={reason}
                      className={`reason-seg reason-seg--${reason}`}
                      style={{ flexGrow: count }}
                      title={`${MISTAKE_REASON_LABELS[reason]} ${count}`}
                    />
                  ) : null
                )}
                {unlabeled > 0 && (
                  <span className="reason-seg reason-seg--none" style={{ flexGrow: unlabeled }} title={`未标注 ${unlabeled}`} />
                )}
              </div>
              <div className="reason-legend">
                {reasons.map(({ reason, count }) => (
                  <span key={reason} className="reason-legend-item">
                    <i className={`reason-dot reason-seg--${reason}`} />
                    {MISTAKE_REASON_LABELS[reason]}
                    <b>{count}</b>
                    <span className="muted">{total ? Math.round((count / total) * 100) : 0}%</span>
                  </span>
                ))}
                <span className="reason-legend-item">
                  <i className="reason-dot reason-seg--none" />
                  未标注<b>{unlabeled}</b>
                  <span className="muted">{total ? Math.round((unlabeled / total) * 100) : 0}%</span>
                </span>
              </div>
            </div>

            <div className="panel__body mistake-list">
              {items.map((r) => (
                <div key={r.path} className="mistake-item" onClick={() => onOpenPath(r.path)} {...clickable(`打开错题：${r.title}`)}>
                  <div className="mistake-item-main">
                    <div className="panel__title mistake-title">{r.title}</div>
                    <div className="mistake-meta muted">
                      {r.chapter} · 错 {r.count} 次 · {fmtTime(r.lastFailedAt)}
                    </div>
                    {/* 错因标注：点已选中的那一档 = 取消（回到未标注）。
                        容器上拦掉 click/keydown 冒泡，免得标注顺手把笔记打开了。 */}
                    <div
                      className="reason-pick"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {MISTAKE_REASONS.map((reason) => (
                        <button
                          key={reason}
                          type="button"
                          className={`reason-chip${r.reason === reason ? ' on' : ''}`}
                          aria-pressed={r.reason === reason}
                          onClick={() => setMistakes(setMistakeReason(r.path, r.reason === reason ? null : reason))}
                        >
                          {MISTAKE_REASON_LABELS[reason]}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={`reason-chip reason-chip--none${r.reason ? '' : ' on'}`}
                        aria-pressed={!r.reason}
                        onClick={() => setMistakes(setMistakeReason(r.path, null))}
                      >
                        未标注
                      </button>
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
                    <IconClose />
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
