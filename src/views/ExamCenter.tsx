/**
 * 考试中心：把「考试 App」那套能力集中到一个面板里。
 *
 *   · 模拟考试  限时整卷 → 交卷自动评分 → 分章节成绩报告 + 历史对比
 *   · 每日一练  按日期确定性抽出的今日题单，完成即打卡（独立连续天数）
 *   · 错题重练  把做错过的题再练一遍，练对了就移出错题池、练错了更重（core/qbankStats 的 relearn）
 *   · 高频考点  按章节题量排出最值得优先刷的考点（附该章易错题数）
 *
 * 数据全部来自现有题库与逐题历史（core/qbank、qbankStats、exam、dailyPractice、qbankTags），
 * 面板自己 loadBanks/initializeStats，与 QuizView 同一条本地优先策略。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc } from './useEsc';
import { loadBanks, type QuizBank, type QuizQuestion } from '../core/qbank';
import { chapterCounts, filterPool } from '../core/qbankCompose';
import { initializeStats, loadStats, recordAnswer, type StatsMap } from '../core/qbankStats';
import { initializeStars, loadStars, type StarMap } from '../core/qbankStarred';
import {
  buildExamPaper, buildExamResult, DEFAULT_EXAM_CONFIG, EXAM_PASS, formatClock,
  scoreDelta, weakChapters, type ExamConfig, type ExamResult,
} from '../core/exam';
import { loadExamHistory, saveExamResult } from '../core/examHistory';
import {
  DAILY_COUNT, dailyQuestions, dailyRecord, dailyStreak,
  isDailyDone, last7Daily, recordDailyProgress, todayKey,
} from '../core/dailyPractice';
import { difficultyCounts, DIFFICULTY_LABELS, highFreqChapters, Q_TAG_LABELS, tagCounts, type DifficultyBand, type QTag } from '../core/qbankTags';
import { markStudy } from '../core/stats';
import { toast } from '../core/feedback';
import { IconCards, IconChart, IconClose, IconQuiz, IconTarget } from './icons';

interface Props {
  onClose: () => void;
  /** 从题库列表点「模拟考试」进来时预选的题库 */
  initialBank?: string;
}

type Mode = 'exam' | 'daily' | 'wrong';
type Phase = 'home' | 'config' | 'running' | 'report';

/** 卷子上的一道题：带上它来自哪个题库（错题重练会跨库，判分与回写都要用题库名）。 */
interface PaperItem {
  bank: string;
  q: QuizQuestion;
}

const MODE_LABELS: Record<Mode, string> = { exam: '模拟考试', daily: '每日一练', wrong: '错题重练' };

function shuffle<T>(list: T[], rnd: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 单题判分（与 core/qbank 的判分口径一致：全对才算对）。 */
function gradeOne(q: QuizQuestion, picked: number[]): boolean {
  const right = q.answers && q.answers.length ? [...q.answers].sort((a, b) => a - b) : q.answer >= 0 ? [q.answer] : [];
  if (!right.length) return false;
  const mine = [...new Set(picked)].sort((a, b) => a - b);
  return mine.length === right.length && mine.every((v, k) => v === right[k]);
}

export default function ExamCenter({ onClose, initialBank }: Props) {
  useEsc(onClose);
  const [banks, setBanks] = useState<QuizBank[]>([]);
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<StatsMap>(loadStats);
  const [stars, setStars] = useState<StarMap>(loadStars);

  const [phase, setPhase] = useState<Phase>('home');
  const [mode, setMode] = useState<Mode>('exam');
  const [bankName, setBankName] = useState(initialBank ?? '');
  const [config, setConfig] = useState<ExamConfig>(DEFAULT_EXAM_CONFIG);

  const [items, setItems] = useState<PaperItem[]>([]);
  const [answers, setAnswers] = useState<Array<number[] | null>>([]);
  const [cur, setCur] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [deadline, setDeadline] = useState(0);
  const [remainMs, setRemainMs] = useState(0);

  const [result, setResult] = useState<ExamResult | null>(null);
  const [history, setHistory] = useState<ExamResult[]>([]);
  /** 错题重练报告：本次剔出（答对到 wrong=0）的题数 */
  const [cleared, setCleared] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([loadBanks(), initializeStats(), initializeStars()]).then(([loadedBanks, loadedStats, loadedStars]) => {
      if (!active) return;
      setBanks(loadedBanks);
      setStats(loadedStats);
      setStars(loadedStars);
      setHistory(loadExamHistory());
      setBankName((prev) => prev || loadedBanks[0]?.name || '');
      setReady(true);
    }).catch(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const bank = banks.find((b) => b.name === bankName) ?? null;
  const chapters = useMemo(() => (bank ? chapterCounts(bank.questions) : []), [bank]);
  const today = todayKey();
  const dailyDoneFlag = isDailyDone(today);
  const dailyRec = dailyRecord(today);
  const streakDays = dailyStreak(today);
  const week = last7Daily(today);

  const counts: Record<QTag, number> | null = useMemo(
    () => (bank ? tagCounts(bank, stats) : null),
    [bank, stats],
  );
  const diff = useMemo<Record<DifficultyBand, number> | null>(
    () => (bank ? difficultyCounts(bank, stats) : null),
    [bank, stats],
  );
  const hotChapters = useMemo(() => (bank ? highFreqChapters(bank, stats, 8) : []), [bank, stats]);

  // ---------- 开始一轮 ----------
  const beginExam = (b: QuizBank) => {
    const paper = buildExamPaper(b, config, loadStats(), undefined, undefined, loadStars());
    if (paper.length === 0) { toast('按当前筛选没有可考的题（考试只组选择题）', 'err'); return; }
    setItems(paper.map((q) => ({ bank: b.name, q })));
    setAnswers(new Array(paper.length).fill(null));
    setCur(0);
    setStartedAt(Date.now());
    setDeadline(config.minutes > 0 ? Date.now() + config.minutes * 60_000 : 0);
    setResult(null);
    setCleared(0);
    setPhase('running');
  };

  const beginDaily = (b: QuizBank) => {
    const qs = dailyQuestions(b, today, DAILY_COUNT, loadStats());
    if (qs.length === 0) { toast('这个题库暂无可练的题', 'err'); return; }
    setItems(qs.map((q) => ({ bank: b.name, q })));
    setAnswers(new Array(qs.length).fill(null));
    setCur(0);
    setStartedAt(Date.now());
    setDeadline(0);
    setResult(null);
    setCleared(0);
    setPhase('running');
  };

  const beginWrong = () => {
    const out: PaperItem[] = [];
    for (const b of banks) {
      const pool = filterPool(b.questions, { count: 0, chapters: [], types: ['choice'], scope: 'wrong', order: 'shuffle' }, loadStats(), b.name);
      for (const q of pool) out.push({ bank: b.name, q });
    }
    if (out.length === 0) { toast('还没有做错过的题，先去练一轮吧', 'info'); return; }
    const picked = shuffle(out).slice(0, 30);
    setItems(picked);
    setAnswers(new Array(picked.length).fill(null));
    setCur(0);
    setStartedAt(Date.now());
    setDeadline(0);
    setResult(null);
    setCleared(0);
    setPhase('running');
  };

  // ---------- 作答 ----------
  const setPick = (qIndex: number, picked: number[]) => {
    const next = answers.map((a, i) => (i === qIndex ? picked : a));
    setAnswers(next);
    if (mode === 'daily') {
      const done = next.filter((a) => a && a.length).length;
      recordDailyProgress(today, items[qIndex]?.bank ?? bankName, next.length, done);
    }
  };

  const submit = useCallback(() => {
    const finishedAt = Date.now();
    const list = items;
    const bankNames = [...new Set(list.map((it) => it.bank))];
    const singleBank = bankNames.length === 1 ? bankNames[0] : '跨题库';
    // 回写逐题历史（错题重练用 relearn 语义：答对减错、答错加重）
    const relearn = mode === 'wrong';
    list.forEach((it, i) => {
      const picked = answers[i] ?? [];
      const right = picked.length > 0 && gradeOne(it.q, picked);
      void recordAnswer(it.bank, it.q.id, right, Date.now(), relearn);
      markStudy();
    });
    const res = buildExamResult(
      mode === 'exam' ? (bank?.name ?? singleBank) : `${MODE_LABELS[mode]}·${singleBank}`,
      list.map((it) => it.q),
      answers,
      startedAt,
      finishedAt,
      deadline > 0 ? deadline - startedAt : 0,
    );
    setResult(res);
    if (mode === 'exam') setHistory(saveExamResult(res));
    if (mode === 'wrong') {
      const now = loadStats();
      setCleared(list.filter((it) => (now[it.bank]?.[it.q.id]?.wrong ?? 0) === 0).length);
    }
    if (mode === 'daily') recordDailyProgress(today, singleBank, list.length, answers.filter((a) => a && a.length).length);
    setStats(loadStats());
    setPhase('report');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, answers, mode, startedAt, deadline, bank?.name, today]);

  const submitRef = useRef(submit);
  submitRef.current = submit;

  // 限时倒计时：到点自动交卷
  useEffect(() => {
    if (phase !== 'running' || deadline <= 0) return;
    setRemainMs(deadline - Date.now());
    const t = window.setInterval(() => {
      const left = deadline - Date.now();
      setRemainMs(left);
      if (left <= 0) { window.clearInterval(t); submitRef.current(); }
    }, 250);
    return () => window.clearInterval(t);
  }, [phase, deadline]);

  const head = (title: string, onBack?: () => void) => (
    <div className="panel__head quiz-header">
      <span className="panel__title quiz-title">
        <button className="btn-small" onClick={onBack ?? onClose}>{onBack ? '← 返回' : '← 关闭'}</button> {title}
      </span>
      <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
    </div>
  );

  if (!ready) {
    return (
      <div className="panel-backdrop quiz-overlay">
        <DialogSurface className="panel quiz-panel exam-panel" label="考试中心加载中">
          <div className="panel__body quiz-body"><p role="status">正在加载题库…</p></div>
        </DialogSurface>
      </div>
    );
  }

  // ---- 答题中 ----
  if (phase === 'running') {
    const it = items[cur];
    const picked = answers[cur] ?? [];
    const isMulti = Boolean(it.q.answers && it.q.answers.length > 1);
    const answeredCount = answers.filter((a) => a && a.length).length;
    return (
      <div className="panel-backdrop quiz-overlay" onClick={onClose}>
        <DialogSurface className="panel quiz-panel exam-panel" label={`${MODE_LABELS[mode]}，第 ${cur + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">{(mode === 'exam' ? bank?.name : MODE_LABELS[mode]) ?? ''} · 第 {cur + 1} / {items.length} 题</span>
            {deadline > 0 && <span className={`exam-timer${remainMs < 60_000 ? ' low' : ''}`}>{formatClock(remainMs)}</span>}
            <span className="muted">已答 {answeredCount}</span>
            <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-progress"><i style={{ width: `${((cur + (picked.length ? 1 : 0)) / items.length) * 100}%` }} /></div>

          <div className="panel__body quiz-body">
            <div className="exam-palette" role="group" aria-label="题号导航">
              {items.map((_, i) => (
                <button
                  key={i}
                  className={`exam-dot${i === cur ? ' cur' : ''}${answers[i] && answers[i]!.length ? ' done' : ''}`}
                  onClick={() => setCur(i)}
                  aria-label={`第 ${i + 1} 题`}
                >{i + 1}</button>
              ))}
            </div>
            {it.q.chapter && <span className="quiz-chapter">{it.q.chapter}</span>}
            <p className="quiz-stem">{it.q.stem}</p>
            <div className="quiz-opts">
              {it.q.options.map((opt, i) => {
                const chosen = picked.includes(i);
                return (
                  <button
                    key={i}
                    className={`opt${chosen ? ' on' : ''}`}
                    onClick={() => {
                      if (isMulti) setPick(cur, chosen ? picked.filter((x) => x !== i) : [...picked, i].sort((a, b) => a - b));
                      else setPick(cur, [i]);
                    }}
                  >
                    <b>{String.fromCharCode(65 + i)}</b> {opt}
                  </button>
                );
              })}
            </div>
            {isMulti && (
              <p className="muted">多选题：全对才算对（少选、多选都算错）——选完直接下一题，交卷时统一判定。</p>
            )}
          </div>

          <div className="quiz-footer">
            <button className="btn-small" disabled={cur === 0} onClick={() => setCur((i) => i - 1)}>← 上一题</button>
            {cur + 1 < items.length ? (
              <button className="btn-primary" onClick={() => setCur((i) => i + 1)}>下一题 →</button>
            ) : null}
            <button className="btn-primary" onClick={() => submitRef.current()}>交卷（已答 {answeredCount}/{items.length}）</button>
          </div>
        </DialogSurface>
      </div>
    );
  }

  // ---- 成绩报告 ----
  if (phase === 'report' && result) {
    const delta = mode === 'exam' ? scoreDelta(result, history.filter((r) => r.id !== result.id)) : null;
    const weak = weakChapters(result);
    const wrongItems = result.wrongIds.map((id) => items.find((x) => x.q.id === id)).filter((x): x is PaperItem => Boolean(x));
    return (
      <div className="panel-backdrop quiz-overlay" onClick={onClose}>
        <DialogSurface className="panel quiz-panel exam-panel" label={`${MODE_LABELS[mode]}成绩`} onClick={(e) => e.stopPropagation()}>
          {head(`${MODE_LABELS[mode]}成绩`)}
          <div className="panel__body quiz-body">
            <div className="quiz-result">
              <div className={`score${result.score < EXAM_PASS ? ' low' : ''}`}>{result.score}<small>分</small></div>
              <p className="muted">
                {result.correct} / {result.total} 题正确 · 用时 {formatClock(result.usedMs)}
                {mode === 'daily' && dailyDoneFlag && ' · 今日一练已完成 ✓'}
              </p>
              {delta !== null && (
                <p className="exam-delta muted">比上次考试{delta >= 0 ? `高 ${delta}` : `低 ${-delta}`} 分</p>
              )}
              {mode === 'wrong' && (
                <p className="exam-delta">本次已攻克 <b>{cleared}</b> 题（答对后移出错题池）</p>
              )}

              {result.perChapter.length > 0 && (
                <div className="exam-chapters">
                  <h4>分章节得分</h4>
                  {result.perChapter.map((c) => (
                    <div key={c.chapter || '~none'} className="exam-chapter-row">
                      <span className="exam-chapter-name">{c.chapter || '未标章节'}</span>
                      <div className="exam-chapter-track">
                        <div className={`exam-chapter-fill${c.accuracy < EXAM_PASS / 100 ? ' low' : ''}`} style={{ width: `${Math.round(c.accuracy * 100)}%` }} />
                      </div>
                      <span className="exam-chapter-pct">{c.correct}/{c.total}</span>
                    </div>
                  ))}
                </div>
              )}

              {weak.length > 0 && (
                <p className="quiz-gate" role="status">
                  薄弱章节：{weak.map((c) => `${c.chapter}（${Math.round(c.accuracy * 100)}%）`).join('、')}——建议回看对应笔记再练。
                </p>
              )}

              {wrongItems.length > 0 && (
                <details className="exam-wrong">
                  <summary>答错的 {wrongItems.length} 题</summary>
                  <div className="quiz-wrong-list">
                    {wrongItems.map((it) => (
                      <div key={it.q.id} className="quiz-wrong-item">
                        <span>{it.q.stem}</span>
                        <i>正解：{it.q.answerText}</i>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="quiz-actions center">
                {mode === 'wrong' ? (
                  <button className="btn-primary" onClick={beginWrong}>再练一轮错题</button>
                ) : bank ? (
                  <button className="btn-primary" onClick={() => (mode === 'exam' ? beginExam(bank) : beginDaily(bank))}>再练一轮</button>
                ) : null}
                <button className="btn-small" onClick={() => { setPhase('home'); setResult(null); }}>返回考试中心</button>
              </div>
            </div>
          </div>
        </DialogSurface>
      </div>
    );
  }

  // ---- 组卷配置 ----
  if (phase === 'config') {
    const pool = bank ? filterPool(bank.questions, { ...config, types: ['choice'] }, stats, bank.name, undefined, stars) : [];
    const willPick = config.count > 0 ? Math.min(config.count, pool.length) : pool.length;
    const toggleChapter = (c: string) =>
      setConfig((r) => ({ ...r, chapters: r.chapters.includes(c) ? r.chapters.filter((x) => x !== c) : [...r.chapters, c] }));
    return (
      <div className="panel-backdrop quiz-overlay" onClick={() => setPhase('home')}>
        <DialogSurface className="panel quiz-panel exam-panel" label="模拟考试设置" onClick={(e) => e.stopPropagation()}>
          {head(`模拟考试 · ${bank?.name ?? ''}`, () => setPhase('home'))}
          <div className="panel__body quiz-body">
            <div className="compose-row">
              <span className="compose-label">题量</span>
              <div className="compose-chips">
                {[20, 50, 100, 150].map((c) => (
                  <button key={c} className={`chip${config.count === c ? ' on' : ''}`} onClick={() => setConfig((r) => ({ ...r, count: c }))}>{c}</button>
                ))}
                <button className={`chip${config.count === 0 ? ' on' : ''}`} onClick={() => setConfig((r) => ({ ...r, count: 0 }))}>全部</button>
              </div>
            </div>
            <div className="compose-row">
              <span className="compose-label">时长</span>
              <div className="compose-chips">
                {[30, 60, 90, 120].map((m) => (
                  <button key={m} className={`chip${config.minutes === m ? ' on' : ''}`} onClick={() => setConfig((r) => ({ ...r, minutes: m }))}>{m} 分钟</button>
                ))}
                <button className={`chip${config.minutes === 0 ? ' on' : ''}`} onClick={() => setConfig((r) => ({ ...r, minutes: 0 }))}>不限时</button>
              </div>
            </div>
            <div className="compose-row">
              <span className="compose-label">范围</span>
              <div className="compose-chips">
                {([['all', '全部题目'], ['new', '没做过'], ['wrong', '做错过'], ['due', '今日待复习'], ['starred', '收藏题']] as Array<[ExamConfig['scope'], string]>).map(([v, label]) => (
                  <button key={v} className={`chip${config.scope === v ? ' on' : ''}`} onClick={() => setConfig((r) => ({ ...r, scope: v }))}>{label}</button>
                ))}
              </div>
            </div>
            <div className="compose-row">
              <span className="compose-label">章节{config.chapters.length > 0 && <b className="compose-picked">{config.chapters.length}</b>}</span>
              <div className="compose-chapters">
                {chapters.map(({ chapter, count }) => (
                  <label key={chapter || '~none'} className={`compose-chapter${config.chapters.includes(chapter) ? ' on' : ''}`}>
                    <input type="checkbox" checked={config.chapters.includes(chapter)} onChange={() => toggleChapter(chapter)} />
                    <span className="compose-chapter-name">{chapter || '未标章节'}</span>
                    <span className="muted">{count}</span>
                  </label>
                ))}
              </div>
            </div>
            <p className="muted compose-summary">本次将组 <b>{willPick}</b> 题（候选 {pool.length} 题，考试只组选择题）。</p>
            <div className="quiz-actions">
              <button className="btn-primary" disabled={willPick === 0} onClick={() => bank && beginExam(bank)}>开始考试</button>
              <button className="btn-small" onClick={() => setConfig(DEFAULT_EXAM_CONFIG)}>恢复默认</button>
            </div>
          </div>
        </DialogSurface>
      </div>
    );
  }

  // ---- 首页 ----
  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <DialogSurface className="panel quiz-panel exam-panel" label="考试中心" onClick={(e) => e.stopPropagation()}>
        {head('考试中心')}
        <div className="panel__body quiz-body">
          <div className="exam-modes">
            <button className="exam-mode" onClick={() => { setMode('exam'); setPhase('config'); }} disabled={!bank}>
              <IconQuiz /> <b>模拟考试</b>
              <span className="muted">限时整卷 · 自动评分 · 成绩报告</span>
            </button>
            <button className="exam-mode" onClick={() => { setMode('daily'); if (bank) beginDaily(bank); }} disabled={!bank}>
              <IconCards /> <b>每日一练</b>
              <span className="muted">
                {dailyDoneFlag ? `今日已完成 · 连续 ${streakDays} 天` : dailyRec ? `进行中 ${dailyRec.done}/${dailyRec.total} 题` : `连续 ${streakDays} 天 · 今日 0 题`}
              </span>
            </button>
            <button className="exam-mode" onClick={() => { setMode('wrong'); beginWrong(); }}>
              <IconTarget /> <b>错题重练</b>
              <span className="muted">答对移出错题池 · 答错加重</span>
            </button>
          </div>

          {banks.length === 0 ? (
            <div className="quiz-empty">
              <h2>还没有题库</h2>
              <p className="muted">先去「题库练习」导入题库，再回来考试。</p>
            </div>
          ) : (
            <>
              <div className="exam-bankrow">
                <span className="compose-label">题库</span>
                <select value={bankName} onChange={(e) => setBankName(e.target.value)}>
                  {banks.map((b) => <option key={b.name} value={b.name}>{b.name}（{b.questions.length} 题）</option>)}
                </select>
              </div>

              <section className="exam-hot">
                <h4><IconChart /> 高频考点（按章节题量）</h4>
                {hotChapters.length === 0 ? (
                  <p className="muted">这个题库还没有章节信息。</p>
                ) : (
                  <div className="exam-hot-list">
                    {hotChapters.map(({ chapter, total, weak }) => (
                      <div key={chapter || '~none'} className="exam-hot-row">
                        <span className="exam-hot-name">{chapter || '未标章节'}</span>
                        <span className="muted">{total} 题{weak > 0 ? ` · 易错 ${weak}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {counts && (
                <section className="exam-tags">
                  <h4>题目分级</h4>
                  <div className="exam-tag-list">
                    {(['new', 'weak', 'learning', 'solid', 'highfreq'] as QTag[]).map((t) => (
                      <span key={t} className={`exam-tag exam-tag--${t}`}>{Q_TAG_LABELS[t]} <b>{counts[t]}</b></span>
                    ))}
                  </div>
                  {diff && (
                    <div className="exam-tag-list exam-tag-list--diff">
                      {(['easy', 'medium', 'hard', 'unknown'] as DifficultyBand[]).map((d) => (
                        <span key={d} className={`exam-tag exam-tag--diff-${d}`}>难度·{DIFFICULTY_LABELS[d]} <b>{diff[d]}</b></span>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="exam-week">
                <h4>近 7 天每日一练</h4>
                <div className="exam-week-bars">
                  {week.map((d, i) => (
                    <div
                      key={d.day}
                      className={`exam-week-cell${d.done ? ' done' : d.count ? ' partial' : ''}${i === week.length - 1 ? ' today' : ''}`}
                      title={`${d.day}：${d.done ? '完成' : d.count ? `进行中 ${d.count} 题` : '未开始'}`}
                    />
                  ))}
                </div>
              </section>

              {history.length > 0 && (
                <section className="exam-history">
                  <h4>考试历史</h4>
                  {history.slice(0, 5).map((r) => (
                    <div key={r.id} className="exam-history-row">
                      <span className="exam-history-bank">{r.bankName}</span>
                      <span className={`exam-history-score${r.score < EXAM_PASS ? ' low' : ''}`}>{r.score} 分</span>
                      <span className="muted">{new Date(r.finishedAt).toLocaleDateString()} · 用时 {formatClock(r.usedMs)}</span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </DialogSurface>
    </div>
  );
}
