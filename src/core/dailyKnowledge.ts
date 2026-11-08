/**
 * 今日知识点：每天从题库里挑**一个**知识点/章节，给出「它现在什么状况 + 练哪几题」。
 *
 * 为什么单独做这件事：题库面板回答的是「题库有多少题」，复习面板回答的是「哪张卡到期」，
 * 中间缺一层——「今天这一个知识点该不该补」。四个参考 App 里，这一层都是它们留存的核心
 * （今日知识点/今日打卡/智能错题），而它不需要任何新数据源：章节、逐题历史、到期时间
 * 都已经在本机了，这里只是把它们按「今天该看哪个」重新排一次。
 *
 * 取舍：
 * - **只按真实信号排序**（错题次数、是否到期、是否做过），没有信号的一律当新知识点。
 *   不编「重要程度」「考频」这类题库里没有的字段。
 * - **同一天结果固定**：用日期串参与排序，上午看到的知识点和下午看到的是同一个，
 *   否则每次刷新都换一个，等于没有「今日」。
 * - 题量太少的章节不算（< MIN_COUNT）：一道题的章节练不出掌握度，只会让统计抖动。
 */
import { chaptersOf, type QuizBank } from './qbank';
import { isDue, statOf, type StatsMap } from './qbankStats';
import { todayKey } from './dateKey';

export interface KnowledgePick {
  /** 本地日期 YYYY-MM-DD：判断「今天看过没有」的口径 */
  date: string;
  bank: string;
  chapter: string;
  /** 为什么今天推它：有错题 / 到期 / 还没做过 */
  reason: 'wrong' | 'due' | 'fresh';
  /** 该知识点下的题数（可能被「只看章节」拆开，这里按章节口径统计） */
  count: number;
  wrong: number;
  due: number;
  /** 已做题数 / 正确次数 → 掌握度（0~1）；没做过是 0 */
  mastery: number;
}

/** 太少的章节不进候选：一题一章练不出掌握度 */
const MIN_COUNT = 3;

/**
 * 挑今天该看的知识点。没有可用题库/章节时返回 null（面板据此不显示这条）。
 *
 * 打分（分数越高越该看）：错题 ×3、到期 ×2、做过但正确率低 ×2、没做过 ×1。
 * 同分时按「日期 + 知识点名」的稳定哈希排——同一天固定，换天才变。
 */
export function pickTodayKnowledge(
  banks: QuizBank[],
  stats: StatsMap,
  now = Date.now(),
): KnowledgePick | null {
  const date = todayKey(now);
  const picks: KnowledgePick[] = [];
  for (const bank of banks) {
    const byChapter = new Map<string, { count: number; wrong: number; due: number; seen: number; right: number }>();
    for (const q of bank.questions) {
      for (const ch of chaptersOf(q)) {
        const agg = byChapter.get(ch) ?? { count: 0, wrong: 0, due: 0, seen: 0, right: 0 };
        agg.count += 1;
        const st = statOf(stats, bank.name, q.id);
        if (st) {
          agg.wrong += st.wrong ?? 0;
          if (isDue(st, now)) agg.due += 1;
          agg.seen += (st.reps ?? 0) > 0 ? 1 : 0;
          agg.right += (st.reps ?? 0) > 0 && (st.wrong ?? 0) === 0 ? 1 : 0;
        }
        byChapter.set(ch, agg);
      }
    }
    for (const [chapter, agg] of byChapter) {
      if (agg.count < MIN_COUNT) continue;
      const mastery = agg.seen > 0 ? agg.right / agg.seen : 0;
      const reason: KnowledgePick['reason'] = agg.wrong > 0 ? 'wrong' : agg.due > 0 ? 'due' : 'fresh';
      picks.push({ date, bank: bank.name, chapter, reason, count: agg.count, wrong: agg.wrong, due: agg.due, mastery });
    }
  }
  if (!picks.length) return null;

  const score = (p: KnowledgePick): number =>
    p.wrong * 3 + p.due * 2 + (p.reason === 'fresh' ? 1 : 0) + (p.mastery > 0 && p.mastery < 0.6 ? 2 : 0);
  // 稳定的同分顺序：日期串 + 银行名 + 章节名的字符和。不用随机数——刷新不该换知识点。
  const tie = (p: KnowledgePick): number => {
    const s = `${p.date}|${p.bank}|${p.chapter}`;
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return h;
  };
  picks.sort((a, b) => score(b) - score(a) || tie(a) - tie(b));
  return picks[0];
}

/** 今日知识点的「看过了」标记：存 `日期|题库|章节`，换天自然失效 */
export const KNOWLEDGE_DONE_KEY = 'knowlattice-daily-knowledge';

export function isKnowledgeDone(pick: KnowledgePick): boolean {
  try {
    return localStorage.getItem(KNOWLEDGE_DONE_KEY) === `${pick.date}|${pick.bank}|${pick.chapter}`;
  } catch {
    // 存储不可用时当作没看过：宁可多推一次，也不能让整块面板打不开
    return false;
  }
}

export function markKnowledgeDone(pick: KnowledgePick): boolean {
  try {
    localStorage.setItem(KNOWLEDGE_DONE_KEY, `${pick.date}|${pick.bank}|${pick.chapter}`);
    return true;
  } catch {
    return false;
  }
}
