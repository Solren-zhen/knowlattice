/**
 * M6 · 复习模式界面：
 * 正面 = 小节标题 + 属性键（不含值）；有口诀时先只显示口诀；
 * 背面 = 该小节正文。评分按钮走 FSRS 调度。
 *
 * M6+ · 粒度：一张卡 = 一个知识点（笔记里的 `##`/`###` 小节）。
 * 建卡规则见 core/srsCards.ts；旧数据（一篇一卡）由首张卡继承调度，不会丢进度。
 *
 * M6++ · 卡片可自定义：正面/背面可改写、可整张删除，都独立于笔记内容之外
 * （覆盖值存 core/cardEdits.ts，笔记文件一个字节都不动，删掉覆盖即回原文）。
 * 评分快捷键：A 忘了 / S 困难 / D 良好 / F 简单（只在显示答案后生效，输入框里不抢键）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc, isEditable } from './useEsc';
import { applyReview, dueQueue, loadCards, srsStats, scheduleOf, exportSrsJson, importSrsFromJson, type Rating } from '../core/srs';
import { buildCards, type ReviewCard } from '../core/srsCards';
import { applyCardEdits, deleteCard, deletedKeys, loadCardEdits, restoreCard, saveCardEdit, type CardEditMap } from '../core/cardEdits';
import { toast, confirmBox } from '../core/feedback';
import { markStudy } from '../core/stats';
import { parseFrontmatterCached } from '../core/parser';
import { recordMistake } from '../core/mistakes';
import { notesToAnki, exportApkg, downloadFile } from '../core/anki';
import { countCloze, maskCloze, revealCloze } from '../core/cloze';
import { applyDailyCap, effectiveDailyCap, loadPlan } from '../core/reviewPlan';
import Preview from './Preview';
import type { QuoteSelection } from './AiAgentPanel';

interface Props {
  paths: string[];
  docs: Map<string, string>;
  resolve: (name: string) => string | null;
  onOpenLink: (name: string) => void;
  onClose: () => void;
  onOpenPath: (path: string) => void;
  /** 与 AI 笔记联动：把这张复习卡交给 AI 讲透；不传则不显示入口 */
  onAskAi?: (quote: QuoteSelection) => void;
}

/** 评分快捷键：A 忘了 / S 困难 / D 良好 / F 简单（左手基准位，与格式键同一思路） */
const RATE_KEYS: Record<string, Rating> = { a: 'again', s: 'hard', d: 'good', f: 'easy' };

/** 卡键 → 好认的一行字（`路径#小节` → `笔记标题 · 小节`；标题取 H1，退到文件名） */
function keyLabel(key: string, docs: Map<string, string>): string {
  const i = key.indexOf('#');
  const path = i < 0 ? key : key.slice(0, i);
  const head = i < 0 ? '' : key.slice(i + 1);
  const title = parseFrontmatterCached(path, docs.get(path) ?? '').title;
  const name = (title || path.replace(/\.md$/, '').split('/').pop() || path).trim();
  return head ? `${name} · ${head}` : name;
}

export default function ReviewView({ paths, docs, resolve, onOpenLink, onClose, onOpenPath, onAskAi }: Props) {
  // 全库建卡（纯函数，一篇笔记可能出多张）→ 套上自定义正/背面、剔除已删的卡
  const [edits, setEdits] = useState<CardEditMap>(() => loadCardEdits());
  const cards = useMemo(() => applyCardEdits(buildCards(paths, docs), edits), [paths, docs, edits]);
  const cardMap = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);
  // 队列只存卡键：编辑/删除后卡对象会变（甚至消失），键是稳定的
  // 每日复习上限：默认 0 = 不限制，由「学习统计」面板里的复习计划显式开启（见 core/reviewPlan.ts）
  const [order, setOrder] = useState<string[]>(() => {
    const queue = dueQueue(cards);
    const cap = effectiveDailyCap(loadPlan(), queue.length);
    return applyDailyCap(queue, cap).map((c) => c.key);
  });
  const srsImportRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [editing, setEditing] = useState<{ front: string; back: string } | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  // 已删除的卡键仍在队列里，取卡时自动跳过
  const remaining = useMemo(() => order.filter((k) => cardMap.has(k)), [order, cardMap]);
  const card: ReviewCard | null = remaining.length ? cardMap.get(remaining[0])! : null;
  const removed = useMemo(() => deletedKeys(edits), [edits]);

  // Esc 分层：编辑器开着先关编辑器，再按一次才退出复习（输入框里先退出输入框）
  useEsc((e) => {
    if (isEditable(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    if (editing) {
      setEditing(null);
      return;
    }
    onClose();
  });

  // 笔记级信息（章节/来源/真题）从整篇解析里取；解析器带缓存，切卡不会重复解析
  const meta = useMemo(
    () => (card ? parseFrontmatterCached(card.path, docs.get(card.path) ?? '').meta : null),
    [card, docs]
  );
  // 每篇笔记的卡数：一次 O(全库卡数) 建表，之后翻面/切卡都是 O(1) 查表。
  // 原来这里是每次渲染都 cards.filter(...) 全表扫一遍（翻面、编辑输入框都会触发重渲染）。
  // 数值与那句 filter 完全等价（同一批 cards，按 path 计数），只是不再逐次重算。
  const cardCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [cards]);
  const noteCardCount = card ? cardCountByPath.get(card.path) ?? 0 : 0;
  // 自定义正/背面优先；没自定义就用笔记切出来的原文
  const frontText = card ? card.front ?? (card.heading || card.noteTitle) : '';
  const backText = card ? card.back ?? card.body : '';
  // 挖空只影响呈现，不动卡键（见 core/cloze.ts 的设计约束）
  const clozeCount = countCloze(backText);
  const clozeMasked = clozeCount ? maskCloze(backText) : backText;
  const backRevealed = clozeCount ? revealCloze(backText) : backText;
  const hasMnemonic = /口诀:[ \t]*\S/.test(backText);
  const showMnemonicOnly = hasMnemonic && !revealed;

  // 统计：依赖里带 `order` 是必须的——srsStats 读的是 localStorage 里的调度表，不是 cards 本身
  // （见 core/srs.ts），而写完调度表的两处（评分 / 导入复习数据）都会换掉 order 的身份，
  // 所以「库内 x/y 张卡已在调度中」仍会立即更新；翻面、编辑输入框这些与调度无关的重渲染则不再全表扫。
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- order 不在回调体里，但它是「调度表被写过」的信号，必须留
  const stats = useMemo(() => srsStats(cards), [cards, order]);

  const rate = (r: Rating) => {
    if (!card) return;
    applyReview(card, r);
    markStudy(); // 打卡
    // M7：点「忘了」自动收录进错题本（薄弱点统计）。存整篇：错题本按笔记展示，
    // 只存小节会把那篇的错题内容截断成片段。
    if (r === 'again') recordMistake(card.path, docs.get(card.path) ?? card.body);
    setOrder((q) => {
      // again：10 分钟后再来一次，放回队尾
      if (r === 'again') return [...q.slice(1), q[0]];
      return q.slice(1);
    });
    setRevealed(false);
    setEditing(null);
    setDone((d) => d + 1);
  };

  // 快捷键：空格显示答案，A 忘了 / S 困难 / D 良好 / F 简单；都不抢输入框的键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || !card) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      // 答案还没翻开时空格 = 显示答案（翻开之后空格不响应，免得手一抖把卡评掉）
      if (!revealed) {
        if (e.key === ' ') {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      const r = RATE_KEYS[e.key.toLowerCase()];
      if (!r) return;
      e.preventDefault();
      rate(r);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cardCount = card ? scheduleOf(loadCards(), card) : undefined;

  const saveEdit = () => {
    if (!card || !editing) return;
    setEdits(saveCardEdit(card.key, { front: editing.front, back: editing.back }));
    setEditing(null);
    toast('已保存这张卡片的自定义内容（笔记原文未改动）。', 'ok');
  };

  const clearEdit = () => {
    if (!card) return;
    setEdits(saveCardEdit(card.key, { front: '', back: '' }));
    setEditing(null);
    toast('已恢复笔记原文。', 'ok');
  };

  const removeCard = async () => {
    if (!card) return;
    const ok = await confirmBox({
      title: '删除这张卡片？',
      detail: '它不再进复习队列；笔记内容与已学进度都保留，之后可在「已删卡片」里恢复。',
      danger: true,
      okText: '删除卡片',
    });
    if (!ok) return;
    setEdits(deleteCard(card.key));
    setRevealed(false);
    setEditing(null);
    toast('已删除这张卡片，可在「已删卡片」恢复。', 'ok');
  };

  return (
    <div className="panel panel--full review-overlay">
      <div className="panel__head review-header">
        <button className="btn-small" onClick={onClose} title="返回主页面">← 返回主页面</button>
        <span>
          复习模式 · 队列剩 {remaining.length} 张 · 本次已复习 {done} 张
          <span className="muted">　(库内 {stats.learned}/{stats.total} 张卡已在调度中)</span>
        </span>
        {removed.length > 0 && (
          <button className="btn-small" onClick={() => setShowDeleted((v) => !v)} title="查看并恢复被删除的卡片">
            已删卡片 ({removed.length})
          </button>
        )}
        <button className="btn-small" onClick={onClose}>退出复习</button>
        <button
          className="btn-small"
          title="导出全库笔记为 Anki 导入文件（.txt，可在 Anki「文件→导入」使用）"
          onClick={() => downloadFile('knowlattice-笔记-anki.txt', notesToAnki(docs))}
        >
          导出 Anki (.txt)
        </button>
        <button
          className="btn-small"
          title="导出全库笔记为真 Anki 包（.apkg，可直接导入 Anki）"
          onClick={async () => {
            try {
              const n = await exportApkg(docs);
              toast(`已导出 ${n} 张卡片为 .apkg，可直接导入 Anki。`, 'ok');
            } catch (e) {
              toast(`导出失败：${(e as Error).message}`, 'err');
            }
          }}
        >
          导出 .apkg
        </button>
        <button
          className="btn-small"
          title="导出复习调度数据（.json，含卡片自定义，可跨设备/备份恢复进度）"
          onClick={() => downloadFile('knowlattice-复习数据.json', exportSrsJson())}
        >
          导出复习数据
        </button>
        <button className="btn-small" title="导入复习调度数据（.json，支持整包备份或单独复习状态）" onClick={() => srsImportRef.current?.click()}>
          导入复习数据
        </button>
        <input
          ref={srsImportRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              const reader = new FileReader();
              reader.onload = async () => {
                try {
                  const n = importSrsFromJson(reader.result as string);
                  setOrder(dueQueue(cards).map((c) => c.key)); // 刷新队列
                  toast(`已导入 ${n} 条复习数据`, 'ok');
                } catch (err) {
                  toast(`导入失败：${(err as Error).message}`, 'err');
                }
              };
              reader.readAsText(f);
            }
            e.target.value = '';
          }}
        />
      </div>

      {showDeleted && removed.length > 0 && (
        <div className="card-edit card-edit--list">
          <div className="card-edit-head">已删除的卡片（{removed.length}）· 恢复后回到原队列与原进度</div>
          {removed.map((k, i) => (
            <div key={k} className="card-edit-row stagger-item" style={{ ['--i' as string]: Math.min(i, 12) }}>
              <span>{keyLabel(k, docs)}</span>
              <button
                className="btn-small"
                onClick={() => {
                  setEdits(restoreCard(k));
                  toast('已恢复这张卡片。', 'ok');
                }}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      )}

      {!card ? (
        <div className="review-card done">
          <h2>今日队列已完成！</h2>
          <p className="muted">
            共复习 {done} 次。新笔记加入后自动进入复习队列。
            {removed.length > 0 ? `（另有 ${removed.length} 张卡片被你删除，可在顶部「已删卡片」恢复）` : ''}
          </p>
        </div>
      ) : editing ? (
        <div className="review-card">
          <h2 className="card-edit-title">编辑卡片</h2>
          <p className="muted">改动只作用于这张卡，笔记文件不会被改；清空某一栏 = 那一面回到笔记原文。</p>
          <label className="card-edit-label" htmlFor="card-edit-front">正面（问题）</label>
          <textarea
            id="card-edit-front"
            className="card-edit-input"
            rows={2}
            value={editing.front}
            placeholder={card.heading || card.noteTitle}
            onChange={(e) => setEditing({ ...editing, front: e.target.value })}
          />
          <label className="card-edit-label" htmlFor="card-edit-back">背面（答案）</label>
          <textarea
            id="card-edit-back"
            className="card-edit-input"
            rows={10}
            value={editing.back}
            placeholder="留空 = 用笔记原文"
            onChange={(e) => setEditing({ ...editing, back: e.target.value })}
          />
          <div className="card-edit-actions">
            <button className="btn-primary" onClick={saveEdit}>保存</button>
            <button className="btn-small" onClick={() => setEditing(null)}>取消</button>
            <button className="btn-small" onClick={clearEdit} disabled={!card.front && !card.back}>恢复笔记原文</button>
          </div>
          <details className="card-edit-orig">
            <summary>看笔记原文（只读）</summary>
            <div className="review-back">
              <Preview content={card.body} resolve={resolve} onOpenLink={onOpenLink} />
            </div>
          </details>
        </div>
      ) : (
        <div className="review-card">
          <div className="review-front">
            {/* 小节卡：标题就是问题，不能打码；整篇卡仍用模糊标题（靠属性键回忆）。
                自定义过正面就以用户写的为准，同样不打码。 */}
            <h2 className={card.heading || revealed || card.front ? '' : 'blurred-title'}>
              {frontText}
            </h2>
            {/* 面包屑：笔记 › 章节 › 小节。点击笔记名可跳回原文。
                打码条件必须与上面的 h2 完全一致：整篇卡未翻面时标题是糊的（靠属性键回忆），
                面包屑若把同一个笔记名明文写出来，等于直接把答案给了人。
                但整篇卡的正面标题本来就等于笔记名——那一格改成明确的「打开笔记」入口：
                既不重复（同一段文字在 DOM 里出现两次会打架），也不必打码
                （「打开笔记」四个字不含任何答案信息，糊掉它只会让人看不懂按钮）。 */}
            <nav className="review-crumbs" aria-label="卡片来源路径">
              <button
                type="button"
                className={`crumb crumb--link${
                  card.noteTitle !== frontText && !(card.heading || revealed || card.front) ? ' blurred-title' : ''
                }`}
                onClick={() => card.path && onOpenPath(card.path)}
                disabled={!card.path}
                title={card.path ? '打开这篇笔记' : '这张卡没有对应笔记'}
              >
                {card.noteTitle !== frontText ? card.noteTitle : '打开笔记'}
              </button>
              {meta?.chapter ? (
                <>
                  <span className="crumb-sep" aria-hidden>›</span>
                  <span className="crumb crumb--static">{meta.chapter}</span>
                </>
              ) : null}
              {/* 小节只在正面不是小节标题时补出来（避免与 H2 重复） */}
              {card.heading && card.front ? (
                <>
                  <span className="crumb-sep" aria-hidden>›</span>
                  <span className="crumb crumb--static">{card.heading}</span>
                </>
              ) : null}
              {noteCardCount > 1 ? <span className="crumb-note">共 {noteCardCount} 节</span> : null}
              {meta?.source ? <span className="crumb-note">来源: {meta.source}</span> : null}
              {card.front || card.back ? <span className="crumb-note">已自定义</span> : null}
            </nav>
            {meta && meta.exam.length > 0 && (
              <p className="exam-hint">历年真题: {meta.exam.join(' · ')}</p>
            )}
            {!revealed && (
              <>
                {/* 自定义过正面就不再给笔记的属性键提示：那是另一套问题的线索 */}
                {!card.front && card.hints.length > 0 && (
                  <div className="prop-keys">
                    提示属性键: {card.hints.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </div>
                )}
                {/* 挖空卡片：把遮罩后的正文当题面。只在有挖空时出现，其他卡片完全不受影响。 */}
                {clozeCount > 0 && (
                  <div className="cloze-prompt">
                    <div className="cloze-prompt-label">
                      挖空回忆 · {clozeCount} 处
                    </div>
                    <div className="review-back">
                      <Preview content={clozeMasked} resolve={resolve} onOpenLink={onOpenLink} />
                    </div>
                  </div>
                )}
                {showMnemonicOnly && (
                  <div className="mnemonic-hint">
                    先回忆口诀:{backText.match(/口诀:[ \t]*(.+)/)?.[1]}
                  </div>
                )}
                <button className="btn-primary" onClick={() => setRevealed(true)}>
                  显示答案
                </button>
                <p className="muted">也可以直接按 <kbd>空格</kbd></p>
              </>
            )}
          </div>

          {revealed && (
            <>
              <hr />
              <div className="review-back">
                <Preview content={backRevealed} resolve={resolve} onOpenLink={onOpenLink} />
              </div>
              <div className="review-meta muted">
                {cardCount
                  ? `已复习 ${cardCount.reps} 次 · 间隔 ${cardCount.scheduled_days} 天 · 难度 ${cardCount.difficulty.toFixed(2)}${cardCount.lapses ? ` · 忘过 ${cardCount.lapses} 次` : ''}`
                  : '新卡片'}
                {'　'}
                <button className="btn-small" onClick={() => onOpenPath(card.path)}>打开笔记</button>
                <button
                  className="btn-small"
                  title="改写这张卡的正/背面（不影响笔记文件）"
                  onClick={() => setEditing({ front: card.front ?? '', back: card.back ?? '' })}
                >
                  编辑卡片
                </button>
                <button
                  className="btn-small"
                  title="把这张卡移出复习队列（笔记与进度都保留，可恢复）"
                  onClick={removeCard}
                >
                  删除卡片
                </button>
                {/* 与 AI 笔记联动：这张卡的正面/背面 + 出处整段交给 AI。
                    不收起复习面板（review-overlay 与 AI 面板同层，收起会打断本轮复习），
                    由 Workspace 把 AI 面板抬到本面板之上。 */}
                {onAskAi && (
                  <button
                    className="btn-small"
                    title="把这张卡交给 AI 笔记讲透（不改动卡片与笔记）"
                    onClick={() => onAskAi({
                      text: [
                        `【复习卡】出自：${card.noteTitle}${card.heading ? ` · ${card.heading}` : ''}`,
                        `正面：${frontText}`,
                        `背面：${backText}`,
                      ].join('\n'),
                      path: card.path,
                      ask: '帮我讲透这张复习卡背后的考点：先问我一个问题（不要先讲），我答完再补漏，最后给出该连的 [[双链]]。',
                    })}
                  >
                    问 AI 讲这张卡
                  </button>
                )}
              </div>
              <div className="rating-row">
                <button className="rate again" onClick={() => rate('again')}>忘了<br /><small><kbd>A</kbd> &lt;10分钟</small></button>
                <button className="rate hard" onClick={() => rate('hard')}>困难<br /><small><kbd>S</kbd> ~1天</small></button>
                <button className="rate good" onClick={() => rate('good')}>良好<br /><small><kbd>D</kbd> 数天</small></button>
                <button className="rate easy" onClick={() => rate('easy')}>简单<br /><small><kbd>F</kbd> 更长</small></button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
