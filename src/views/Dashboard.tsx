/**
 * 学习统计 / 打卡：汇总复习、错题、题库、笔记、待办，并展示连续打卡与近 7 天学习曲线。
 * 打卡数据来自复习评卡 / 题库作答（markStudy），存在 localStorage。
 */
import { useEffect, useMemo, useState } from 'react';
import { useEsc } from './useEsc';
import { srsStats } from '../core/srs';
import { buildCards } from '../core/srsCards';
import { toast } from '../core/feedback';
import { loadMistakes } from '../core/mistakes';
import { loadBanks } from '../core/qbank';
import { loadTodos } from '../core/todos';
import { streak, last7 } from '../core/stats';
import { seedDemo } from '../core/demo';
import { IconChart, IconClose } from './icons';
import DialogSurface from './DialogSurface';

interface Props {
  docs: Map<string, string>;
  onClose: () => void;
  onOpenReview: () => void;
  onOpenQuiz: () => void;
}

export default function Dashboard({ docs, onClose, onOpenReview, onOpenQuiz }: Props) {
  // Esc 关闭（接进全局 Esc 栈，与其余面板一致）
  useEsc(onClose);
  const [qbankTotals, setQbankTotals] = useState({ bankCount: 0, totalQ: 0 });
  useEffect(() => {
    let active = true;
    loadBanks().then((banks) => {
      if (active) setQbankTotals({ bankCount: banks.length, totalQ: banks.reduce((count, bank) => count + bank.questions.length, 0) });
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const mdPaths = useMemo(() => [...docs.keys()].filter((p) => p.endsWith('.md')), [docs]);
  const rep = useMemo(() => {
    // 统计单位是「卡」（一篇笔记按小节切出多张），见 core/srsCards.ts
    const r = srsStats(buildCards(mdPaths, docs));
    const mistakes = Object.keys(loadMistakes()).length;
    const todos = loadTodos();
    const todoDone = todos.filter((t) => t.done).length;
    const s = streak();
    const days = last7();
    const maxDay = Math.max(1, ...days.map((d) => d.count));
    return { r, mistakes, ...qbankTotals, todoDone, todos: todos.length, s, days, maxDay };
  }, [mdPaths, docs, qbankTotals]);

  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const hasNewCards = rep.r.learned < rep.r.total;
  const hasBanks = rep.bankCount > 0;

  const cards = [
    { label: '连续打卡', value: `${rep.s} 天`, cls: 'accent' },
    { label: '今日到期', value: `${rep.r.dueNow} 张` },
    { label: '已学卡片', value: `${rep.r.learned}/${rep.r.total}` },
    { label: '错题', value: `${rep.mistakes} 道` },
    { label: '题库', value: `${rep.bankCount} 库 / ${rep.totalQ} 题` },
    { label: '笔记', value: `${mdPaths.length} 篇` },
    { label: '待办完成', value: `${rep.todoDone}/${rep.todos}` },
  ];

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <DialogSurface className="panel mistake-panel" label="学习统计" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title"><IconChart /> 学习统计</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <section className="dash-next" aria-label="下一步学习">
          <div>
            <strong>{rep.r.dueNow > 0 ? '今天可以复习了' : hasNewCards ? '开始学习新卡' : '继续推进学习'}</strong>
            <span className="muted">
              {rep.r.dueNow > 0
                ? `有 ${rep.r.dueNow} 张卡片待复习${hasNewCards ? `，另有 ${rep.r.total - rep.r.learned} 张新卡` : ''}`
                  : hasNewCards
                    ? `还有 ${rep.r.total - rep.r.learned} 张新卡尚未学习`
                    : hasBanks
                      ? '今日复习队列已清空，可以继续练题巩固'
                      : '还没有题库，导入题目后即可开始练习'}
            </span>
          </div>
          <button className="btn-primary" onClick={rep.r.dueNow > 0 || hasNewCards ? onOpenReview : onOpenQuiz}>
            {rep.r.dueNow > 0 ? '开始今日复习' : hasNewCards ? '开始学习新卡' : hasBanks ? '开始练题' : '导入题库'}
          </button>
        </section>

        <div className="dash-cards">
          {cards.map((c) => (
            <div key={c.label} className={`dash-card ${c.cls ?? ''}`}>
              <div className="dash-value">{c.value}</div>
              <div className="dash-label muted">{c.label}</div>
            </div>
          ))}
        </div>

        <div className="dash-week">
          <h4>近 7 天学习</h4>
          <div className="dash-bars" role="list" aria-label="最近七天每日学习次数">
            {rep.days.map((d, i) => (
              <div key={d.day} className={`dash-bar-wrap${i === rep.days.length - 1 ? ' is-today' : ''}`} role="listitem" aria-label={`${d.day}：${d.count} 次`}>
                <span className="dash-bar-count">{d.count}</span>
                <div className="dash-bar" style={{ height: `${Math.max(6, (d.count / rep.maxDay) * 100)}%`, opacity: d.count ? 1 : 0.25 }} />
                <div className="dash-bar-label muted">{weekLabels[(new Date(`${d.day}T00:00:00`).getDay() + 6) % 7]}</div>
              </div>
            ))}
          </div>
        </div>

        <p className="dash-tip muted">完成复习或练习后，数据将自动计入学习统计。</p>

        <div className="dash-demo">
          <button
            className="btn-small"
            onClick={async () => {
              const n = await seedDemo();
              toast(`已载入 ${n} 篇示例笔记及配套学习数据，页面将刷新以便体验完整工作流。`, 'ok', 3500);
              location.reload();
            }}
          >
            载入演示数据
          </button>
          <span className="muted">载入笔记、题库、待办与学习记录，快速体验完整工作流</span>
        </div>
      </DialogSurface>
    </div>
  );
}
