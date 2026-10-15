/**
 * 学习统计 / 打卡：汇总复习、错题、题库、笔记、待办，并展示连续打卡与近 7 天学习曲线。
 * 打卡数据来自复习评卡 / 题库作答（markStudy），存在 localStorage。
 *
 * 本版新增：考试中心入口、每日一练连续打卡、薄弱点雷达图（跨库合并的章节掌握度）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useEsc } from './useEsc';
import { srsStats } from '../core/srs';
import { buildCards } from '../core/srsCards';
import { toast } from '../core/feedback';
import { loadMistakes } from '../core/mistakes';
import { loadBanks } from '../core/qbank';
import { chapterMastery, initializeStats, type ChapterMastery } from '../core/qbankStats';
import { mergeMastery, radarAxes, systemMastery, weakestChapters, type RadarAxis } from '../core/qbankWeakness';
import { dailyStreak, isDailyDone, last7Daily, todayKey } from '../core/dailyPractice';
import { CONFIDENCE_LABELS, calibrationSummary } from '../core/qbankCalib';
import { loadTodos } from '../core/todos';
import { streak, last7 } from '../core/stats';
import { seedDemo } from '../core/demo';
import { loadReminder, notifySupport, requestNotifyPermission, saveReminder, type NotifySupport, type ReminderConfig } from '../core/reminder';
import { MAX_DAILY_CAP, daysUntilExam, loadPlan, savePlan, type ReviewPlan } from '../core/reviewPlan';
import { IconChart, IconClose } from './icons';
import DialogSurface from './DialogSurface';

interface Props {
  docs: Map<string, string>;
  onClose: () => void;
  onOpenReview: () => void;
  onOpenQuiz: () => void;
  /** 打开考试中心（模拟考试 / 每日一练 / 错题重练） */
  onOpenExam?: () => void;
}

/** 章节掌握度雷达图：轴 = 样本最多的若干章，值 = 正确率。 */
function Radar({ axes }: { axes: RadarAxis[] }) {
  const n = axes.length;
  const R = 68;
  const cx = 90;
  const cy = 90;
  const pt = (i: number, r: number): [number, number] => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const poly = (scale: (i: number) => number) =>
    axes.map((_, i) => pt(i, R * scale(i)).join(',')).join(' ');
  return (
    <svg viewBox="0 0 180 180" className="dash-radar" role="img" aria-label="章节掌握度雷达图">
      {[0.25, 0.5, 0.75, 1].map((k) => (
        <polygon key={k} points={poly(() => k)} className="radar-ring" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="radar-spoke" />;
      })}
      <polygon points={poly((i) => Math.max(0.06, axes[i].value))} className="radar-area" />
      {axes.map((ax, i) => {
        const [x, y] = pt(i, R * Math.max(0.06, ax.value));
        return <circle key={i} cx={x} cy={y} r={2.5} className="radar-dot" />;
      })}
    </svg>
  );
}

export default function Dashboard({ docs, onClose, onOpenReview, onOpenQuiz, onOpenExam }: Props) {
  // Esc 关闭（接进全局 Esc 栈，与其余面板一致）
  useEsc(onClose);
  const [qbank, setQbank] = useState<{ bankCount: number; totalQ: number; mastery: ChapterMastery[] }>({ bankCount: 0, totalQ: 0, mastery: [] });
  useEffect(() => {
    let active = true;
    Promise.all([loadBanks(), initializeStats()]).then(([banks, stats]) => {
      if (!active) return;
      // 跨库合并章节掌握度：雷达图/学科汇总看的是「整个人的薄弱点」，不该分库各看各的
      const mastery = mergeMastery(banks.flatMap((bank) => chapterMastery(bank, stats)));
      setQbank({ bankCount: banks.length, totalQ: banks.reduce((count, bank) => count + bank.questions.length, 0), mastery });
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
    return { r, mistakes, bankCount: qbank.bankCount, totalQ: qbank.totalQ, todoDone, todos: todos.length, s, days, maxDay };
  }, [mdPaths, docs, qbank]);

  /** 薄弱点：跨库合并后的学科汇总 / 雷达轴 / 最弱章（都只在有作答记录时才有内容） */
  const sysRep = useMemo(() => systemMastery(qbank.mastery), [qbank.mastery]);
  const axes = useMemo(() => radarAxes(qbank.mastery, 8), [qbank.mastery]);
  const weak = useMemo(() => weakestChapters(qbank.mastery, 3, 5), [qbank.mastery]);
  const hasWeakData = axes.length > 0;

  /** 每日一练：独立于总打卡的连续天数与今日状态 */
  const daily = useMemo(() => ({ streak: dailyStreak(), done: isDailyDone(todayKey()), week: last7Daily() }), []);

  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const hasNewCards = rep.r.learned < rep.r.total;
  const hasBanks = rep.bankCount > 0;

  // 校准数据只在弹层打开时取一次（面板每次打开都会重新挂载，跟 rep 的重算时机一致）
  const calib = useMemo(() => calibrationSummary(), []);
  // 结论文案：overconfidence 是「平均自信 − 实际正确率」的比例差，×100 换算成百分点
  const calibVerdict = useMemo(() => {
    if (!calib.n) return '';
    const acc = calib.correct / calib.n;
    const mean = calib.overconfidence + acc;
    const z = Math.round(Math.abs(calib.overconfidence) * 100);
    const head = `平均自信 ${Math.round(mean * 100)}%，实际答对 ${Math.round(acc * 100)}% —— `;
    // 3 个百分点以内视作「校准得不错」，避免把四舍五入的抖动说成高估/低估
    if (z < 3) return `${head}校准得不错`;
    return `${head}${calib.overconfidence > 0 ? '高估' : '低估'} ${z} 个百分点`;
  }, [calib]);

  // 复习计划与提醒：写入一律走「清洗 + 写 localStorage」的 saveX（见 core/reviewPlan.ts / core/reminder.ts）。
  // 不用 useEffect 回写——首帧回写会把用户既有数据覆盖成默认值。
  const [plan, setPlan] = useState<ReviewPlan>(() => loadPlan());
  const [rem, setRem] = useState<ReminderConfig>(() => loadReminder());
  const [notifyState, setNotifyState] = useState<NotifySupport>(() => notifySupport());
  const [notifyHint, setNotifyHint] = useState('');
  const examDays = daysUntilExam(plan.examDate);

  /** 改一个字段就立刻落盘；saveX 返回清洗后的对象，直接当新 state，界面与存储始终一致 */
  const updatePlan = (patch: Partial<ReviewPlan>) => {
    setPlan(savePlan({ ...plan, ...patch }));
  };
  const updateRem = (patch: Partial<ReminderConfig>) => {
    setRem(saveReminder({ ...rem, ...patch }));
  };

  /** 权限申请必须在点击事件里 await：非用户手势触发的请求会被浏览器直接拒掉 */
  const enableNotify = async () => {
    const next = await requestNotifyPermission();
    setNotifyState(next);
    setNotifyHint(next === 'denied' ? '浏览器已拒绝通知权限，可在站点设置里重新允许。' : '');
  };

  /** 上限输入框：空 = 0（不限制）；夹在 [0, MAX_DAILY_CAP] 内，避免越界值被 savePlan 归零后输入框突然被清空 */
  const setDailyCap = (raw: string) => {
    const n = raw === '' ? 0 : Number(raw);
    updatePlan({ dailyCap: Number.isFinite(n) ? Math.min(MAX_DAILY_CAP, Math.max(0, Math.floor(n))) : 0 });
  };

  const cards = [
    { label: '连续打卡', value: `${rep.s} 天`, to: [rep.s], tpl: '{0} 天', cls: 'accent' },
    { label: '今日到期', value: `${rep.r.dueNow} 张`, to: [rep.r.dueNow], tpl: '{0} 张' },
    { label: '已学卡片', value: `${rep.r.learned}/${rep.r.total}`, to: [rep.r.learned, rep.r.total], tpl: '{0}/{1}' },
    { label: '错题', value: `${rep.mistakes} 道`, to: [rep.mistakes], tpl: '{0} 道' },
    { label: '题库', value: `${rep.bankCount} 库 / ${rep.totalQ} 题`, to: [rep.bankCount, rep.totalQ], tpl: '{0} 库 / {1} 题' },
    { label: '笔记', value: `${mdPaths.length} 篇`, to: [mdPaths.length], tpl: '{0} 篇' },
    { label: '待办完成', value: `${rep.todoDone}/${rep.todos}`, to: [rep.todoDone, rep.todos], tpl: '{0}/{1}' },
  ];

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <DialogSurface className="panel mistake-panel" label="学习统计" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title"><IconChart /> 学习统计</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <section className="dash-next" data-reveal aria-label="下一步学习">
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
          <button className="btn-primary" data-magnet onClick={rep.r.dueNow > 0 || hasNewCards ? onOpenReview : onOpenQuiz}>
            {rep.r.dueNow > 0 ? '开始今日复习' : hasNewCards ? '开始学习新卡' : hasBanks ? '开始练题' : '导入题库'}
          </button>

          {examDays !== null && (
            <p className="dash-exam muted">
              {plan.examLabel ? `${plan.examLabel} · ` : ''}
              {examDays > 0
                ? `距考试还有 ${examDays} 天`
                : examDays === 0
                  ? '考试就是今天'
                  : `考试已过 ${-examDays} 天`}
              {plan.dailyCap > 0 ? ` · 每日上限 ${plan.dailyCap} 张` : ''}
            </p>
          )}
        </section>

        {/* 考试中心入口 + 每日一练打卡 */}
        {onOpenExam && (
          <section className="dash-exam-center" data-reveal aria-label="考试中心">
            <div className="dash-exam-center-main">
              <strong>考试中心</strong>
              <span className="muted">模拟考试 · 每日一练 · 错题重练（当前连续 {daily.streak} 天）</span>
            </div>
            <div className="dash-daily-dots" aria-hidden="true">
              {daily.week.map((d) => (
                <span key={d.day} className={`dash-daily-dot${d.done ? ' done' : d.count ? ' partial' : ''}`} />
              ))}
            </div>
            <button className="btn-primary" data-magnet onClick={onOpenExam}>{daily.done ? '再练一会儿' : '开始每日一练'}</button>
          </section>
        )}

        <div className="dash-cards" data-reveal>
          {cards.map((c) => (
            <div key={c.label} className={`dash-card ${c.cls ?? ''}`} data-tilt>
              {/* 呼吸背光（第 6 项）：伪元素只有两个、::after 已被流光占用，
                  所以用真实元素承载；空 span + aria-hidden，不进无障碍树 */}
              <span className="card-glow" aria-hidden="true" />
              {/* 数字滚动：data-count-* 由 core/countUp.ts 读取，从 0 滚到目标 */}
              <div className="dash-value" data-count-to={c.to.join(',')} data-count-tpl={c.tpl}>{c.value}</div>
              <div className="dash-label muted">{c.label}</div>
            </div>
          ))}
        </div>

        {/* 薄弱点可视化：跨库合并的章节掌握度 → 雷达图 + 学科正确率 */}
        {hasWeakData && (
          <section className="dash-weak" data-reveal aria-label="薄弱点">
            <h4>薄弱点</h4>
            <div className="dash-weak-body">
              {axes.length >= 3 ? (
                <Radar axes={axes} />
              ) : (
                <div className="dash-weak-systems">
                  {sysRep.map((s, si) => (
                    <div key={s.system} className="dash-sys-row">
                      <span className="dash-sys-name">{s.system}</span>
                      <div className="dash-sys-track"><div className={`dash-sys-fill${s.accuracy < 0.6 ? ' low' : ''}`} style={{ width: `${Math.round(s.accuracy * 100)}%`, ['--i' as string]: si }} /></div>
                      <span className="dash-sys-pct">{Math.round(s.accuracy * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}
              {weak.length > 0 && (
                <div className="dash-weak-list">
                  <span className="muted">最需要补的章节：</span>
                  {weak.map((m) => (
                    <span key={m.chapter} className="dash-weak-chip">{m.chapter} · {Math.round(m.accuracy * 100)}%</span>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        <div className="dash-week" data-reveal>
          <h4>近 7 天学习</h4>
          <div className="dash-bars" role="list" aria-label="最近七天每日学习次数">
                {rep.days.map((d, i) => (
                  <div key={d.day} className={`dash-bar-wrap${i === rep.days.length - 1 ? ' is-today' : ''}`} role="listitem" aria-label={`${d.day}：${d.count} 次`}>
                    <span className="dash-bar-count">{d.count}</span>
                    <div className="dash-bar" style={{ height: `${Math.max(6, (d.count / rep.maxDay) * 100)}%`, opacity: d.count ? 1 : 0.25, ['--i' as string]: i }} />
                <div className="dash-bar-label muted">{weekLabels[(new Date(`${d.day}T00:00:00`).getDay() + 6) % 7]}</div>
              </div>
            ))}
          </div>
        </div>

        <section className="dash-calib" data-reveal aria-label="元认知校准">
          <h4>元认知校准</h4>
          {calib.n === 0 ? (
            <p className="dash-calib-empty muted">还没有数据：去题库练习作答前先选一个把握程度，这里就会画出你的校准曲线。</p>
          ) : (
            <>
              <div className="dash-calib-rows" role="list" aria-label="各档自信度的实际正确率">
                {calib.buckets.map((b, bi) => {
                  const pct = b.n ? Math.round((b.correct / b.n) * 100) : 0;
                  return (
                    <div
                      key={b.confidence}
                      className="dash-calib-row"
                      role="listitem"
                      aria-label={`${CONFIDENCE_LABELS[b.confidence]}：${b.n ? `${pct}%` : '暂无'}，${b.n} 次`}
                    >
                      <span className="dash-calib-label">{CONFIDENCE_LABELS[b.confidence]}</span>
                      <div className="dash-calib-track">
                        <div className="dash-calib-fill" style={{ width: `${pct}%`, ['--i' as string]: bi }} />
                      </div>
                      <span className="dash-calib-pct">{b.n ? `${pct}%` : '暂无'}</span>
                      <span className="dash-calib-n muted">{b.n} 次</span>
                    </div>
                  );
                })}
              </div>
              <p className="dash-calib-verdict">{calibVerdict}</p>
            </>
          )}
        </section>

        <section className="dash-plan" data-reveal aria-label="复习计划与提醒">
          <h4>复习计划与提醒</h4>
          <div className="dash-plan-row">
            <label className="dash-plan-field">
              <span className="muted">考试日期</span>
              <input type="date" value={plan.examDate} onChange={(e) => updatePlan({ examDate: e.target.value })} />
            </label>
            <label className="dash-plan-field">
              <span className="muted">考试名称</span>
              <input
                type="text"
                value={plan.examLabel}
                placeholder="如：执业医师笔试"
                onChange={(e) => updatePlan({ examLabel: e.target.value })}
              />
            </label>
          </div>
          <label className="dash-plan-field">
            <span className="muted">每日复习上限</span>
            <input
              type="number"
              min={0}
              max={MAX_DAILY_CAP}
              value={plan.dailyCap || ''}
              placeholder="0 = 不限制"
              onChange={(e) => setDailyCap(e.target.value)}
            />
          </label>
          <p className="dash-plan-note muted">设为 0 表示不限制；设了考试日期时会按剩余天数自动收紧。</p>
          <div className="dash-plan-row">
            <label className="dash-plan-check">
              <input type="checkbox" checked={rem.enabled} onChange={(e) => updateRem({ enabled: e.target.checked })} />
              <span>每日复习提醒</span>
            </label>
            <label className="dash-plan-field">
              <span className="muted">提醒时刻</span>
              <input
                type="time"
                value={rem.time}
                disabled={!rem.enabled}
                onChange={(e) => updateRem({ time: e.target.value })}
              />
            </label>
          </div>
          <div className="dash-plan-notify">
            {notifyState === 'unsupported' ? (
              <span className="muted">当前环境不支持系统通知，到点会在应用内提示。</span>
            ) : notifyState === 'granted' ? (
              <span className="muted">系统通知已开启</span>
            ) : (
              <button className="btn-small" onClick={enableNotify}>开启系统通知</button>
            )}
            {notifyHint && <span className="muted">{notifyHint}</span>}
          </div>
        </section>

        <p className="dash-tip muted">完成复习或练习后，数据将自动计入学习统计。</p>

        <div className="dash-demo" data-reveal>
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
