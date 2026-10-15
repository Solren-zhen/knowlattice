/**
 * 知识点反查：把「一批题目 + 逐题统计」按知识点（章节名）聚合成一张**可排序**的表，
 * 用来回答「这个知识点有多少题 / 我做过几题 / 正确率多少 / 我错得最多的是哪道 / 该看哪篇笔记」。
 *
 * 为什么是薄的一层、而不是又一次聚合（这条最要紧）：
 *   逐章聚合在本仓库已经有两处权威实现，本模块**一行聚合数学都不重算**，全部委托出去：
 *     - 题数（成员判定：一题多章节在每章各计一次）→ `qbankCompose.ts:221` chapterCounts
 *     - 已做 / 错题 / 正确率 / 样本不足的 weak 阈值（MASTERY_MIN_SEEN、MASTERY_WEAK_ACCURACY）
 *                                                → `qbankStats.ts:314` chapterMastery
 *     - 章节名 → 笔记路径                        → `qbankNotes.ts:40` buildChapterIndex 产出的 Map
 *   自己算一遍等于埋下第三套口径：同一个章节在热力图、组题软门控、反查表里给出不同正确率，
 *   用户看到的不是「三处都在说同一件事」，而是「统计在变」。
 *
 * 本模块只补三件现有函数确实没有的东西（其余都是转发）：
 *   ① 「错得最多的题」：全库没有任何函数按逐题累计答错次数（`QStat.wrong`，qbankStats.ts:40）
 *      排名取最大。`qbankCompose.ts:105` filterPool 只给「答错过」的**集合**，而且它的抽取顺序
 *      来自加权随机（weightOf → weightedPick），不是排名，不能拿来当「最错的那道」。
 *   ② 把「还没有作答记录的知识点」也列进表里：`qbankStats.ts:317` 的 chapterMastery 明确跳过
 *      没作答过的题（那是刻意的——不让「还没练」以 0% 出现被误报成「掌握差」，见其注释）。
 *      但反查问的第一件事恰恰是「这知识点有多少题」，所以 total 这一列必须带上未做过的知识点；
 *      同时沿用既有阈值让它们的 weak 恒为 false，不把「没练过」说成「掌握差」。
 *   ③ 确定性排序：前两列（正确率、样本数）都会并列，没有写死的 tie-break，界面顺序会抖。
 *
 * 纯函数：不读 localStorage / IndexedDB，不碰 DOM，不引入新依赖。
 * 逐题统计由调用方传入（`StatsMap[题库名]` 就是这里的 `stats`，见 qbankStats.ts:44-47 `BankStats`）。
 */
import { chaptersOf, type QuizQuestion } from './qbank';
import { chapterMastery, type QStat } from './qbankStats';
import { chapterCompare, chapterCounts } from './qbankCompose';

/** 一道题在一张反查表里的位置。字段与调用方要显示的列一一对应 */
export interface KnowledgeRow {
  /** 知识点名：题目 `chapters` / `chapter` 的原文；题目什么都没标时是空串（既有「未标注」档，不新开档位） */
  knowledge: string;
  /** 该知识点下的题目总数（含没作答过的）；一题多章节时在每个所属章节里各计一次 */
  total: number;
  /** 有作答记录的题数 */
  seen: number;
  /**
   * 从未答错过的题数 = seen − wrong。
   * 口径继承 chapterMastery：**按题**而不是按次——一道题错过一次就算错过，
   * 反复重刷同一道题不会把正确率压成 0（qbankStats.ts:292）。
   */
  correct: number;
  /** 作答过的题里答错过的题数 */
  wrong: number;
  /** correct / seen；seen 为 0 时记 0（见下面的除零说明），永远不会是 NaN */
  accuracy: number;
  /** 样本够且正确率偏低；阈值与判定沿用 chapterMastery（qbankStats.ts:296-297） */
  weak: boolean;
  /** 该知识点里累计答错次数最多的题；一道都没错过时为 null */
  topWrong: { id: string; stem: string; wrong: number } | null;
  /** 该知识点对应的题库笔记路径；没有索引或没命中时为 null */
  notePath: string | null;
}

/** 空知识点名那一档（题目没标章节）。与 chapterMastery / filterPool / chapterCounts 的既有档位一致 */
const UNLABELED = '';

/**
 * 题目所属的知识点键。**必须**与 chapterMastery 第 326 行逐字同口径：
 * chaptersOf 为空数组时折成 ['']，空章节继续作为「未标注」一档参与聚合，不悄悄丢掉这些题。
 */
const keysOf = (q: QuizQuestion): string[] => {
  const keys = chaptersOf(q);
  return keys.length ? keys : [UNLABELED];
};

/**
 * 按知识点聚合。`stats` 是「题目 id → 逐题记录」（qbankStats.ts 的 BankStats）。
 *
 * @param questions   题目数组（一般就是 `QuizBank.questions`）
 * @param stats       逐题历史；缺省视作「一条记录都没有」
 * @param chapterIndex `qbankNotes.ts:40` buildChapterIndex 的产物；给了才有 notePath
 *
 * 返回的数组已排好序（见下方 sort 的三级 tie-break），调用方别再自己排——
 * 排两遍就会出现「同一批数据两处顺序不同」。
 */
export function knowledgeLookup(
  questions: QuizQuestion[],
  stats: Record<string, QStat> = {},
  chapterIndex?: Map<string, string>,
): KnowledgeRow[] {
  // ① 每个知识点的题目总数：直接复用 chapterCounts（成员判定与组题弹窗的章节 chip 同一口径）。
  const totals = new Map<string, number>();
  for (const { chapter, count } of chapterCounts(questions)) totals.set(chapter, count);

  // ② 已做 / 错题 / 正确率 / weak：直接复用 chapterMastery。
  //    chapterMastery 的签名要一个 QuizBank 并从 `stats[bank.name]` 取逐题记录，所以给一个
  //    占位题库名——它不是「题库」，只是把同一份逐题记录喂进去的壳；不这样借一次，
  //    本文件就得把 seen/wrong/accuracy/weak 与阈值再写一遍（那才是真正的重复实现）。
  const mastery = chapterMastery(
    { name: UNLABELED, importedAt: 0, questions },
    { [UNLABELED]: stats },
  );
  const masteryBy = new Map(mastery.map((m) => [m.chapter, m] as const));

  // ③ 错得最多的题：一次遍历取每个知识点的最大 QStat.wrong。
  const top = new Map<string, { id: string; stem: string; wrong: number }>();
  for (const q of questions) {
    const wrong = stats[q.id]?.wrong ?? 0;
    if (wrong <= 0) continue; // 没错过的题不参与排名，于是没错过任何题的知识点自然得到 null
    for (const key of keysOf(q)) {
      const cur = top.get(key);
      // 同分时按题目 id 升序取：不写这条，同一批数据换个输入顺序就会给出另一道「最错的题」，
      // 界面上表现为「刷新一下最薄弱的那道题换了」，会被当成统计出错。
      if (!cur || wrong > cur.wrong || (wrong === cur.wrong && q.id < cur.id)) {
        top.set(key, { id: q.id, stem: q.stem, wrong });
      }
    }
  }

  // ④ 键集合 = 有题目的知识点 ∪ 有作答记录的知识点（后者含没标章节那一档）。
  //    并集而不是交集：没作答过的知识点也要出现（见文件头 ②），它的 seen/wrong 自然为 0。
  const keys = new Set<string>([...totals.keys(), ...masteryBy.keys()]);
  const rows: KnowledgeRow[] = [...keys].map((knowledge) => {
    const m = masteryBy.get(knowledge);
    const seen = m?.seen ?? 0;
    const wrong = m?.wrong ?? 0;
    return {
      knowledge,
      // 键一定来自 totals（上面并集的第一项）；`?? seen` 只是防御，避免出现 undefined 参与显示
      total: totals.get(knowledge) ?? seen,
      seen,
      correct: seen - wrong,
      wrong,
      // 除零：seen 为 0 时记 0 而不是 0/0（NaN 会让界面显示 "NaN%" 且所有比较都不成立）。
      // 这与 chapterMastery 第 335 行的写法一致（那里对 0 样本也记 0）。
      accuracy: m ? m.accuracy : 0,
      // 没作答记录的知识点 weak 恒为 false：口径沿用既有阈值（seen < MASTERY_MIN_SEEN 即不判弱），
      // 把「还没练」与「掌握差」继续分开，与 chapterMastery 的注释同一理由。
      weak: m?.weak ?? false,
      topWrong: top.get(knowledge) ?? null,
      // 章节名 → 笔记路径：复用 buildChapterIndex 的键（键含学科，所以是精确匹配，
      // 见 qbankNotes.ts:16-21 为什么不能用 resolveLink 按名字解析）。
      notePath: chapterIndex?.get(knowledge) ?? null,
    };
  });

  return rows.sort(
    (a, b) =>
      // 第一级：有作答记录的先出。反查表的用途是看「我哪里薄弱」，没练过的知识点没有表现可看，
      // 排在最后不打扰；否则它们正确率恒为 0，会把真正薄弱的章节全挤到后面去。
      (a.seen > 0 ? 0 : 1) - (b.seen > 0 ? 0 : 1) ||
      // 第二级：与 chapterMastery（热力图 / 组题软门控）逐字同序——正确率低的在前，同率样本多的在前。
      // 换一套顺序（比如按题数）会让三处对同一批数据给出不同的「最该看哪个」，反而更难解释。
      a.accuracy - b.accuracy ||
      b.seen - a.seen ||
      // 第三级：章节名自然序（chapterCompare：「第6章」排在「第10章」前）。
      // 前两级都能并列（两个没练过的知识点 accuracy/seen 都是 0/0），没有这一级排序就不确定。
      chapterCompare(a.knowledge, b.knowledge),
  );
}
