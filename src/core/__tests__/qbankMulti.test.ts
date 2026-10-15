import { describe, expect, it } from 'vitest';
import {
  chaptersOf,
  correctIndices,
  explanationsFrom,
  explanationsOf,
  groupTogether,
  isCorrectPick,
  isMultiSelect,
  normalizeQuestions,
  pickQuestions,
  rowsToQuestions,
  type QuizBank,
  type QuizQuestion,
} from '../qbank';
import { bankToAnki } from '../anki';
import { chapterMastery, type QStat, type StatsMap } from '../qbankStats';
import { DEFAULT_RULES, chapterCounts, filterPool, type ComposeRules } from '../qbankCompose';
const OPTS = ['甲选项', '乙选项', '丙选项', '丁选项'];

const base = (extra: Record<string, unknown>) => ({
  stem: '题干？',
  options: OPTS,
  ...extra,
});

const first = (extra: Record<string, unknown>): QuizQuestion => normalizeQuestions([base(extra)])[0];

describe('多选（X 型）解析', () => {
  it('answers 数组 → answers 记全集，answer 记第一项', () => {
    const q = first({ answers: [0, 2] });
    expect(q.type).toBe('choice');
    expect(q.answers).toEqual([0, 2]);
    expect(q.answer).toBe(0);
    expect(isMultiSelect(q)).toBe(true);
    expect(correctIndices(q)).toEqual([0, 2]);
    // answerText 把两项都写出来，复习/错题本才不会只显示一半
    expect(q.answerText).toContain('A. 甲选项');
    expect(q.answerText).toContain('C. 丙选项');
  });

  it('连续字母串 "AC" / "A、C" 都算多选', () => {
    expect(first({ answer: 'AC' }).answers).toEqual([0, 2]);
    expect(first({ answer: 'A、C' }).answers).toEqual([0, 2]);
    expect(first({ answers: ['甲选项', '丙选项'] }).answers).toEqual([0, 2]);
  });

  it('单个答案仍是单选，且 answers 不出现（既有数据与单测行为不变）', () => {
    const a = first({ answer: 2 });
    expect(a.answer).toBe(2);
    expect(a.answers).toBeUndefined();
    expect(isMultiSelect(a)).toBe(false);
    expect(a.answerText).toBe('丙选项');
  });

  it('"B." 这种带标点的单字母不会被拆成多选', () => {
    const q = first({ answer: 'B.' });
    expect(q.answers).toBeUndefined();
    expect(q.answer).toBe(1);
  });

  it('空的 answers 不能顶掉有效的 answer（`??` 只挡 null/undefined）', () => {
    // 导出器常把"没有多选答案"的题写成 answers: []，此时必须退回 answer
    const a = first({ answers: [], answer: 2 });
    expect(a.type).toBe('choice');
    expect(a.answer).toBe(2);
    expect(a.answerText).toBe('丙选项');

    const b = first({ answers: '   ', answer: 1 });
    expect(b.type).toBe('choice');
    expect(b.answer).toBe(1);
  });

  it('全对才算对：少选、多选、错选都算错', () => {
    const q = first({ answers: [0, 2] });
    expect(isCorrectPick(q, [0, 2])).toBe(true);
    expect(isCorrectPick(q, [2, 0])).toBe(true); // 顺序无关
    expect(isCorrectPick(q, [0])).toBe(false); // 少选
    expect(isCorrectPick(q, [0, 1, 2])).toBe(false); // 多选
    expect(isCorrectPick(q, [1, 2])).toBe(false); // 错选
    expect(isCorrectPick(q, [])).toBe(false);
  });

  it('越界与重复下标被丢掉/去重', () => {
    const q = first({ answers: [0, 0, 9] });
    expect(correctIndices(q)).toEqual([0]);
    expect(isMultiSelect(q)).toBe(false); // 去重后只剩一个 → 按单选处理
  });

  it('Excel 行（rowsToQuestions）也能吃多选', () => {
    const qs = rowsToQuestions([
      { stem: '题干？', A: '甲', B: '乙', C: '丙', D: '丁', answers: 'AB' },
    ]);
    expect(qs[0].answers).toEqual([0, 1]);
    expect(isMultiSelect(qs[0])).toBe(true);
  });
});

describe('一题多套解析', () => {
  it('推荐写法：数组 + source', () => {
    const ex = explanationsFrom({
      explanations: [
        { source: '小亮老师版', text: '甲老师这么讲' },
        { source: '天天师兄版', text: '乙老师这么讲' },
      ],
    });
    expect(ex).toEqual([
      { source: '小亮老师版', text: '甲老师这么讲' },
      { source: '天天师兄版', text: '乙老师这么讲' },
    ]);
  });

  it('键值映射写法', () => {
    expect(explanationsFrom({ explanations: { 甲版: 'A 讲法', 乙版: 'B 讲法' } })).toEqual([
      { source: '甲版', text: 'A 讲法' },
      { source: '乙版', text: 'B 讲法' },
    ]);
  });

  it('同业题库的 jiexiArr 形状（analysis 富文本）能直投', () => {
    const ex = explanationsFrom({
      jiexiArr: {
        小亮老师版: {
          analysis: [
            { type: 'text', content: '第一段' },
            { type: 'text', content: '第二段' },
          ],
          jypage: '12',
        },
      },
    });
    expect(ex).toEqual([{ source: '小亮老师版', text: '第一段\n第二段' }]);
  });

  it('解析不出内容时不留下空条目', () => {
    expect(explanationsFrom({ explanations: [] })).toEqual([]);
    expect(explanationsFrom({ explanations: { 甲版: '   ' } })).toEqual([]);
    expect(explanationsFrom({})).toEqual([]);
  });

  it('只有单条 explanation 时，explanationsOf 也返回它（调用方不必分两路）', () => {
    expect(explanationsOf({ explanation: '单条解析' } as QuizQuestion)).toEqual([
      { source: '', text: '单条解析' },
    ]);
    expect(explanationsOf({} as QuizQuestion)).toEqual([]);
  });

  it('随题目一起被解析出来', () => {
    const q = first({ answer: 0, jiexiArr: { 甲版: { analysis: [{ content: '讲法' }] } } });
    expect(q.explanations).toEqual([{ source: '甲版', text: '讲法' }]);
    expect(q.explanation).toBeUndefined();
  });
});

describe('Anki 导出对多选与多套解析的处理', () => {
  const bank = (questions: QuizQuestion[]) => ({ name: '题库', importedAt: 1, questions });

  it('多选把正确字母全列出来（只印第一个会导出错的答案）', () => {
    const tsv = bankToAnki(bank([first({ answers: [0, 2] })]));
    const back = tsv.split('\t')[1];
    expect(back).toContain('答案：A、C.');
  });

  it('单选仍是 "A. 选项原文"（既有导出不变）', () => {
    const tsv = bankToAnki(bank([first({ answer: 1 })]));
    expect(tsv.split('\t')[1]).toContain('答案：B. 乙选项');
  });

  it('多套解析全部导出并带来源名', () => {
    const q = first({
      answer: 0,
      explanations: [
        { source: '甲版', text: '甲讲法' },
        { source: '乙版', text: '乙讲法' },
      ],
    });
    const back = bankToAnki(bank([q])).split('\t')[1];
    expect(back).toContain('解析（甲版）：甲讲法');
    expect(back).toContain('解析（乙版）：乙讲法');
  });
});

describe('A3/A4 共用题干题组', () => {
  const CASE = '男，62 岁，突发胸痛 2 小时。心电图 V1–V4 导联 ST 段抬高。';
  const grouped = () => ({
    stem: CASE,
    chapter: '内科学',
    sub: [
      { stem: '最可能的诊断是？', options: ['急性心梗', '肺栓塞'], answer: 0 },
      { stem: '首选的处理是？', options: ['再灌注治疗', '观察'], answer: 0 },
      { options: ['肌钙蛋白', 'D-二聚体'], answer: 0 },
    ],
  });

  it('一段病例 + 若干小问 → 展开成多道独立题，各自带组内序号', () => {
    const qs = normalizeQuestions([grouped()]);
    expect(qs).toHaveLength(3);
    expect(qs.map((x) => x.groupNo)).toEqual([1, 2, 3]);
    expect(qs.every((x) => x.groupTotal === 3)).toBe(true);
    expect(new Set(qs.map((x) => x.groupId)).size).toBe(1);
    expect(qs.every((x) => x.groupStem === CASE)).toBe(true);
    // id 必须互不相同：id 是逐题统计的键，撞了两问会共用一份答题记录
    expect(new Set(qs.map((x) => x.id)).size).toBe(3);
  });

  it('小问没写题干时用「第 n 问」兜底，而不是被静默丢掉', () => {
    expect(normalizeQuestions([grouped()])[2].stem).toBe('第 3 问');
  });

  it('小问继承外层章节；自己写了就用自己的', () => {
    const caseOnly = {
      stem: CASE,
      chapter: '内科学',
      sub: [
        { stem: 'a？', options: ['甲', '乙'], answer: 0 },
        { stem: 'b？', options: ['甲', '乙'], answer: 0, chapter: '心血管' },
      ],
    };
    const qs = normalizeQuestions([caseOnly]);
    expect(qs[0].chapter).toBe('内科学');
    expect(qs[1].chapter).toBe('心血管');
  });

  it('单个小问也算题组（否则外层没有答案，整条会被丢掉）', () => {
    const one = { stem: CASE, sub: [{ stem: 'a？', options: ['甲', '乙'], answer: 0 }] };
    const qs = normalizeQuestions([one]);
    expect(qs).toHaveLength(1);
    expect(qs[0].groupTotal).toBe(1);
    expect(qs[0].groupStem).toBe(CASE);
  });

  it('外层没有题干文字时，各小问当独立题处理（不塞空病例框）', () => {
    const noCase = { sub: [{ stem: 'a？', options: ['甲', '乙'], answer: 0 }] };
    const qs = normalizeQuestions([noCase]);
    expect(qs).toHaveLength(1);
    expect('groupStem' in qs[0]).toBe(false);
    expect('groupId' in qs[0]).toBe(false);
  });

  it('普通题完全不出现题组字段（既有对象形状不变）', () => {
    const plain = first({ answer: 0 });
    for (const k of ['groupStem', 'groupNo', 'groupTotal', 'groupId']) expect(k in plain).toBe(false);
  });
});

describe('groupTogether 组卷保序', () => {
  const mk = (id: string, groupId?: string, groupNo?: number): QuizQuestion => ({
    id,
    type: 'choice',
    stem: id,
    options: ['甲', '乙'],
    answer: 0,
    answerText: '甲',
    ...(groupId ? { groupId } : {}),
    ...(groupNo ? { groupNo } : {}),
  });

  it('同组小问被排到一起，并按组内序号升序', () => {
    const input = [mk('a', 'g1', 2), mk('b'), mk('c', 'g1', 1)];
    const got = groupTogether(input).map((x) => x.id);
    expect(got).toEqual(['c', 'a', 'b']);
  });

  it('未分组的题保持原本相对顺序', () => {
    const input = [mk('b'), mk('a', 'g1', 1), mk('d')];
    const got = groupTogether(input).map((x) => x.id);
    expect(got).toEqual(['b', 'a', 'd']);
  });

  it('没有题组时原样返回同一个数组引用（既有路径零代价）', () => {
    const arr = [mk('a'), mk('b')];
    expect(groupTogether(arr)).toBe(arr);
  });

  it('pickQuestions 抽出的卷子里同组小问连在一起', () => {
    const questions = [mk('a', 'g1', 1), mk('s1'), mk('b', 'g1', 2), mk('s2'), mk('s3')];
    const picked = pickQuestions({ name: 'B', importedAt: 1, questions });
    expect(picked).toHaveLength(5);
    const at = picked.findIndex((x) => x.groupId === 'g1');
    expect(picked[at + 1].groupId).toBe('g1');
    expect(picked[at].groupNo).toBe(1);
  });
});

describe('选项级图片', () => {
  it('显式的 optionImages 数组按下标对齐，缺位为 null', () => {
    const q = first({ answer: 0, optionImages: ['_attachments/a.png', '', '_attachments/c.png'] });
    expect(q.optionImages).toEqual(['_attachments/a.png', null, '_attachments/c.png', null]);
  });

  it('选项写成 { text, image } 对象数组也能解析出文案与图', () => {
    const item = {
      stem: '看图选？',
      options: [{ text: '甲图', image: '_attachments/a.png' }, { text: '乙图' }],
      answer: 0,
    };
    const q = normalizeQuestions([item])[0];
    expect(q.options).toEqual(['甲图', '乙图']);
    expect(q.optionImages).toEqual(['_attachments/a.png', null]);
  });

  it('没有图的题不带 optionImages 键（形状不变）', () => {
    expect('optionImages' in first({ answer: 0 })).toBe(false);
  });
});

describe('Anki 导出带上共用题干', () => {
  it('小问的正面里含病例原文与「第几问」', () => {
    const item = {
      stem: '病例原文',
      sub: [
        { stem: 'a？', options: ['甲', '乙'], answer: 0 },
        { stem: 'b？', options: ['甲', '乙'], answer: 0 },
      ],
    };
    const qs = normalizeQuestions([item]);
    const front = bankToAnki({ name: 'B', importedAt: 1, questions: qs }).split('\t')[0];
    expect(front).toContain('共用题干 · 第 1/2 问');
    expect(front).toContain('病例原文');
  });
});

describe('题组解析不能吞掉外层那道题', () => {
  it('sub/children 装了与题目无关的东西时，外层题照常成立', () => {
    const item = {
      stem: '正常题干？',
      options: ['甲', '乙'],
      answer: 0,
      children: [{ foo: 'bar' }],
    };
    const qs = normalizeQuestions([item]);
    expect(qs).toHaveLength(1);
    expect(qs[0].stem).toBe('正常题干？');
    expect('groupStem' in qs[0]).toBe(false);
  });

  it('小问全是空对象时也不会把外层题吞掉', () => {
    const item = { stem: '正常题干？', options: ['甲', '乙'], answer: 0, sub: [{}] };
    const qs = normalizeQuestions([item]);
    expect(qs).toHaveLength(1);
    expect(qs[0].stem).toBe('正常题干？');
  });
});

describe('一题多章节（chapters）', () => {
  it('只给 chapter：chaptersOf 返回 [chapter]，且不新增 chapters 键（对象形状不变）', () => {
    const q = first({ answer: 0, chapter: '生理学' });
    expect(q.chapter).toBe('生理学');
    expect('chapters' in q).toBe(false);
    expect(chaptersOf(q)).toEqual(['生理学']);
  });

  it("chapters: ['A','B'] → chaptersOf 返回两项，且 chapter 补成 chapters[0]", () => {
    const q = first({ answer: 0, chapters: ['A', 'B'] });
    expect(q.chapters).toEqual(['A', 'B']);
    expect(q.chapter).toBe('A');
    expect(chaptersOf(q)).toEqual(['A', 'B']);
  });

  it('单值 chapter 与 chapters 同时给：chapter 仍取单值字段（语义不变）', () => {
    const q = first({ answer: 0, chapter: '内科学', chapters: ['生理学', '心血管'] });
    expect(q.chapter).toBe('内科学');
    expect(q.chapters).toEqual(['生理学', '心血管']);
    expect(chaptersOf(q)).toEqual(['生理学', '心血管']);
  });

  it('不足两项 / 全是空白 → 不带 chapters 键（对象形状不变）', () => {
    const one = first({ answer: 0, chapters: ['A'] });
    expect('chapters' in one).toBe(false);
    expect(one.chapter).toBe('A');
    expect(chaptersOf(one)).toEqual(['A']);

    const blanks = first({ answer: 0, chapters: ['   ', '', '\t'] });
    expect('chapters' in blanks).toBe(false);
    expect(blanks.chapter).toBeUndefined();
    expect(chaptersOf(blanks)).toEqual([]);
  });

  it('重复项去重、去空白、保序', () => {
    const q = first({ answer: 0, chapters: ['A', 'A', ' B ', 'A'] });
    expect(q.chapters).toEqual(['A', 'B']);
    expect(chaptersOf(q)).toEqual(['A', 'B']);
  });

  it('字符串写法按 , ， 、 ; 拆开', () => {
    expect(first({ answer: 0, chapters: '生理学、心血管' }).chapters).toEqual(['生理学', '心血管']);
    expect(first({ answer: 0, chapters: '生理学，心血管' }).chapters).toEqual(['生理学', '心血管']);
    expect(first({ answer: 0, chapters: '生理学, 心血管; 病理学' }).chapters).toEqual([
      '生理学',
      '心血管',
      '病理学',
    ]);
  });

  it('同业题库的字段名（chapterList / 章节s / 多章节 / 知识点）都认', () => {
    expect(first({ answer: 0, chapterList: ['甲', '乙'] }).chapters).toEqual(['甲', '乙']);
    expect(first({ answer: 0, 章节s: ['甲', '乙'] }).chapters).toEqual(['甲', '乙']);
    expect(first({ answer: 0, 多章节: '甲、乙' }).chapters).toEqual(['甲', '乙']);
    expect(first({ answer: 0, 知识点: '甲、乙' }).chapters).toEqual(['甲', '乙']);
  });

  it('空题（无 chapter 也无 chapters）→ chaptersOf 返回 []', () => {
    expect(chaptersOf(first({ answer: 0 }))).toEqual([]);
  });

  it('A3/A4 小问走同一套多章节解析；只有外层单值 chapter 时仍是旧口径', () => {
    const qs = normalizeQuestions([
      {
        stem: '病例',
        chapter: '内科学',
        sub: [
          { stem: 'a？', options: ['甲', '乙'], answer: 0, chapters: ['内科学', '心血管'] },
          { stem: 'b？', options: ['甲', '乙'], answer: 0 },
        ],
      },
    ]);
    expect(qs[0].chapters).toEqual(['内科学', '心血管']);
    expect('chapters' in qs[1]).toBe(false);
    expect(chaptersOf(qs[1])).toEqual(['内科学']);
  });
});

describe('回归：chapterMastery 的章节聚合口径', () => {
  const stat = (wrong: number): QStat => ({
    due: 0, stability: 0, difficulty: 0, elapsed: 0, scheduled: 0,
    steps: 0, reps: 1, lapses: 0, state: 1, lastReview: 0, wrong,
  });
  const bankOf = (questions: QuizQuestion[]): QuizBank => ({ name: 'B', importedAt: 1, questions });
  const statsOf = (per: Record<string, number>): StatsMap => ({
    B: Object.fromEntries(Object.entries(per).map(([id, wrong]) => [id, stat(wrong)])),
  });

  it('一道题归两章 → 两个章节各记一次（题确实同时属于两章）', () => {
    const q = first({ answer: 0, chapters: ['甲', '乙'] });
    const out = chapterMastery(bankOf([q]), statsOf({ [q.id]: 1 }));
    expect(out.map((m) => m.chapter).sort()).toEqual(['乙', '甲'].sort());
    expect(out.find((m) => m.chapter === '甲')).toMatchObject({ seen: 1, wrong: 1, accuracy: 0, weak: false });
    expect(out.find((m) => m.chapter === '乙')).toMatchObject({ seen: 1, wrong: 1, accuracy: 0, weak: false });
  });

  it('同一题不会在同一章里被记两次（chapters 里的重复项已去重）', () => {
    const q = first({ answer: 0, chapters: ['甲', '甲', '乙'] });
    const out = chapterMastery(bankOf([q]), statsOf({ [q.id]: 0 }));
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.seen === 1)).toBe(true);
  });

  it('只有 chapter（或什么都没写）的题：与旧口径一致，空 chapter 仍归「空串」那一档', () => {
    const qs = normalizeQuestions([
      base({ answer: 0, chapter: '甲' }),
      base({ answer: 0, chapter: '乙' }),
      base({ answer: 0 }),
    ]);
    const [a, b, c] = qs;
    const out = chapterMastery(bankOf(qs), statsOf({ [a.id]: 1, [b.id]: 0, [c.id]: 0 }));
    expect(out.map((m) => m.chapter).sort()).toEqual(['', '乙', '甲'].sort());
    expect(out.find((m) => m.chapter === '甲')).toMatchObject({ seen: 1, wrong: 1, accuracy: 0, weak: false });
    expect(out.find((m) => m.chapter === '乙')).toMatchObject({ seen: 1, wrong: 0, accuracy: 1, weak: false });
    expect(out.find((m) => m.chapter === '')).toMatchObject({ seen: 1, wrong: 0, accuracy: 1, weak: false });
  });

  it('多章节题在每章里的样本都按同一套阈值判定 weak', () => {
    const qs = normalizeQuestions([
      base({ answer: 0, chapters: ['甲', '乙'] }),
      base({ answer: 0, chapters: ['甲', '乙'] }),
      base({ answer: 0, chapters: ['甲', '乙'] }),
    ]);
    const out = chapterMastery(bankOf(qs), statsOf(Object.fromEntries(qs.map((q, i) => [q.id, i === 0 ? 1 : 0]))));
    expect(out.map((m) => m.chapter).sort()).toEqual(['乙', '甲'].sort());
    for (const m of out) expect(m).toMatchObject({ seen: 3, wrong: 1, weak: false });
  });
});

describe('回归：章节筛选与章节清单的成员判定（qbankCompose）', () => {
  const rules = (chapters: string[]): ComposeRules => ({ ...DEFAULT_RULES, chapters });
  const ids = (qs: QuizQuestion[]) => qs.map((q) => q.id);

  it('跨章题：按 A 或按 B 都能被筛到（成员判定，与 chapterMastery 同口径）', () => {
    const q = first({ answer: 0, chapters: ['A', 'B'] });
    expect(ids(filterPool([q], rules(['A']), {}, 'B'))).toEqual([q.id]);
    expect(ids(filterPool([q], rules(['B']), {}, 'B'))).toEqual([q.id]);
    expect(ids(filterPool([q], rules(['A', 'B']), {}, 'B'))).toEqual([q.id]);
    expect(filterPool([q], rules(['C']), {}, 'B')).toEqual([]);
  });

  it('只给 chapter 的题：筛选行为与旧一致（按 A 命中、按 B 不命中）', () => {
    const q = first({ answer: 0, chapter: 'A' });
    expect(q.chapter).toBe('A');
    expect(ids(filterPool([q], rules(['A']), {}, 'B'))).toEqual([q.id]);
    expect(filterPool([q], rules(['B']), {}, 'B')).toEqual([]);
    expect(ids(filterPool([q], rules([]), {}, 'B'))).toEqual([q.id]); // 空数组 = 全部章节
  });

  it('没写章节的题：仍按空串那一档参与筛选（旧行为，不新开档位）', () => {
    const q = first({ answer: 0 });
    expect(ids(filterPool([q], rules(['']), {}, 'B'))).toEqual([q.id]);
    expect(filterPool([q], rules(['A']), {}, 'B')).toEqual([]);
  });

  it('跨章题在组题弹窗的章节清单里两个章节都有入口，且计数与筛选结果一致', () => {
    const q = first({ answer: 0, chapters: ['A', 'B'] });
    expect(chapterCounts([q])).toEqual([
      { chapter: 'A', count: 1 },
      { chapter: 'B', count: 1 },
    ]);
    // 清单里列出的每一章，按它筛都必须能筛到题（chip 上的数字就是筛选结果数）
    for (const { chapter, count } of chapterCounts([q])) {
      expect(filterPool([q], rules([chapter]), {}, 'B')).toHaveLength(count);
    }
  });

  it('只给 chapter 的题：章节清单仍是旧口径（一题只计一次）', () => {
    const qs = normalizeQuestions([base({ answer: 0, chapter: 'A' }), base({ answer: 0, chapter: 'B' })]);
    expect(chapterCounts(qs)).toEqual([
      { chapter: 'A', count: 1 },
      { chapter: 'B', count: 1 },
    ]);
  });
});
