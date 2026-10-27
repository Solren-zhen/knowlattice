/**
 * 生词本视图：收词 → 复习。
 *
 * 交互按「不打断阅读」设计：收词只有一个输入行（词 + 可选释义），批量收词支持整段粘贴
 * （一行一个，能拆出「英文 —— 中文」就自动分列）。复习是翻卡自评，四档与间隔复习面板一致。
 */
import { useMemo, useRef, useState } from 'react';
import { useEsc } from './useEsc';
import { useDialogDrag } from './usePanelDrag';
import { toast } from '../core/feedback';
import {
  addVocab,
  collectFromText,
  loadVocab,
  rateVocab,
  removeVocab,
  vocabDueQueue,
  vocabStats,
  type VocabEntry,
} from '../core/vocab';
import type { Rating } from '../core/srs';

interface Props {
  onClose: () => void;
  /** 从笔记/题库过来时带上来源，方便日后回原文核对 */
  src?: string;
}

const RATINGS: Array<{ key: Rating; label: string }> = [
  { key: 'again', label: '不认识' },
  { key: 'hard', label: '勉强' },
  { key: 'good', label: '认识' },
  { key: 'easy', label: '太熟' },
];

export default function VocabView({ onClose, src }: Props) {
  const [entries, setEntries] = useState<VocabEntry[]>(loadVocab);
  const [term, setTerm] = useState('');
  const [def, setDef] = useState('');
  const [bulk, setBulk] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [queue, setQueue] = useState<VocabEntry[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [shown, setShown] = useState(false);
  const [q, setQ] = useState('');

  const stats = useMemo(() => vocabStats(entries), [entries]);
  useEsc(onClose, true);

  const refresh = () => setEntries(loadVocab());

  const addOne = () => {
    if (!term.trim()) return;
    const r = addVocab(term, def, src);
    if (!r.ok) {
      toast('收词失败：本地存储写不进去（可能已满）', 'err');
      return;
    }
    toast(r.added ? `已收词：${term.trim()}` : '这个词已在生词本里，释义已更新', 'ok', 2200);
    setTerm('');
    setDef('');
    refresh();
  };

  const addBulk = () => {
    const r = collectFromText(bulk, src);
    if (!r.added && !r.skipped) {
      toast('这段文字里没有可收的词', 'info', 2600);
      return;
    }
    toast(`收了 ${r.added} 个词${r.skipped ? `，${r.skipped} 条写入失败` : ''}`, r.skipped ? 'err' : 'ok', 3200);
    setBulk('');
    refresh();
  };

  const startReview = () => {
    const q = vocabDueQueue(entries);
    if (!q.length) {
      toast('今天没有到期生词：先收几个词，或者等明天再来', 'info', 3200);
      return;
    }
    setQueue(q);
    setQIdx(0);
    setShown(false);
    setReviewing(true);
  };

  const rate = (r: Rating) => {
    const cur = queue[qIdx];
    if (cur) rateVocab(cur, r);
    if (qIdx + 1 >= queue.length) {
      setReviewing(false);
      refresh();
      toast(`这一轮复习完了：${queue.length} 个词`, 'ok', 3000);
      return;
    }
    setQIdx((i) => i + 1);
    setShown(false);
  };

  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDialogDrag(() => panelRef.current);

  if (reviewing) {
    const cur = queue[qIdx];
    return (
      <div className="panel-backdrop" onClick={onClose}>
        <div
          ref={panelRef}
          className="panel quiz-panel"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="生词复习"
          onPointerDown={drag.onPointerDown}
          style={drag.style}
        >
          <div className="panel__head quiz-header">
            <span className="panel__title">生词 · 第 {qIdx + 1} / {queue.length} 个</span>
            <button className="btn-small" onClick={() => { setReviewing(false); refresh(); }}>退出复习</button>
          </div>
          <div className="panel__body quiz-body">
            <p className="quiz-stem">{cur?.term}</p>
            {shown ? (
              <div className="quiz-answer"><b>释义</b><p>{cur?.def || '（还没写释义）'}</p></div>
            ) : (
              <p className="muted">先回想它的意思，再翻面自评。</p>
            )}
          </div>
          <div className="quiz-footer">
            {shown ? (
              RATINGS.map((r) => (
                <button key={r.key} className="btn-small" onClick={() => rate(r.key)}>{r.label}</button>
              ))
            ) : (
              <button className="btn-primary" onClick={() => setShown(true)}>显示释义</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="panel quiz-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="生词本"
        onPointerDown={drag.onPointerDown}
        style={drag.style}
      >
        <div className="panel__head quiz-header">
          <span className="panel__title">生词本</span>
          <span className="muted">{stats.total} 词 · 已复习 {stats.learned} · 到期 {stats.dueNow}</span>
          <button className="btn-small" onClick={startReview} disabled={!stats.total}>开始复习</button>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="panel__body quiz-body">
          <div className="quiz-actions">
            <input
              className="qs-input"
              placeholder="词（英文术语 / 中文简写）"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addOne(); }}
            />
            <input
              className="qs-input"
              placeholder="释义（可留空，以后再补）"
              value={def}
              onChange={(e) => setDef(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addOne(); }}
            />
            <button className="btn-small" onClick={addOne} disabled={!term.trim()}>收词</button>
          </div>

          <details className="quiz-group">
            <summary className="quiz-group-head">批量粘贴（一行一个，「英文 —— 中文」会自动分列）</summary>
            <textarea
              className="qs-input"
              rows={5}
              placeholder={'hepatomegaly 肝肿大\nsplenomegaly——脾肿大'}
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            />
            <button className="btn-small" onClick={addBulk} disabled={!bulk.trim()}>全部收进生词本</button>
          </details>

          {entries.length > 6 && (
            <input
              className="qs-input"
              placeholder="在词表里找…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}

          {entries.length === 0 ? (
            <p className="muted">还没有词。在笔记里选中术语，右键「收进生词本」，或直接在上面输入。</p>
          ) : (
            <div className="exam-list">
              {entries
                .filter((e) => !q.trim() || `${e.term} ${e.def}`.toLowerCase().includes(q.trim().toLowerCase()))
                .map((e) => (
                <div key={e.term} className="exam-row">
                  <div className="exam-row-main">
                    <b>{e.term}</b>
                    {e.def ? <span className="muted"> · {e.def}</span> : <span className="muted"> · 待补释义</span>}
                    {e.src ? <span className="muted"> · 来自 {e.src}</span> : null}
                  </div>
                  <button
                    className="btn-small danger"
                    onClick={() => { removeVocab(e.term); refresh(); }}
                    aria-label={`删除 ${e.term}`}
                  >删除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
