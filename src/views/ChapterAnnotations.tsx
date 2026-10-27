/**
 * 笔记右侧/顶部那块「这章题目批注」。
 *
 * 只在该笔记对应一个题库章节、且真有批注时出现；否则什么都不渲染
 * （笔记界面不该为一堆空面板付版面）。点一条批注会把题目正文与选项整理成
 * 可搜索的引用交给调用方（现在用于「复制」与「问 AI」两条既有出口）。
 */
import { useEffect, useMemo, useState } from 'react';
import { loadBanks } from '../core/qbank';
import { annotationsForPath, collectAnnotations, type QuestionAnnotation } from '../core/qbankAnnotations';
import { toast } from '../core/feedback';

interface Props {
  /** 当前笔记路径（vault 相对路径） */
  path: string;
  /** 题库有变动时（导入/新写批注）递增，用于重新读一遍 */
  refreshToken?: number;
  /** 有值时每条批注多一个「去练这道题」入口 */
  onPractice?: (bank: string) => void;
}

export default function ChapterAnnotations({ path, refreshToken = 0, onPractice }: Props) {
  const [all, setAll] = useState<QuestionAnnotation[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    loadBanks()
      .then((banks) => {
        if (alive) setAll(collectAnnotations(banks));
      })
      .catch(() => {
        // 题库读不出来不该把笔记界面也弄崩：当作没有批注
        if (alive) setAll([]);
      });
    return () => {
      alive = false;
    };
  }, [refreshToken]);

  const mine = useMemo(() => annotationsForPath(all, path), [all, path]);

  if (!mine.length) return null;

  const copy = async (a: QuestionAnnotation) => {
    const text = `${a.stem}\n（${a.letter}）${a.note}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('批注已复制', 'ok', 1800);
    } catch {
      toast('复制失败：浏览器不允许写剪贴板', 'err', 4000);
    }
  };

  return (
    <div className="note-anno" role="region" aria-label="题目批注">
      <button className="note-anno__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>题目批注 · {mine.length} 条</span>
        <span className="muted">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <ul className="note-anno__list">
          {mine.map((a) => (
            <li key={`${a.bank}\u0000${a.qid}\u0000${a.letter}`} className="note-anno__item">
              <div className="note-anno__stem">
                <b>{a.letter}</b> {a.stem}
              </div>
              <div className="note-anno__note">{a.note}</div>
              <div className="note-anno__bar">
                <span className="muted">{a.bank}</span>
                <button className="btn-text" onClick={() => void copy(a)}>复制</button>
                {onPractice && (
                  <button className="btn-text" onClick={() => onPractice(a.bank)}>去练这库</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
