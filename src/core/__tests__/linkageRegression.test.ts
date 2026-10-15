/**
 * 联动回归：把「特色功能之间的既有联系」变成可执行的断言。
 *
 * 为什么单独一个文件：这些联系**跨模块**，各自的模块测试都测不到它们——
 * 例如「笔记小节切卡」在 srsCards 里有测试、「挖空遮罩」在 cloze 里有测试，
 * 但「切出来的卡正文仍然带着复习界面认得的挖空标记」这条**跨模块契约**没人守。
 * 一旦有人改了切卡正文的处理、或换了挖空语法，两边各自的测试都是绿的、联动却断了。
 *
 * 因此这里按联动编号（L1/L2/L4/L6/L7/L10）逐条钉住：
 *   L1 笔记 `##` 小节 → FSRS 卡
 *   L2 卡 → 挖空呈现（同一个 core/cloze.ts）
 *   L4 卡评「忘了」→ 错题本（按笔记路径归档）
 *   L6 题 → 笔记（`note` 优先，否则 `chapter` 精确反查）
 *   L7 题 `chapter` → chapterMastery（→ 薄弱热力图与组题软门控）
 *   L10 旧数据形状：新字段只在**真的存在**时出现，老题库/老备份的形状逐字不变
 *   L11 外部题库 JSON → qbankMapper（通用映射）→ qbank（本应用模型）：字段语义真的通了
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCards } from '../srsCards';
import { hasCloze, maskCloze, revealCloze } from '../cloze';
import { getMistake, loadMistakes, recordMistake } from '../mistakes';
import { chaptersOf, correctIndices, isCorrectPick, normalizeQuestions, type QuizBank } from '../qbank';
import { detectQbankSchema, mapToQuestions } from '../qbankMapper';
import { chapterMastery } from '../qbankStats';
import { resolveQuestionNote } from '../qbankNotes';

beforeEach(() => {
  localStorage.clear();
});

const NOTE = `---
tags: [生理学]
chapter: 生理学
---

# 心输出量

## 定义

- 定义: 心输出量 = {{每搏输出量}} × {{心率}}

## 调节

- 调节: 心率与每搏输出量
`;

describe('L1/L2 笔记小节 → 卡 → 挖空呈现', () => {
  it('按 ## 切卡，卡键仍是 <path>#<小节标题>', () => {
    const cards = buildCards(['生理/心.md'], new Map([['生理/心.md', NOTE]]));
    expect(cards.map((c) => c.key)).toEqual(['生理/心.md#定义', '生理/心.md#调节']);
  });

  it('切出来的卡正文仍带着复习界面认得的挖空标记（同一套 core/cloze 语法）', () => {
    const [card] = buildCards(['生理/心.md'], new Map([['生理/心.md', NOTE]]));
    expect(hasCloze(card.body)).toBe(true);
    expect(maskCloze(card.body)).toContain('＿＿＿');
    expect(revealCloze(card.body)).toContain('每搏输出量');
    // 遮罩不该泄漏答案
    expect(maskCloze(card.body)).not.toContain('每搏输出量');
  });
});

describe('L4 卡评「忘了」→ 错题本（按笔记路径归档）', () => {
  it('同一条路径重复记错会累加，且带着该篇的章节与标题', () => {
    recordMistake('生理/心.md', NOTE);
    recordMistake('生理/心.md', NOTE);
    const rec = getMistake('生理/心.md');
    expect(rec).not.toBeNull();
    expect(rec?.count).toBe(2);
    expect(rec?.chapter).toBe('生理学');
    expect(rec?.title).toBe('心输出量');
    // 错题本以笔记路径为键（不是题目 id）——这条是 L4 与 L6 的分界
    expect(Object.keys(loadMistakes())).toEqual(['生理/心.md']);
  });
});

describe('L6 题 → 笔记：note 优先，否则 chapter 精确反查', () => {
  const chapterIndex = new Map([['生理学', '题库/真题/生理学.md']]);
  const resolveLink = (name: string) => (name === '氧解离曲线' ? '生理/氧解离曲线.md' : null);

  it('给了 note 就按名字解析，且优先于 chapter', () => {
    expect(resolveQuestionNote({ note: '氧解离曲线', chapter: '生理学' }, resolveLink, chapterIndex)).toBe(
      '生理/氧解离曲线.md'
    );
  });

  it('没有 note 时按 chapter 精确反查', () => {
    expect(resolveQuestionNote({ chapter: '生理学' }, resolveLink, chapterIndex)).toBe('题库/真题/生理学.md');
  });

  it('**多章节的题**仍然用主章节（chapters[0]）参加反查，不会因为多章节而失去归位', () => {
    const q = normalizeQuestions([
      { stem: '题干？', options: ['甲', '乙'], answer: 0, chapters: ['生理学', '心血管'] },
    ])[0];
    expect(q.chapter).toBe('生理学');
    expect(resolveQuestionNote(q, resolveLink, chapterIndex)).toBe('题库/真题/生理学.md');
  });
});

describe('L7 题 chapter → chapterMastery（薄弱热力图与组题软门控的口径）', () => {
  const bankOf = (questions: QuizBank['questions']): QuizBank => ({ name: 'B', importedAt: 1, questions });
  /**
   * 一题一个条目地调 normalizeQuestions 会拿到**同一个 id**（id = `q-<同一毫秒>-0`，
   * 下标每次都从 0 重新开始），而逐题统计是按 id 存的——所以必须**一次调用**建多题，
   * 让下标把 id 区分开。这不是测试技巧，是 core/qbank 的既有契约。
   */
  const build = (specs: Array<{ stem: string; chapter?: string; chapters?: string[] }>) =>
    normalizeQuestions(specs.map((s) => ({ ...s, options: ['甲', '乙'], answer: 0 })));
  const stats = (entries: Array<[string, { wrong: number }]>) => ({ B: Object.fromEntries(entries) }) as never;

  it('单章节题：与旧口径完全一致（每章一个桶，正确率、排序、weak 判据不变）', () => {
    const [q1, q2, q3] = build([
      { stem: 'q1', chapter: '生理学' },
      { stem: 'q2', chapter: '生理学' },
      { stem: 'q3', chapter: '生化' },
    ]);
    const per: Array<[string, { wrong: number }]> = [
      [q1.id, { wrong: 1 }],
      [q2.id, { wrong: 0 }],
      [q3.id, { wrong: 1 }],
    ];
    const m = chapterMastery(bankOf([q1, q2, q3]), stats(per));
    expect(m.map((x) => x.chapter)).toEqual(['生化', '生理学']); // 正确率低的在前
    expect(m.find((x) => x.chapter === '生理学')).toMatchObject({ seen: 2, wrong: 1, accuracy: 0.5 });
    expect(m.find((x) => x.chapter === '生化')).toMatchObject({ seen: 1, wrong: 1, accuracy: 0 });
  });

  it('**没有章节的题**仍然落在空字符串那个桶里（旧行为：不新增档位、不丢样本）', () => {
    const [q1] = build([{ stem: 'q1' }]);
    const m = chapterMastery(bankOf([q1]), stats([[q1.id, { wrong: 1 }]]));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ chapter: '', seen: 1, wrong: 1 });
  });

  it('多章节题：两个章节各记一次（题确实同时属于两章，两边都该看到它）', () => {
    const [q] = build([{ stem: '跨章题？', chapters: ['生理学', '心血管'] }]);
    const m = chapterMastery(bankOf([q]), stats([[q.id, { wrong: 1 }]]));
    expect([...m.map((x) => x.chapter)].sort()).toEqual(['心血管', '生理学'].sort());
    expect(m.every((x) => x.seen === 1)).toBe(true);
  });

  it('只给 chapter 的题不会冒出 chapters 字段（chaptersOf 退回单值）', () => {
    const [q] = build([{ stem: 'q1', chapter: '生理学' }]);
    expect(chaptersOf(q)).toEqual(['生理学']);
    expect('chapters' in q).toBe(false);
  });
});

describe('L10 旧数据形状：新字段只在真的存在时出现', () => {
  it('一份「只有老字段」的题目，解析出来的键集合与扩展前一致', () => {
    const q = normalizeQuestions([
      { stem: '氧解离曲线右移的意义？', options: ['易放氧', '易结合氧'], answer: 0, explanation: 'P50 增大', chapter: '生理学' },
    ])[0];
    expect(Object.keys(q).sort()).toEqual([
      'answer',
      'answerText',
      'chapter',
      'explanation',
      'explanations',
      'id',
      'image',
      'note',
      'options',
      'stem',
      'type',
    ]);
  });

  it('多选 / 多解析 / 选项图 / 题组 都只在给定时才出现', () => {
    const plain = normalizeQuestions([{ stem: 'a？', options: ['甲', '乙'], answer: 0 }])[0];
    for (const k of ['answers', 'optionImages', 'groupStem', 'groupNo', 'groupTotal', 'groupId', 'chapters']) {
      expect(k in plain).toBe(false);
    }
  });
});

/**
 * L11 外部题库 JSON → 通用映射（qbankMapper）→ 本应用模型（qbank）。
 *
 * 为什么单独钉一条：这条链上每一环都各自有单测（qbankMapper 测"映射出什么字段"、
 * qbank 测"字段怎么解析"），但**跨模块的字段语义契约**没人守：
 * 映射侧写出的 `answers` / `chapters` 若被解析侧当成别的意思（或解析侧悄悄不再认它们），
 * 两边测试依然全绿，而用外部题库导入的题会变成"答案只有一个""章节只剩一个"——
 * 看起来完全正常的错数据，统计与错题本都会跟着错，事后极难发现。
 *
 * 样例**全部自造**（甲/乙/丙占位，不含任何真实题目），只检验字段语义在三段之间是否一致。
 */
describe('L11 外部题库 → 通用映射 → 本应用模型（字段语义必须一致）', () => {
  /** 三种形状各一条：多选（answers 两个下标）/ 多章节（chapters）/ 最朴素的单选 */
  const EXTERNAL = {
    questions: [
      { stem: '甲题？', options: ['甲一', '甲二', '甲三'], answers: [0, 2], chapter: '甲章' },
      { stem: '乙题？', options: ['乙一', '乙二'], answer: 1, chapters: ['乙章上', '乙章下'] },
      { stem: '丙题？', options: ['丙一', '丙二'], answer: 0 },
    ],
  };

  const mapped = () => mapToQuestions(EXTERNAL);
  const built = () => normalizeQuestions(mapToQuestions(EXTERNAL).items);

  it('命中本项目形状，一条不丢地喂给 normalizeQuestions（映射产出 = 解析输入）', () => {
    expect(detectQbankSchema(EXTERNAL).kind).toBe('native');
    expect(mapped().skipped).toEqual([]);
    expect(mapped().items).toHaveLength(3);
    const qs = built();
    expect(qs).toHaveLength(3);
    expect(qs.map((q) => q.stem)).toEqual(['甲题？', '乙题？', '丙题？']);
  });

  it('有 answers → 走多选：correctIndices/isCorrectPick 全对才算对（少选、多选都算错）', () => {
    const q = built()[0];
    expect(q.answers).toEqual([0, 2]);
    expect(correctIndices(q)).toEqual([0, 2]);
    expect(isCorrectPick(q, [0, 2])).toBe(true);
    expect(isCorrectPick(q, [2, 0])).toBe(true); // 点选顺序无关
    expect(isCorrectPick(q, [0])).toBe(false); // 少选
    expect(isCorrectPick(q, [0, 1, 2])).toBe(false); // 多选
  });

  it('有 chapters → chaptersOf 返回多章，主章节是第一个（错题归位/热力图口径）', () => {
    const q = built()[1];
    expect(chaptersOf(q)).toEqual(['乙章上', '乙章下']);
    expect(q.chapter).toBe('乙章上');
  });

  it('没给这些字段时新字段不得凭空出现（旧题库形状逐字不变）', () => {
    const q = built()[2];
    expect('answers' in q).toBe(false);
    expect('chapters' in q).toBe(false);
    expect('optionImages' in q).toBe(false);
    // 注意 `explanations` 不在这一组里：normalizeQuestions 的 base 里**总是**带这个键
    // （值可能 undefined，L10 的键集合断言已把这条写成既有契约）。
    expect('groupStem' in q).toBe(false);
    expect(q.options).toEqual(['丙一', '丙二']);
    expect(q.answer).toBe(0);
    expect(chaptersOf(q)).toEqual([]); // 没有章节就是空数组，不退化成随便一个桶
    // 映射阶段的产出同样不该带空字段（否则 frontmatter/导出会一路带着垃圾）
    expect('answers' in mapped().items[2]).toBe(false);
    expect('chapters' in mapped().items[2]).toBe(false);
  });
});
