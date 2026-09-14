/**
 * 学习统计 / 打卡：汇总复习、错题、题库、笔记、待办，并展示连续打卡与近 7 天学习曲线。
 * 打卡数据来自复习评卡 / 题库作答（markStudy），存在 localStorage。
 */
import { useMemo } from 'react';
import { srsStats } from '../core/srs';
import { toast } from '../core/feedback';
import { loadMistakes } from '../core/mistakes';
import { loadBanks } from '../core/qbank';
import { streak, last7 } from '../core/stats';
import { seedDemo } from '../core/demo';
import { IconChart } from './icons';

interface Props {
  docs: Map<string, string>;
  onClose: () => void;
}

interface TodoLite { done: boolean }

export default function Dashboard({ docs, onClose }: Props) {
  const mdPaths = useMemo(() => [...docs.keys()].filter((p) => p.endsWith('.md')), [docs]);
  const rep = useMemo(() => {
    const r = srsStats(mdPaths);
    const mistakes = Object.keys(loadMistakes()).length;
    const banks = loadBanks();
    const totalQ = banks.reduce((n, b) => n + b.questions.length, 0);
    let todos: TodoLite[] = [];
    try { todos = JSON.parse(localStorage.getItem('medvault-todos') ?? '[]'); } catch { /* ignore */ }
    const todoDone = todos.filter((t) => t.done).length;
    const s = streak();
    const days = last7();
    const maxDay = Math.max(1, ...days.map((d) => d.count));
    return { r, mistakes, bankCount: banks.length, totalQ, todoDone, todos: todos.length, s, days, maxDay };
  }, [mdPaths]);

  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];

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
      <div className="panel mistake-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title"><IconChart /> 学习统计</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">✕</button>
        </div>

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
          <div className="dash-bars">
            {rep.days.map((d, i) => (
              <div key={d.day} className="dash-bar-wrap" title={`${d.day} · ${d.count} 次`}>
                <div className="dash-bar" style={{ height: `${Math.max(6, (d.count / rep.maxDay) * 100)}%`, opacity: d.count ? 1 : 0.25 }} />
                <div className="dash-bar-label muted">{weekLabels[i]}</div>
              </div>
            ))}
          </div>
        </div>

        <p className="dash-tip muted">每次复习评卡 / 题库作答会自动记入今日打卡。</p>

        <div className="dash-demo">
          <button
            className="btn-small"
            onClick={async () => {
              const n = await seedDemo();
              toast(`已载入 ${n} 篇演示笔记 + 题库/待办/错题/打卡数据，页面将刷新以便体验全部功能。`, 'ok', 3500);
              location.reload();
            }}
          >
            载入演示数据
          </button>
          <span className="muted">批量示例笔记（双链/标签）、题库、待办、错题、打卡——方便体验各功能</span>
        </div>
      </div>
    </div>
  );
}
