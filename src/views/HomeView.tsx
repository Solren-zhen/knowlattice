/**
 * 知识首页：不是 hero，也不是功能目录——**回到上次的地方**。
 *
 * 功能清单只有一份，在导航轨（Rail.tsx 的 RAIL_GROUPS）。首页这里不重复列：
 * 只摆「最近用过的去处」，最多 8 个，由 Workspace 的 touchFeature 记进 localStorage；
 * 一条记录都没有时退回轨上那 8 个常驻项（标题也换成「常用入口」）。
 * 加一个功能 = 往 RAIL_GROUPS 加一行，首页自动跟上，不会长出第二套分组名。
 *
 * 其余两段各管一件事：
 *   - 「继续」= 最近打开的笔记 + 到期/错题提示 + 没练完的那一轮题库（这三样导航轨给不了）；
 *   - 底部一行 = 编辑器里能用的键，属于说明，不是入口。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { IconFolderIn, IconChart, IconPlus, IconSearch, IconTodo, IconVideo } from './icons';
import { completeTodo, dayKey, dueLabel, loadTodos, saveTodos, type Todo } from '../core/todos';
import { last7, streak } from '../core/stats';

export interface HomeFeature {
  /** 与 RailKey 同一个键，由 Rail 的 RAIL_INDEX 提供文案与图标 */
  key: string;
  label: string;
  icon: ReactNode;
}

interface Props {
  /** 最近使用的去处；为空时调用方会换成常驻项，标题也跟着换 */
  features: HomeFeature[];
  featuresTitle: string;
  /** 最近打开的笔记（调用方已过滤掉不存在的路径），最多 3 条 */
  recents: Array<{ path: string; title: string }>;
  dueCount: number;
  mistakeCount: number;
  /** 没练完的那一轮（core/quizCursor 读出）；null = 没有可续的，库里已删/过期/本轮已做完都会是 null */
  quizResume: { bank: string; position: number; total: number } | null;
  onFeature: (key: string) => void;
  onOpenRecent: (path: string) => void;
  onReview: () => void;
  onMistake: () => void;
  /** 接上一轮练习：调用方负责打开题库并让 QuizView 自动续做 */
  onResumeQuiz: () => void;
  onSearch: () => void;
  /** 工作台快捷操作：新建笔记（打开目录卡片里的新建表单） */
  onNewNote?: () => void;
  /** 工作台快捷操作：统一导入 */
  onImport?: () => void;
  /** 工作台快捷操作：视频笔记开关 */
  onVideo?: () => void;
  /** 工作台：打开「专注 / 待办 / 统计」整页工作台 */
  onOpenTodos?: () => void;
  /** 工作台：打开学习报告 */
  onOpenReport?: () => void;
}

export default function HomeView(p: Props) {
  const hasStats = p.dueCount > 0 || p.mistakeCount > 0;
  const hasResume = hasStats || p.quizResume !== null;

  /* ---------- 工作台数据：待办与学习打卡各读一次 localStorage ----------
   * 首页是唯一同时展示「今天要做什么」和「最近学得怎样」的地方。
   * 待办在首页可直接勾完成（走 core/todos 的 completeTodo，重复任务会照常生成下一次）；
   * 学习打卡读 core/stats，与「学习报告」同一份数据，不另存。 */
  const today = useMemo(() => dayKey(), []);
  const [todos, setTodos] = useState<Todo[]>(() => loadTodos());
  const week = useMemo(() => last7(), []);
  const streakDays = useMemo(() => streak(), []);
  const todayLearned = week[week.length - 1]?.count ?? 0;
  const weekMax = Math.max(1, ...week.map((d) => d.count));
  /** 今日待办 = 到期的（含逾期）；未排期的不挤进首页，留给「工作台」整页 */
  const todayTodos = useMemo(
    () => todos
      .filter((t) => !t.done && !!t.due && t.due <= today)
      .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || (a.priority ?? 9) - (b.priority ?? 9)),
    [todos, today],
  );
  const finishTodo = (id: string) => {
    const next = completeTodo(todos, id, today).list;
    saveTodos(next);
    setTodos(next);
  };
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div className="home-stage" data-stagger>
      <header className="home-head" data-reveal>
        <div>
          <h1 className="home-title">你的知识库，从这里开始</h1>
          <p className="home-sub">从上次停下的地方继续，或直接去一个功能。</p>
        </div>
        <button className="btn-primary home-search" data-magnet onClick={p.onSearch}>
          <IconSearch size={15} /> 搜索 <kbd>Ctrl K</kbd>
        </button>
      </header>

      <section className="home-recents" aria-labelledby="home-recents-title" data-reveal>
        <h2 id="home-recents-title" className="home-sec-title">继续</h2>
        {p.recents.length > 0 ? (
          <div className="home-recents__list">
            {p.recents.map((r) => (
              <button key={r.path} className="home-recent" onClick={() => p.onOpenRecent(r.path)}>
                <span className="home-recent__title">{r.title}</span>
                <span className="home-recent__path">{r.path.replace(/\.md$/, '')}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="home-empty">还没有打开过笔记。从左侧「目录」新建一篇，或到「导入」里拿已有内容。</p>
        )}
        {hasResume && (
          <div className="home-resume">
            {p.quizResume && (
              <button className="chip chip-accent" onClick={p.onResumeQuiz}>
                继续刷题 {p.quizResume.bank} 第 {p.quizResume.position}/{p.quizResume.total} 题
              </button>
            )}
            {p.dueCount > 0 && (
              <button className="chip" onClick={p.onReview}>待复习 {p.dueCount} 张</button>
            )}
            {p.mistakeCount > 0 && (
              <button className="chip" onClick={p.onMistake}>未清错题 {p.mistakeCount} 道</button>
            )}
          </div>
        )}
      </section>

      {/* 工作台：把首页下半屏的空白填成「今天做什么 + 最近学得怎样 + 一键开工」 */}
      <section className="home-wb" aria-labelledby="home-wb-title" data-reveal>
        <h2 id="home-wb-title" className="home-sec-title">工作台</h2>
        <div className="home-wb__grid">
          <section className="home-wb__card" aria-label="学习概览">
            <div className="home-wb__head">
              <span className="home-wb__title"><IconChart size={14} /> 学习概览</span>
              <button type="button" className="home-wb__link" onClick={p.onOpenReport}>学习报告</button>
            </div>
            <div className="home-wb__kpis">
              <div className="home-wb__kpi"><b>{streakDays}</b><span>连续打卡 · 天</span></div>
              <div className="home-wb__kpi"><b>{p.dueCount}</b><span>待复习</span></div>
              <div className="home-wb__kpi"><b>{p.mistakeCount}</b><span>未清错题</span></div>
              <div className="home-wb__kpi"><b>{todayLearned}</b><span>今日学习</span></div>
            </div>
            <div className="home-wb__chart" role="img" aria-label={`近 7 天学习次数：${week.map((d) => `${d.day} ${d.count} 次`).join('，')}`}>
              {week.map((d) => (
                <div key={d.day} className="home-wb__bar" title={`${d.day} · ${d.count} 次`}>
                  <i style={{ height: `${Math.max(8, Math.round((d.count / weekMax) * 100))}%` }} />
                  <span>{WEEKDAYS[new Date(`${d.day}T00:00:00`).getDay()]}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="home-wb__card" aria-label="今日待办">
            <div className="home-wb__head">
              <span className="home-wb__title"><IconTodo size={14} /> 今日待办{todayTodos.length > 0 && <em>{todayTodos.length}</em>}</span>
              <button type="button" className="home-wb__link" onClick={p.onOpenTodos}>打开工作台</button>
            </div>
            {todayTodos.length > 0 ? (
              <ul className="home-wb__todos">
                {todayTodos.slice(0, 5).map((t) => (
                  <li key={t.id} className="home-wb__todo">
                    <button
                      type="button"
                      className="home-wb__check"
                      aria-label={`完成：${t.text}`}
                      onClick={() => finishTodo(t.id)}
                    />
                    <span className="home-wb__todo-text">{t.text}</span>
                    {t.due && (
                      <span className={`home-wb__due${t.due < today ? ' is-overdue' : ''}`}>{dueLabel(t.due, today)}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-wb__empty">今天没有到期的待办。去「工作台」加一条，或直接开始一轮专注。</p>
            )}
          </section>

          <section className="home-wb__card" aria-label="快捷操作">
            <div className="home-wb__head">
              <span className="home-wb__title"><IconPlus size={14} /> 快捷操作</span>
            </div>
            <div className="home-wb__actions">
              <button type="button" onClick={p.onNewNote}><IconPlus size={14} /> 新建笔记</button>
              <button type="button" onClick={p.onImport}><IconFolderIn size={14} /> 导入内容</button>
              <button type="button" onClick={p.onVideo}><IconVideo size={14} /> 视频笔记</button>
              <button type="button" onClick={p.onOpenTodos}><IconTodo size={14} /> 待办工作台</button>
            </div>
          </section>
        </div>
      </section>

      <section className="home-feats-sec" aria-labelledby="home-feats-title" data-reveal>
        <h2 id="home-feats-title" className="home-sec-title">{p.featuresTitle}</h2>
        <div className="home-feats">
          {p.features.map((f) => (
            <button key={f.key} className="home-feat" onClick={() => p.onFeature(f.key)}>
              <span className="home-feat__icon" aria-hidden="true">{f.icon}</span>
              <span className="home-feat__label">{f.label}</span>
            </button>
          ))}
        </div>
      </section>

      <p className="home-keys" data-reveal>
        <span><kbd>回车</kbd>续写</span>
        <span><kbd>Tab</kbd>缩进</span>
        <span><kbd>[[</kbd>双链</span>
        <span><kbd>右键</kbd>更多</span>
        <span><kbd>Ctrl Shift P</kbd>命令面板</span>
      </p>
    </div>
  );
}
