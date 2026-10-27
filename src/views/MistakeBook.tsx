/**
 * M7 · 错题本 + 薄弱点热力图：
 * 复习中点「忘了」自动收录；顶部按章节聚合失败次数生成热力条，
 * 点击章节可过滤列表，点击条目直达对应笔记，✕ 清除记录。
 */
import { useMemo, useState } from 'react';
import { useEsc } from './useEsc';
import {
  loadMistakes,
  clearMistake,
  chapterHeat,
  reasonCounts,
  setMistakeReason,
  mistakePools,
  dueMistakes,
  stageOf,
  isArchived,
  MISTAKE_REASONS,
  MISTAKE_REASON_LABELS,
  MISTAKE_STAGE_LABELS,
  type MistakeMap,
} from '../core/mistakes';
import { reviewPressure } from '../core/reviewPressure';
import { needsAttention, severityHint, severityInfo } from '../core/mistakeSeverity';
import { activeBacklog, forecastBacklog, forecastLine, netByDay } from '../core/backlogForecast';
import { IconClose } from './icons';
import { clickable } from './a11y';
import type { QuoteSelection } from './AiAgentPanel';

interface Props {
  onOpenPath: (path: string) => void;
  onClose: () => void;
  /** 与 AI 笔记联动：把这条错题交给 AI 归因；不传则不显示入口 */
  onAskAi?: (quote: QuoteSelection) => void;
}

export default function MistakeBook({ onOpenPath, onClose, onAskAi }: Props) {
  // Esc 关闭（接进全局 Esc 栈，与其余面板一致）
  useEsc(onClose);
  const [mistakes, setMistakes] = useState<MistakeMap>(loadMistakes);
  const [filterChapter, setFilterChapter] = useState<string | null>(null);
  // 「只看错过 ≥ N 次」的阈值：1 = 全部（默认，渲染结果与加这个过滤条之前逐像素一致）
  const [minCount, setMinCount] = useState(1);

  const heat = useMemo(() => chapterHeat(mistakes), [mistakes]);
  const maxCount = Math.max(1, ...heat.map((h) => h.count));

  // 错因分布按全表算（不随章节筛选变），并随 mistakes 重算：
  // setMistakeReason/clearMistake 会把模块缓存一起换掉，所以这里读得到刚写入的值。
  // 依赖 mistakes 是刻意的（reasonCounts 读的是模块缓存，但它的变化只由 mistakes 引起）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reasons = useMemo(() => reasonCounts(), [mistakes]);
  // 门控池统计同样读模块缓存，依赖 mistakes（写入方都会换掉它）
  const pools = useMemo(() => mistakePools(Date.now(), mistakes), [mistakes]);
  // 压力熵：今天/明天/本周三档加权，回答「队列在堆还是在清」
  const pressure = useMemo(() => reviewPressure(Date.now(), mistakes), [mistakes]);
  // 清仓预测：用近 14 天的净清速率外推，并给一个随波动率变宽的区间
  const forecast = useMemo(() => {
    const now = Date.now();
    return forecastBacklog(netByDay(now, mistakes), activeBacklog(mistakes));
  }, [mistakes]);
  // 今日该考：到期且未归档。「已归档」不进这个数，正是门控生效的表现
  const dueNow = useMemo(() => dueMistakes(Date.now(), mistakes), [mistakes]);
  const total = Object.keys(mistakes).length;
  const unlabeled = reasons[0]?.unlabeled ?? 0;

  const items = useMemo(() => {
    const list = Object.values(mistakes).sort((a, b) => b.lastFailedAt - a.lastFailedAt);
    return filterChapter ? list.filter((r) => r.chapter === filterChapter) : list;
  }, [mistakes, filterChapter]);

  /**
   * 阈值过滤只作用于**渲染列表**：保持 items 的原顺序与章节筛选语义，
   * 顶部的「错题本 · N 条」与错因分布的占比仍按全表算——
   * 否则用户会以为错题真的变少了。
   */
  const shown = useMemo(
    // minCount === 1 时原样返回 items（不复制数组）：默认视图与加过滤条之前完全一致，
    // 连脏数据里 count <= 0 的记录也照旧露出——「全部」这一档就该是什么都不筛。
    () => (minCount > 1 ? items.filter((r) => r.count >= minCount) : items),
    [items, minCount],
  );
  // 被隐藏的条数以「本章节筛选后的条数」为基数：全表 total 会把别的章节一起算进来，
  // 章内一条都没被隐藏时也会报「另有 N 条」，数字对不上用户眼前这一屏。
  const hidden = items.length - shown.length;

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
            <span className="mistake-gate muted">
              　今日该巩固 {dueNow.length} 条
              {pools.overdue > 0 ? `（逾期 ${pools.overdue}）` : ''}
              　已归档 {pools.archived}
            </span>
            <span className="mistake-gate muted" title={pressure.line}>
              　熵 {pressure.metrics.entropyPercent}% · 明天 {pressure.metrics.tomorrow} 条 · {pressure.trendLabel}
            </span>
            <span className="mistake-gate muted" title="按近 14 天的净清速率外推，区间随波动率变宽">
              　{forecastLine(forecast)}
            </span>
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

            {/* 「错题热力」入口：反复错的题才需要重点复盘，一次就过的错题不占视野 */}
            <div className="mistake-filter-row" role="group" aria-label="按累计答错次数过滤">
              <span className="muted">只看错过</span>
              {[1, 2, 3, 5].map((n) => (
                <button
                  key={n}
                  className={`chip${minCount === n ? ' on' : ''}`}
                  aria-pressed={minCount === n}
                  onClick={() => setMinCount(n)}
                >
                  {n === 1 ? '全部' : `≥${n} 次`}
                </button>
              ))}
              {minCount > 1 && hidden > 0 && (
                <span className="mistake-hidden muted">另有 {hidden} 条低于该阈值</span>
              )}
            </div>

            <div className="panel__body mistake-list">
              {shown.map((r, i) => (
                <div
                  key={r.path}
                  className={`mistake-item stagger-item${isArchived(r) ? ' mistake-item--archived' : ''}`}
                  style={{ ['--i' as string]: Math.min(i, 12) }}
                  onClick={() => onOpenPath(r.path)}
                  {...clickable(`打开错题：${r.title}`)}
                >
                  <div className="mistake-item-main">
                    <div className="panel__title mistake-title">{r.title}</div>
                    <div className="mistake-meta muted">
                      {r.chapter} · 错 {r.count} 次 · {fmtTime(r.lastFailedAt)} ·{' '}
                      <span className={`mistake-stage mistake-stage--${stageOf(r)}`}>
                        {MISTAKE_STAGE_LABELS[stageOf(r)]}
                      </span>
                      {/* 严重度：从记录本身推（错几次 / 回炉几次 / 有没有推进过），不是后端标签 */}
                      {needsAttention(r) && (
                        <span
                          className={'mistake-severity mistake-severity--' + severityInfo(r).verdict}
                          title={severityHint(r)}
                        >
                          　{severityInfo(r).label}
                        </span>
                      )}
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
                      {/* 与 AI 笔记联动：这条错题（笔记 + 次数 + 已标错因）交给 AI 归因。
                          预填 /错题归因 —— 该命令模板本来就要求「把错题贴进来」。 */}
                      {onAskAi && (
                        <button
                          type="button"
                          className="reason-chip"
                          title="把这条错题交给 AI 笔记做归因（预填 /错题归因）"
                          onClick={() => onAskAi({
                            text: [
                              `【错题】${r.title}（${r.chapter}）`,
                              `笔记：${r.path}`,
                              `累计答错：${r.count} 次`,
                              `已标错因：${r.reason ? MISTAKE_REASON_LABELS[r.reason] : '未标注'}`,
                            ].join('\n'),
                            path: r.path,
                            ask: '/错题归因 ',
                          })}
                        >
                          问 AI 归因
                        </button>
                      )}
                      {/* 变式题：把「记住了这个答案」练成「抓住了考点」。
                          只传题面与笔记路径，题干细节让 AI 自己去库里找，避免引用过期快照。 */}
                      {onAskAi && (
                        <button
                          type="button"
                          className="reason-chip"
                          title="按这条错题的考点出 3 道变式题（预填 /变式）"
                          onClick={() => onAskAi({
                            text: [
                              '【要出变式题的错题】' + r.title,
                              '章节：' + r.chapter,
                              '笔记：' + r.path,
                              '累计答错：' + r.count + ' 次',
                              '已标错因：' + (r.reason ? MISTAKE_REASON_LABELS[r.reason] : '未标注'),
                              '请先用 search_notes 找到这篇笔记里的题干，再出变式。',
                            ].join('\n'),
                            path: r.path,
                            ask: '/变式 ',
                          })}
                        >
                          AI 变式
                        </button>
                      )}
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
              {shown.length === 0 && hidden > 0 && (
                <p className="muted">没有错过 ≥{minCount} 次的题；把阈值调小看看。</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
