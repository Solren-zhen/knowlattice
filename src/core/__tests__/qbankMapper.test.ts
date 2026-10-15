// @vitest-environment node
/**
 * 题库 JSON 形状探测与通用映射（qbankMapper）的单测。
 *
 * 全部样例都是**自己造的合成数据**（题干/选项/解析一律写「合成…」），不含任何真实题目内容：
 * 这里要锁的是「字段怎么认、认不出来怎么办」，与具体题库内容无关。
 */
import { describe, expect, it } from 'vitest';
import { detectQbankSchema, mapToQuestions, mappingSummary } from '../qbankMapper';

/** 本项目自己的题库形状 */
const nativeBank = {
  name: '合成题库',
  questions: [
    { stem: '合成题干', options: ['合成选项甲', '合成选项乙'], answer: 0, explanation: '合成解析' },
  ],
};

/** 短键题库（万川医考风格）形状 */
const shortBank = [
  { i: 1, t: 1, s: '合成题干', o: ['合成选项甲', '合成选项乙'], a: [0], x: '合成解析' },
];

/** 富文本题库（窦起心搏风格）形状 */
const richBank = [
  {
    title: [{ type: 'text', content: '合成题干' }],
    options: [
      { val: 'A', oldtext: '合成选项甲', content: '合成选项甲' },
      { val: 'B', oldtext: '合成选项乙', content: '合成选项乙' },
    ],
    answer: ['A'],
    jiexiArr: { '合成老师': { analysis: [{ type: 'text', content: '合成解析' }] } },
  },
];

describe('detectQbankSchema：形状探测', () => {
  it('本项目形状（顶层 { name, questions }）→ native', () => {
    const det = detectQbankSchema(nativeBank);
    expect(det.kind).toBe('native');
    expect(det.evidence.join('；')).toMatch(/stem/);
    expect(det.evidence.join('；')).toMatch(/questions/);
    expect(det.confidence).toBeGreaterThan(0);
    expect(det.confidence).toBeLessThanOrEqual(1);
  });

  it('短键形状（s/o/a/x/t/i）→ short-keys', () => {
    const det = detectQbankSchema(shortBank);
    expect(det.kind).toBe('short-keys');
    expect(det.evidence.join('；')).toMatch(/题干字段 s/);
    expect(det.evidence.join('；')).toMatch(/选项字段 o/);
    expect(det.confidence).toBeGreaterThan(0);
    expect(det.confidence).toBeLessThanOrEqual(1);
  });

  it('富文本形状（title 块 + options 对象数组 + jiexiArr）→ rich-blocks', () => {
    const det = detectQbankSchema(richBank);
    expect(det.kind).toBe('rich-blocks');
    expect(det.evidence.join('；')).toMatch(/title/);
    expect(det.evidence.join('；')).toMatch(/jiexiArr/);
    expect(det.confidence).toBeGreaterThan(0);
    expect(det.confidence).toBeLessThanOrEqual(1);
  });

  it('乱七八糟的对象数组 → unknown，且 evidence 说清缺哪些字段', () => {
    const det = detectQbankSchema([{ 甲: 1, 乙: 2 }]);
    expect(det.kind).toBe('unknown');
    expect(det.evidence.join('；')).toMatch(/没找到题干字段（期望/);
    expect(det.evidence.join('；')).toMatch(/没找到选项字段（期望/);
    expect(det.evidence.join('；')).toMatch(/没找到答案字段（期望/);
    expect(det.confidence).toBeGreaterThanOrEqual(0);
    expect(det.confidence).toBeLessThanOrEqual(1);
  });

  it('顶层连题目数组都没有 → unknown，并提示期望的顶层形状', () => {
    const det = detectQbankSchema({ foo: 'bar' });
    expect(det.kind).toBe('unknown');
    expect(det.evidence.join('；')).toMatch(/没找到题目数组/);
  });

  it('空数组 → unknown，confidence 为 0', () => {
    const det = detectQbankSchema([]);
    expect(det.kind).toBe('unknown');
    expect(det.confidence).toBe(0);
  });
});

describe('mapToQuestions：短键题库（万川医考风格）', () => {
  it('单选：s/o/a → { stem, options, answer }，且不产出 answerText', () => {
    const { items, skipped } = mapToQuestions([
      { i: 1, t: 1, s: '合成单选题干', o: ['合成选项甲', '合成选项乙', '合成选项丙'], a: [0], x: '合成解析' },
    ]);
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { stem: '合成单选题干', options: ['合成选项甲', '合成选项乙', '合成选项丙'], answer: 0, explanation: '合成解析' },
    ]);
    expect(items[0]).not.toHaveProperty('answerText');
  });

  it('多选：题型码 2 + 数组答案 a → 带 answers', () => {
    const { items } = mapToQuestions([
      { t: 2, s: '合成多选题干', o: ['合成甲', '合成乙', '合成丙', '合成丁'], a: [0, 2] },
    ]);
    expect(items[0]).toEqual({
      stem: '合成多选题干',
      options: ['合成甲', '合成乙', '合成丙', '合成丁'],
      answer: 0,
      answers: [0, 2],
    });
  });

  it('多选：答案写成字母数组 ["A","C"] → 带 answers', () => {
    const { items } = mapToQuestions([
      { t: 1, s: '合成题干', o: ['合成甲', '合成乙', '合成丙', '合成丁'], a: ['A', 'C'] },
    ]);
    expect(items[0].answers).toEqual([0, 2]);
    expect(items[0].answer).toBe(0);
  });

  it('判断（题型码 4，只有下标答案）→ 补上「正确/错误」两个选项', () => {
    const { items } = mapToQuestions([{ t: 4, s: '合成判断题干', a: [1] }]);
    expect(items).toEqual([{ stem: '合成判断题干', options: ['正确', '错误'], answer: 1 }]);
  });

  it('选项带图片（{c,g}）与题干 [[IMG]] 占位符 → image / optionImages', () => {
    const { items } = mapToQuestions([
      {
        t: 5,
        s: '看图[[IMG]]作答',
        g: ['_attachments/合成题干图.png'],
        o: [{ c: '合成甲', g: ['_attachments/合成选项图.png'] }, '合成乙'],
        a: [0],
      },
    ]);
    expect(items).toEqual([
      {
        stem: '看图作答',
        image: '_attachments/合成题干图.png',
        options: ['合成甲', '合成乙'],
        optionImages: ['_attachments/合成选项图.png', null],
        answer: 0,
      },
    ]);
  });

  it('共用题干 sub → 外层 { stem, sub }，不自己展开', () => {
    const { items, skipped } = mapToQuestions([
      {
        i: 9,
        t: 6,
        s: '合成病例题干',
        x: '合成解析',
        sub: [
          { t: 1, s: '合成小问一', o: ['合成甲', '合成乙'], a: [0] },
          { t: 1, s: '合成小问二', o: ['合成丙', '合成丁'], a: [1] },
        ],
      },
    ]);
    expect(skipped).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].stem).toBe('合成病例题干');
    expect(items[0].explanation).toBe('合成解析');
    expect(items[0].sub).toEqual([
      { stem: '合成小问一', options: ['合成甲', '合成乙'], answer: 0 },
      { stem: '合成小问二', options: ['合成丙', '合成丁'], answer: 1 },
    ]);
  });

  it('没有题干 → 跳过并写明期望字段 s', () => {
    const { items, skipped } = mapToQuestions([{ t: 1, o: ['合成甲', '合成乙'], a: [0] }]);
    expect(items).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].index).toBe(0);
    expect(skipped[0].reason).toMatch(/没找到题干/);
    expect(skipped[0].reason).toMatch(/s/);
  });

  it('选项不足 2 项且答案不是文本（a 只有下标）→ 跳过并说明', () => {
    const { items, skipped } = mapToQuestions([{ t: 1, s: '合成单选题干', o: ['唯一选项'], a: [0] }]);
    expect(items).toEqual([]);
    expect(skipped[0].reason).toMatch(/选项少于 2 项/);
    expect(skipped[0].reason).toMatch(/可读文本/);
  });

  it('无选项但答案有文本（填空 7）→ 落成简答 { stem, answer }', () => {
    const { items, skipped } = mapToQuestions([{ t: 7, s: '合成填空题干', a: ['合成答案文本'] }]);
    expect(skipped).toEqual([]);
    expect(items).toEqual([{ stem: '合成填空题干', answer: '合成答案文本' }]);
    expect(items[0]).not.toHaveProperty('options');
    expect(items[0]).not.toHaveProperty('answerText');
  });
});

describe('mapToQuestions：富文本题库（窦起心搏风格）', () => {
  it('title 块拼成题干、options 对象数组取文本、jiexiArr → explanations', () => {
    const { items, skipped } = mapToQuestions([
      {
        title: [
          { type: 'text', content: '合成题干第一段' },
          { type: 'text', content: '合成题干第二段' },
        ],
        options: [
          { val: 'A', oldtext: '合成选项甲', content: '合成选项甲' },
          { val: 'B', oldtext: '合成选项乙', content: '合成选项乙' },
        ],
        answer: ['B'],
        jiexiArr: { '合成老师': { analysis: [{ type: 'text', content: '合成解析一' }] } },
        knowledge: '合成知识点',
        diffict: 3,
      },
    ]);
    expect(skipped).toEqual([]);
    expect(items[0].stem).toBe('合成题干第一段\n合成题干第二段');
    expect(items[0].options).toEqual(['合成选项甲', '合成选项乙']);
    expect(items[0].answer).toBe(1);
    expect(items[0].explanations).toEqual([{ source: '合成老师', text: '合成解析一' }]);
    expect(items[0].chapter).toBe('合成知识点');
    expect(items[0]).not.toHaveProperty('diffict');
  });

  it('无选项 + tkanswer → 简答 { stem, answer: 挖空答案 }', () => {
    const { items } = mapToQuestions([
      {
        title: [{ type: 'text', content: '合成填空题干' }],
        answer: [],
        tkanswer: '合成挖空答案',
        jiexiArr: { '合成老师': { analysis: [{ type: 'text', content: '合成解析' }] } },
      },
    ]);
    expect(items).toEqual([
      {
        stem: '合成填空题干',
        answer: '合成挖空答案',
        explanations: [{ source: '合成老师', text: '合成解析' }],
      },
    ]);
  });
});

describe('mapToQuestions：本项目格式与未知格式', () => {
  it('本项目格式：自定义键被丢弃，既有字段原样保留', () => {
    const { items, skipped } = mapToQuestions([
      {
        id: 'q-1',
        type: 'choice',
        stem: '合成题干',
        options: ['合成甲', '合成乙'],
        answer: 1,
        answerText: '合成乙',
        自创字段: '不该出现在产物里',
        chapter: '合成章节',
      },
    ]);
    expect(skipped).toEqual([]);
    expect(items).toEqual([{ stem: '合成题干', options: ['合成甲', '合成乙'], answer: 1, chapter: '合成章节' }]);
    expect(items[0]).not.toHaveProperty('自创字段');
    expect(items[0]).not.toHaveProperty('id');
    expect(items[0]).not.toHaveProperty('type');
    expect(items[0]).not.toHaveProperty('answerText');
  });

  it('本项目格式的简答题（options 空 + answer:-1 + answerText）→ answer 换成可读文本', () => {
    const { items, skipped } = mapToQuestions([
      { stem: '合成简答题干', options: [], answer: -1, answerText: '合成答案文本' },
    ]);
    expect(skipped).toEqual([]);
    expect(items).toEqual([{ stem: '合成简答题干', answer: '合成答案文本' }]);
    expect(items[0]).not.toHaveProperty('options');
    expect(items[0]).not.toHaveProperty('answerText');
  });

  it('未知形状 → items 为空，skipped 用中文说清期望字段', () => {
    const { items, skipped } = mapToQuestions([{ 甲: 1, 乙: 2 }]);
    expect(items).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].index).toBe(0);
    expect(skipped[0].reason).toMatch(/没找到题干字段（期望/);
    expect(skipped[0].reason).toMatch(/没找到选项字段（期望/);
  });

  it('连题目数组都没有 → items 为空，skipped 说明期望的顶层形状', () => {
    const { items, skipped } = mapToQuestions({ foo: 'bar' });
    expect(items).toEqual([]);
    expect(skipped[0].reason).toMatch(/没找到题目数组/);
  });
});

describe('mappingSummary', () => {
  const raw = [
    { t: 1, s: '合成题干一', o: ['合成甲', '合成乙'], a: [0] },
    { t: 1, o: ['合成甲', '合成乙'], a: [0] },
    { t: 1, s: '合成题干二', o: ['合成丙', '合成丁'], a: [1] },
  ];

  it('含形状名、可导入题数、跳过条数与跳过原因', () => {
    const det = detectQbankSchema(raw);
    const mapped = mapToQuestions(raw);
    expect(det.kind).toBe('short-keys');
    expect(mapped.items).toHaveLength(2);
    expect(mapped.skipped).toHaveLength(1);

    const text = mappingSummary(det, mapped);
    expect(text).toMatch(/短键/);
    expect(text).toContain('可导入 2 题');
    expect(text).toMatch(/跳过 1 条/);
    expect(text).toMatch(/没找到题干/);
  });

  it('unknown 时明说不会导入任何题目', () => {
    const det = detectQbankSchema([{ 甲: 1 }]);
    const text = mappingSummary(det, mapToQuestions([{ 甲: 1 }]));
    expect(text).toMatch(/未识别的格式/);
    expect(text).toContain('可导入 0 题');
  });
});
