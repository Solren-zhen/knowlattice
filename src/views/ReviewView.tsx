/**
 * M6 · 复习模式界面：
 * 正面 = 标题 + 属性键（不含值）；有口诀时先只显示口诀；
 * 背面 = 完整内容。评分按钮走 SM-2 调度。
 */
import { useMemo, useRef, useState } from 'react';
import { applyReview, dueQueue, loadCards, srsStats, exportSrsJson, importSrsFromJson, type Rating } from '../core/srs';
import { toast } from '../core/feedback';
import { markStudy } from '../core/stats';
import { parseFrontmatter } from '../core/parser';
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

/** 正面：属性键列表（值打码） */
function propKeys(body: string): string[] {
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^(\s*-\s*)([^:\n【[]{1,12})(\s*):/.exec(line);
    if (m && !/\s/.test(m[2])) keys.push(m[2].trim());
  }
  return keys;
}

export default function ReviewView({ paths, docs, resolve, onOpenLink, onClose, onOpenPath }: Props) {
  const [queue, setQueue] = useState<string[]>(() => dueQueue(paths));
  const srsImportRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  const currentPath = queue[0] ?? null;
  const content = currentPath ? docs.get(currentPath) ?? '' : null;
  const parsed = useMemo(() => (content ? parseFrontmatter(content) : null), [content]);
  const title = parsed?.title || currentPath?.replace(/\.md$/, '').split('/').pop() || '';
  const hasMnemonic = /口诀:[ \t]*\S/.test(parsed?.body ?? '');
  const showMnemonicOnly = hasMnemonic && !revealed;

  const stats = srsStats(paths);

  const rate = (r: Rating) => {
    if (!currentPath) return;
    applyReview(currentPath, r);
    markStudy(); // 打卡
    // M7：点「忘了」自动收录进错题本（薄弱点统计）
    if (r === 'again' && content) recordMistake(currentPath, content);
    setQueue((q) => {
      // again：10 分钟后再来一次，放回队尾
      if (r === 'again') return [...q.slice(1), q[0]];
      return q.slice(1);
    });
    setRevealed(false);
    setDone((d) => d + 1);
  };

  const cardCount = currentPath ? loadCards()[currentPath] : undefined;

  return (
    <div className="panel panel--full review-overlay">
      <div className="panel__head review-header">
        <button className="btn-small" onClick={onClose} title="返回主页面">← 返回主页面</button>
        <span>
          复习模式 · 队列剩 {queue.length} 张 · 本次已复习 {done} 张
          <span className="muted">　(库内 {stats.learned}/{stats.total} 已在调度中)</span>
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
                  setQueue(dueQueue(paths)); // 刷新队列
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

      {!currentPath ? (
        <div className="review-card done">
          <h2>今日队列已完成！</h2>
          <p className="muted">共复习 {done} 次。新笔记加入后自动进入复习队列。</p>
        </div>
      ) : (
        <div className="review-card">
          <div className="review-front">
            <h2 className={revealed ? '' : 'blurred-title'}>{title}</h2>
            <p className="muted">
              章节: {parsed?.meta.chapter || '未分类'} · 来源: {parsed?.meta.source || '—'}
            </p>
            {parsed && parsed.meta.exam.length > 0 && (
              <p className="exam-hint">历年真题: {parsed.meta.exam.join(' · ')}</p>
            )}
            {!revealed && (
              <>
                <div className="prop-keys">
                  提示属性键: {propKeys(parsed?.body ?? '').map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </div>
                {showMnemonicOnly && (
                  <div className="mnemonic-hint">
                    先回忆口诀:{parsed!.body.match(/口诀:[ \t]*(.+)/)?.[1]}
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
                <Preview content={content} resolve={resolve} onOpenLink={onOpenLink} />
              </div>
              <div className="review-meta muted">
                {cardCount
                  ? `已复习 ${cardCount.reps} 次 · 间隔 ${cardCount.scheduled_days} 天 · 难度 ${cardCount.difficulty.toFixed(2)}${cardCount.lapses ? ` · 忘过 ${cardCount.lapses} 次` : ''}`
                  : '新卡片'}
                {'　'}
                <button className="btn-small" onClick={() => onOpenPath(currentPath)}>打开编辑</button>
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
