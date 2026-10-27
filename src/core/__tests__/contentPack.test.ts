/**
 * 内容包（kq.pack.v1）映射层的单测。
 *
 * 这一层是「导出侧的中立结构」与「落库侧的字段名」之间唯一的接缝，错一个字段名
 * 不会报错、只会静默少一截：题干变空 → 整题被丢；答案键写错（answer 写成 answers）
 * → 选择题变成「没有答案」；小问没展开 → 病例题只剩一个病例壳。
 * 所以这里逐个键钉住，用的都是自己编的占位文字（不放任何真实题库内容）。
 */
import { describe, expect, it } from 'vitest';
import {
  collectPackRefs,
  detectContentPack,
  packIndexSummary,
  packUnitTitle,
  packUnitToQuestions,
} from '../contentPack';

/** 单元文件：**不带 format 标记**，按形状认（早期导出就是这样，兼容路径必须有测试） */
const unit = (items: unknown[]) => ({ unitId: 'demo-1', pack: 'demo', title: '示例单元', subject: '示例科目', group: '示例分组', items });

const twoChoices = [
  { k: 'A', body: [{ t: 'text', v: '选项一' }] },
  { k: 'B', body: [{ t: 'text', v: '选项二' }] },
];

describe('内容包角色识别', () => {
  it('索引 / 单元按形状分开认，普通题库 JSON 与数据集不会被误判', () => {
    expect(detectContentPack({ format: 'kq.pack.v1', units: [{ unitId: 'a', count: 1 }] })).toBe('index');
    expect(detectContentPack({ unitId: 'u1', items: [] })).toBe('unit');
    expect(detectContentPack({ name: '题库', questions: [] })).toBe('unknown');
    expect(detectContentPack([{ stem: 'x' }])).toBe('unknown');
    expect(detectContentPack(null)).toBe('unknown');
  });

  it('索引摘要报单元数、题数与来源包名；题库名取「科目 · 分组 · 标题」', () => {
    const s = packIndexSummary({ format: 'kq.pack.v1', units: [{ pack: 'a' }, { pack: 'b' }], stats: { items: 7 } });
    expect(s).toBe('2 个单元 / 7 题（a、b）');
    expect(packUnitTitle(unit([]))).toBe('示例科目 · 示例分组 · 示例单元');
    expect(packUnitTitle({ unitId: 'demo-9' })).toBe('demo-9');
  });
});

describe('题目映射', () => {
  it('单选：选项顺序、答案下标、答案原文、解析、章节+知识点分层都保住', () => {
    const r = packUnitToQuestions(unit([{
      qid: 't:1', type: 'radio', typeRaw: '1',
      stem: [{ t: 'text', v: '示例题干' }],
      choices: twoChoices,
      answers: ['B'],
      rationale: [{ source: '解析', body: [{ t: 'text', v: '示例解析' }] }],
      knowledge: [{ name: '示例知识点' }],
      meta: { chapters: ['示例章节'] },
    }]));
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q.type).toBe('choice');
    expect(q.stem).toBe('示例题干');
    expect(q.options).toEqual(['选项一', '选项二']);
    expect(q.answer).toBe(1);
    expect(q.answerText).toBe('选项二');
    expect(q.explanation).toBe('示例解析');
    // 真实章节在前、知识点在后：掌握度按 chapter/chapters 聚合，顺序就是用户看到的归类顺序
    expect(q.chapter).toBe('示例章节');
    expect(q.chapters).toEqual(['示例章节', '示例知识点']);
  });

  it('多选：answers 给完整数组（单选才用 answer），两个答案都落在下标上', () => {
    const r = packUnitToQuestions(unit([{
      type: 'multi', stem: [{ t: 'text', v: '示例题干' }], choices: twoChoices, answers: ['A', 'B'],
    }]));
    expect(r.questions[0].answers).toEqual([0, 1]);
    expect(r.questions[0].answer).toBe(0);
  });

  it('多套解析进 explanations，单套进 explanation（两处都读，不能互换）', () => {
    const r = packUnitToQuestions(unit([{
      type: 'radio', stem: [{ t: 'text', v: '示例题干' }], choices: twoChoices, answers: ['A'],
      rationale: [
        { source: '甲版', body: [{ t: 'text', v: '解析甲' }] },
        { source: '乙版', body: [{ t: 'text', v: '解析乙' }] },
      ],
    }]));
    expect(r.questions[0].explanations).toEqual([{ source: '甲版', text: '解析甲' }, { source: '乙版', text: '解析乙' }]);
    expect(r.questions[0].explanation).toBeUndefined();
  });

  it('没有选项的填空：答案走 answer（recall 分支只认这个键），不会退化成没答案的题', () => {
    const q = packUnitToQuestions(unit([{
      type: 'fill', stem: [{ t: 'text', v: '示例填空' }], answers: ['示例答案'],
    }])).questions[0];
    expect(q.type).toBe('recall');
    expect(q.answerText).toBe('示例答案');
  });

  it('判断 / 简答这类文本答案原样带出，多个用 / 连接', () => {
    const q = packUnitToQuestions(unit([{
      type: 'judge', stem: [{ t: 'text', v: '示例判断' }], answers: ['正确'],
    }])).questions[0];
    expect(q.type).toBe('recall');
    expect(q.answerText).toBe('正确');
  });

  it('共用题干病例题：展开成独立小问，带病例原文与组内序号', () => {
    const r = packUnitToQuestions(unit([{
      type: 'case', typeRaw: '6', stem: [{ t: 'text', v: '示例病例原文' }], answers: [],
      sub: [
        { stem: [{ t: 'text', v: '小问一' }], choices: twoChoices, answers: ['A'] },
        { stem: [{ t: 'text', v: '小问二' }], choices: twoChoices, answers: ['B'] },
      ],
    }]));
    expect(r.questions).toHaveLength(2);
    expect(r.questions.map((q) => q.groupStem)).toEqual(['示例病例原文', '示例病例原文']);
    expect(r.questions.map((q) => q.groupNo)).toEqual([1, 2]);
    expect(r.questions.every((q) => q.groupTotal === 2)).toBe(true);
    expect(r.questions[1].answerText).toBe('选项二');
  });

  it('无题干条目跳过；答案占位（N / 无）当没给，整单元都没有效答案时交回空数组', () => {
    const r = packUnitToQuestions(unit([
      { type: 'radio', stem: [], choices: twoChoices, answers: ['A'] },
      { type: 'radio', stem: [{ t: 'text', v: '示例题干' }], choices: twoChoices, answers: ['A'] },
    ]));
    expect(r.questions).toHaveLength(1);
    // 真实数据里有这种单元（刷题宝「人体解剖学英文_淋巴系统」8 道简答题原库没给答案）。
    // normalizeQuestions 对「一条都没解析出来」是抛错的（手工导入该抛，用户贴的文本解析不出来要当场说），
    // 但内容包是机器生成的：这里吞下来交回空数组，界面才能按单元报出「这个单元没有能建成的题目」。
    const empty = packUnitToQuestions(unit([{ type: 'fill', stem: [{ t: 'text', v: '示例' }], answers: ['N'] }]));
    expect(empty.questions).toEqual([]);
  });
});

describe('图片', () => {
  const withImgs = unit([{
    qid: 't:2', type: 'radio',
    stem: [{ t: 'text', v: '示例题干' }, { t: 'image', v: 'imgA' }],
    choices: [{ k: 'A', body: [{ t: 'image', v: 'imgB' }, { t: 'text', v: '选项一' }] }, { k: 'B', body: [{ t: 'text', v: '选项二' }] }],
    answers: ['A'],
    rationale: [{ source: '解析', body: [{ t: 'text', v: '示例解析' }, { t: 'image', v: 'imgC' }] }],
  }]);

  it('ref 收集去重（同一 ref 被多题引用是常态）', () => {
    expect(collectPackRefs(withImgs)).toEqual(['imgA', 'imgB', 'imgC']);
  });

  it('落库成功的 ref 进题干图与同位选项图；解析里的图如实计入 dropped 而不是静默消失', () => {
    const paths: Record<string, string> = { imgA: '_attachments/imgA.png', imgB: '_attachments/imgB.png' };
    const r = packUnitToQuestions(withImgs, (ref) => paths[ref]);
    expect(r.questions[0].image).toBe('_attachments/imgA.png');
    expect(r.questions[0].optionImages).toEqual(['_attachments/imgB.png', null]);
    expect(r.placed).toBe(2);
    expect(r.dropped).toBe(1);
  });

  it('一张图都没落库时不写图片字段（不留空值把题弄成「有图但看不见」）', () => {
    const r = packUnitToQuestions(withImgs);
    expect(r.questions[0].image).toBeUndefined();
    expect(r.questions[0].optionImages).toBeUndefined();
    expect(r.placed).toBe(0);
  });
});

describe('整单元没答案', () => {
  const noAnswer = unit([{ qid: 't:3', type: 'essay', stem: [{ t: 'text', v: '示例简答题' }] }]);

  it('交回空数组而不是抛错，题数如实为 0', () => {
    expect(() => packUnitToQuestions(noAnswer)).not.toThrow();
    expect(packUnitToQuestions(noAnswer).questions).toEqual([]);
  });
});
