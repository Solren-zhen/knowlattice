/**
 * 学习状态感知：给 AI 笔记助手的四个只读工具。
 * - get_review_due：今天的复习队列（到期卡、最紧的几张、新卡数量）
 * - get_study_summary：打卡连续天数、近 7 天趋势、复习卡总量/已学/到期、把握度校准
 * - get_weak_chapters：错题本薄弱章节、错因分布与最需要回看的笔记
 * - get_quiz_progress：题库练习进度（已作答/答错/今日待复习，最薄弱的题库）
 * 数据全部来自 srs / srsCards / stats / mistakes / qbankStats 的既有纯函数——
 * 没有新存储，也不写任何东西。面板直接传自己的 docs 即可，无需从 Workspace 多接一条数据线。
 */
import type { AgentToolDef } from './aiAgent';
import type { QuizBank } from './qbank';
import { bankProgress, type StatsMap } from './qbankStats';
import { last7, streak } from './stats';
import { loadCards, scheduleOf, srsStats } from './srs';
import { buildCards, type ReviewCard } from './srsCards';
import { chapterHeat, loadMistakes, MISTAKE_REASON_LABELS, reasonCounts } from './mistakes';
import { calibrationSummary } from './qbankCalib';

export const LEARNING_TOOLS: AgentToolDef[] = [
  {
    name: 'get_review_due',
    description: '查看今天的复习队列：到期卡数量与最紧的几张卡（出自哪篇笔记哪个小节）、尚未学过的新卡数量。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_study_summary',
    description: '查看学习概况：连续打卡天数、今天与近 7 天的学习次数、复习卡总量/已学/今日到期，以及把握度校准（作答时报的自信 vs 实际正确率）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_weak_chapters',
    description: '查看错题本：复习中「忘了」的薄弱章节、错因分布（知识没记住/概念混淆/审题偏差/临床推理跳步）与最需要回看的笔记（含失败次数与最近失败时间）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_quiz_progress',
    description: '查看题库练习情况：已导入的题库、已作答/答错题数、今日待复习题，并指出最薄弱的题库。',
    parameters: { type: 'object', properties: {} },
  },
];

const DAY_MS = 86_400_000;

/** 今日到期报告：模型可据此建议「先复习再整理」或挑薄弱小节出题 */
export function reviewDueReport(paths: string[], docs: Map<string, string>, now = Date.now()): string {
  const cards = buildCards(paths.filter((p) => p.endsWith('.md')), docs);
  if (!cards.length) return '知识库里还没有笔记，没有复习卡。';
  const schedules = loadCards();
  const due: Array<{ card: ReviewCard; at: number }> = [];
  let newCount = 0;
  for (const c of cards) {
    const s = scheduleOf(schedules, c);
    if (!s) newCount++;
    else {
      const at = new Date(s.due).getTime();
      if (at <= now) due.push({ card: c, at });
    }
  }
  due.sort((a, b) => a.at - b.at);
  if (!due.length) {
    return `今天没有到期的复习卡。另有 ${newCount} 张新卡还没排程（共 ${cards.length} 张）。`;
  }
  const overdue = due.filter((d) => d.at < now - DAY_MS).length;
  const shown = due.slice(0, 8)
    .map((d) => `- ${d.card.path}「${d.card.heading || '整篇'}」`);
  const rest = due.length - shown.length;
  return [
    `今日到期 ${due.length} 张卡${overdue ? `（其中逾期 ${overdue} 张）` : ''}；新卡 ${newCount} 张；共 ${cards.length} 张。`,
    '最紧的几张：',
    ...shown,
    ...(rest > 0 ? [`…（其余 ${rest} 张省略）`] : []),
  ].join('\n');
}

/**
 * 把握度校准一句话：只报事实（平均自信 vs 实际答对），让模型自己决定怎么提醒。
 * 样本为 0 时明说「还没有样本」，避免模型凭空推断用户的自我评估水平。
 */
function calibrationLine(): string {
  const cal = calibrationSummary();
  if (!cal.n) return '把握度校准：还没有样本（在题库作答前选一个把握程度就会开始记录）。';
  const mean = cal.buckets.reduce((a, b) => a + b.confidence * b.n, 0) / cal.n / 5;
  const acc = cal.correct / cal.n;
  const diff = cal.overconfidence * 100;
  const verdict = Math.abs(diff) < 3
    ? '校准得不错'
    : diff > 0 ? `高估 ${Math.round(diff)} 个百分点` : `低估 ${Math.round(-diff)} 个百分点`;
  return `把握度校准：${cal.n} 次作答报了把握度，平均自信 ${Math.round(mean * 100)}%、实际答对 ${Math.round(acc * 100)}% —— ${verdict}。`;
}

/** 学习概况报告：打卡（复习/做题行为）＋复习卡调度总览＋把握度校准 */
export function studySummaryReport(paths: string[], docs: Map<string, string>, now = Date.now()): string {
  const days = last7();
  const total7 = days.reduce((acc, d) => acc + d.count, 0);
  const today = days[days.length - 1].count;
  const cards = buildCards(paths.filter((p) => p.endsWith('.md')), docs);
  const st = srsStats(cards, now);
  return [
    `连续打卡 ${streak()} 天；今天学习 ${today} 次，近 7 天共 ${total7} 次。`,
    `复习卡：共 ${st.total} 张，已进入调度 ${st.learned} 张，今日到期 ${st.dueNow} 张。`,
    calibrationLine(),
  ].join('\n');
}

/** 错题本报告：薄弱章节 + 错因分布 + 最需要回看的笔记——agent 可据此 read_note 后补提示键或出题 */
export function weakChaptersReport(now = Date.now()): string {
  const mistakes = loadMistakes();
  const records = Object.values(mistakes);
  if (!records.length) return '错题本是空的。复习时点「忘了」的记录会出现在这里。';
  const total = records.reduce((a, r) => a + r.count, 0);
  const heat = chapterHeat(mistakes);
  const shownChapters = heat.slice(0, 6).map((h) => `- ${h.chapter}：${h.count} 次`);
  // 错因分布：按条数（一条错题一个错因），与错题本面板上的分布条同源；都未标注时如实说明
  const reasons = reasonCounts();
  const labeled = reasons.reduce((a, r) => a + r.count, 0);
  const unlabeled = reasons[0]?.unlabeled ?? 0;
  const reasonLine = labeled
    ? `错因分布（已标注 ${labeled} 条）：${reasons.map((r) => `${MISTAKE_REASON_LABELS[r.reason]} ${r.count}`).join('、')}${unlabeled ? `；未标注 ${unlabeled} 条` : ''}。`
    : `错因分布：${records.length} 条错题都还没标注错因（错题本里每条可标 知识没记住 / 概念混淆 / 审题偏差 / 临床推理跳步）。`;
  const notes = [...records].sort((a, b) => b.count - a.count || b.lastFailedAt - a.lastFailedAt);
  const shownNotes = notes.slice(0, 8).map((r) => {
    const days = Math.floor((now - r.lastFailedAt) / DAY_MS);
    const ago = days <= 0 ? '今天' : `${days} 天前`;
    const reason = r.reason && MISTAKE_REASON_LABELS[r.reason] ? `（${MISTAKE_REASON_LABELS[r.reason]}）` : '';
    return `- ${r.path}「${r.title}」${r.count} 次（最近 ${ago}）${reason}`;
  });
  const rest = notes.length - shownNotes.length;
  return [
    `错题共 ${records.length} 处（累计 ${total} 次），集中在 ${heat.length} 个章节。`,
    '最薄弱的章节：',
    ...shownChapters,
    reasonLine,
    '最需要回看的笔记：',
    ...shownNotes,
    ...(rest > 0 ? [`…（其余 ${rest} 条省略）`] : []),
  ].join('\n');
}

/**
 * 题库练习报告：整体进度 + 最薄弱的题库 + 今日待复习最多的题库。
 * 与错题本（按笔记路径）是两条线：这里按**题目**看练习表现，agent 可据此建议练哪个库。
 */
export function quizProgressReport(banks: QuizBank[], stats: StatsMap, now = Date.now()): string {
  if (!banks.length) return '还没有导入题库。可在「题库练习」面板导入 JSON / Word / Excel 题库后再来查看。';
  const rows = banks.map((b) => ({
    name: b.name,
    ...bankProgress(b.name, b.questions.map((q) => q.id), stats, now),
  }));
  const totalQ = rows.reduce((a, r) => a + r.total, 0);
  const totalSeen = rows.reduce((a, r) => a + r.seen, 0);
  const totalWrong = rows.reduce((a, r) => a + r.wrong, 0);
  const totalDue = rows.reduce((a, r) => a + r.due, 0);
  const active = rows.filter((r) => r.seen > 0);
  if (!active.length) {
    return `共 ${banks.length} 个题库、${totalQ} 道题，还没有作答记录。可以先随机组卷练一轮。`;
  }
  const weak = [...active]
    .sort((a, b) => b.wrong - a.wrong || b.seen - a.seen)
    .slice(0, 6)
    .map((r) => `- ${r.name}：做过 ${r.seen}/${r.total} 题，有错题 ${r.wrong} 题，今日待复习 ${r.due} 题`);
  const due = active
    .filter((r) => r.due > 0)
    .sort((a, b) => b.due - a.due)
    .slice(0, 6)
    .map((r) => `- ${r.name}：${r.due} 题`);
  return [
    `题库练习：共 ${banks.length} 个题库、${totalQ} 道题；已作答 ${totalSeen} 题，有错题 ${totalWrong} 题，今日待复习 ${totalDue} 题。`,
    '最薄弱的题库：',
    ...weak,
    ...(due.length ? ['今日待复习最多的题库：', ...due] : []),
  ].join('\n');
}
