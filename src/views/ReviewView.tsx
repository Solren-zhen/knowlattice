/**
 * M6 · 复习模式界面：
 * 正面 = 小节标题 + 属性键（不含值）；有口诀时先只显示口诀；
 * 背面 = 该小节正文。评分按钮走 FSRS 调度。
 *
 * M6+ · 粒度：一张卡 = 一个知识点（笔记里的 `##`/`###` 小节），不再是「一整篇」。
 * 建卡规则见 core/srsCards.ts；旧数据（一篇一卡）由首张卡继承调度，不会丢进度。
 */
import { useMemo, useRef, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { applyReview, dueQueue, loadCards, srsStats, scheduleOf, exportSrsJson, importSrsFromJson, type Rating } from '../core/srs';
import { buildCards, type ReviewCard } from '../core/srsCards';
import { toast } from '../core/feedback';
import { markStudy } from '../core/stats';
import { parseFrontmatterCached } from '../core/parser';
import { recordMistake } from '../core/mistakes';
import { notesToAnki, exportApkg, downloadFile } from '../core/anki';
import Preview from './Preview';

interface Props {
  paths: string[];
  docs: Map<string, string>;
  resolve: (name: string) => string | null;
  onOpenLink: (name: string) => void;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}

export default function ReviewView({ paths, docs, resolve, onOpenLink, onClose, onOpenPath }: Props) {
  // Esc 关闭（接进全局 Esc 栈）。与面板上的 ✕ 行为一致：复习进度本就随面板关闭而结束，
  // 这里只是让键盘也能退出；焦点在输入框里时先退出输入框，避免误关。
  useEsc(escThenClose(onClose));
  // 全库建卡（纯函数，一篇笔记可能出多张）：队列与统计都以「卡」为单位
  const cards = useMemo(() => buildCards(paths, docs), [paths, docs]);
  const [queue, setQueue] = useState<ReviewCard[]>(() => dueQueue(cards));
  const srsImportRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  const card: ReviewCard | null = queue[0] ?? null;
  const content = card?.body ?? null;
  // 笔记级信息（章节/来源/真题）从整篇解析里取；解析器带缓存，切卡不会重复解析
  const meta = useMemo(
    () => (card ? parseFrontmatterCached(card.path, docs.get(card.path) ?? '').meta : null),
    [card, docs]
  );
  const noteCardCount = useMemo(
    () => (card ? cards.filter((c) => c.path === card.path).length : 0),
    [cards, card]
  );
  const hasMnemonic = /口诀:[ \t]*\S/.test(content ?? '');
  const showMnemonicOnly = hasMnemonic && !revealed;

  const stats = srsStats(cards);

  const rate = (r: Rating) => {
    if (!card) return;
    applyReview(card, r);
    markStudy(); // 打卡
    // M7：点「忘了」自动收录进错题本（薄弱点统计）。存整篇：错题本按笔记展示，
    // 只存小节会把那篇的错题内容截断成片段。
    if (r === 'again') recordMistake(card.path, docs.get(card.path) ?? content ?? '');
    setQueue((q) => {
      // again：10 分钟后再来一次，放回队尾
      if (r === 'again') return [...q.slice(1), q[0]];
      return q.slice(1);
    });
    setRevealed(false);
    setDone((d) => d + 1);
  };

  const cardCount = card ? scheduleOf(loadCards(), card) : undefined;

  return (
    <div className="panel panel--full review-overlay">
      <div className="panel__head review-header">
        <button className="btn-small" onClick={onClose} title="返回主页面">← 返回主页面</button>
        <span>
          复习模式 · 队列剩 {queue.length} 张 · 本次已复习 {done} 张
          <span className="muted">　(库内 {stats.learned}/{stats.total} 张卡已在调度中)</span>
        </span>
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
          title="导出复习调度数据（.json，可跨设备/备份恢复进度）"
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
                  setQueue(dueQueue(cards)); // 刷新队列
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

      {!card ? (
        <div className="review-card done">
          <h2>今日队列已完成！</h2>
          <p className="muted">共复习 {done} 次。新笔记加入后自动进入复习队列。</p>
        </div>
      ) : (
        <div className="review-card">
          <div className="review-front">
            {/* 小节卡：标题就是问题，不能打码；整篇卡沿用原来的模糊标题（靠属性键回忆） */}
            <h2 className={card.heading || revealed ? '' : 'blurred-title'}>
              {card.heading || card.noteTitle}
            </h2>
            <p className="muted">
              出自: {card.noteTitle}
              {noteCardCount > 1 ? `（共 ${noteCardCount} 节）` : ''}
              {meta?.chapter ? ` · 章节: ${meta.chapter}` : ''}
              {meta?.source ? ` · 来源: ${meta.source}` : ''}
            </p>
            {meta && meta.exam.length > 0 && (
              <p className="exam-hint">历年真题: {meta.exam.join(' · ')}</p>
            )}
            {!revealed && (
              <>
                {card.hints.length > 0 && (
                  <div className="prop-keys">
                    提示属性键: {card.hints.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </div>
                )}
                {showMnemonicOnly && (
                  <div className="mnemonic-hint">
                    先回忆口诀:{content!.match(/口诀:[ \t]*(.+)/)?.[1]}
                  </div>
                )}
                <button className="btn-primary" onClick={() => setRevealed(true)}>
                  显示答案
                </button>
              </>
            )}
          </div>

          {revealed && (
            <>
              <hr />
              <div className="review-back">
                <Preview content={content!} resolve={resolve} onOpenLink={onOpenLink} />
              </div>
              <div className="review-meta muted">
                {cardCount
                  ? `已复习 ${cardCount.reps} 次 · 间隔 ${cardCount.scheduled_days} 天 · 难度 ${cardCount.difficulty.toFixed(2)}${cardCount.lapses ? ` · 忘过 ${cardCount.lapses} 次` : ''}`
                  : '新卡片'}
                {'　'}
                <button className="btn-small" onClick={() => onOpenPath(card.path)}>打开编辑</button>
              </div>
              <div className="rating-row">
                <button className="rate again" onClick={() => rate('again')}>忘了<br /><small>&lt;10分钟</small></button>
                <button className="rate hard" onClick={() => rate('hard')}>困难<br /><small>~1天</small></button>
                <button className="rate good" onClick={() => rate('good')}>良好<br /><small>数天</small></button>
                <button className="rate easy" onClick={() => rate('easy')}>简单<br /><small>更长</small></button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
