import { beforeEach, describe, expect, it } from 'vitest';
import { getAllQuestionStats, resetQbankStorageForTests } from '../../storage/qbank';
import {
  addBank,
  exportQbanks,
  importQbanks,
  loadBanks,
  normalizeQuestions,
  parseQuestionsFromText,
  pickQuestions,
  removeBank,
  rowsToQuestions,
  setOptionNote,
  type QuizBank,
} from '../qbank';
import { loadStats, recordAnswer, resetQbankStatsForTests, statOf } from '../qbankStats';

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
});

describe('normalizeQuestions', () => {
  it('中文字段名 + 字母答案 → 选择题', () => {
    const qs = normalizeQuestions([
      { 题干: '氧解离曲线右移的意义？', 选项: ['易放氧', '易结合氧'], 答案: 'A', 解析: '……' },
    ]);
    expect(qs[0]).toMatchObject({
      type: 'choice',
      stem: '氧解离曲线右移的意义？',
      options: ['易放氧', '易结合氧'],
      answer: 0,
      answerText: '易放氧',
      explanation: '……',
    });
  });

  it('数字下标与选项原文都能命中答案（含 B. 带标点）', () => {
    const question = { stem: '?', options: ['a', 'b', 'c'], answer: 2 };
    expect(normalizeQuestions([question])[0].answer).toBe(2);
    expect(normalizeQuestions([{ ...question, answer: 'c' }])[0].answer).toBe(2);
    expect(normalizeQuestions([{ ...question, answer: 'B.' }])[0].answer).toBe(1);
  });

  it('无有效选项 → 简答题', () => {
    expect(
      normalizeQuestions([{ stem: '什么是熵？', answer: '混乱度的量度' }])[0]
    ).toMatchObject({ type: 'recall', answerText: '混乱度的量度' });
  });

  it('跳过无题干条目；全部无效时抛错', () => {
    expect(() => normalizeQuestions([{ stem: '' }])).toThrow();
    expect(() => normalizeQuestions([{ stem: '有题干无答案' }])).toThrow();
    expect(() => normalizeQuestions({ not: 'array' })).toThrow();
  });

  it('id 唯一且含序号', () => {
    const qs = normalizeQuestions([
      { stem: 'q1', answer: 'x' },
      { stem: 'q2', answer: 'y' },
    ]);
    expect(qs[0].id).not.toBe(qs[1].id);
  });

  it('顶层对象含 questions 数组也能解析', () => {
    const qs = normalizeQuestions({ questions: [{ 题目: '1+1=2 对吗', 答案: '对' }] });
    expect(qs).toHaveLength(1);
  });
});

describe('parseQuestionsFromText', () => {
  it('标准排版：编号题干 + 逐行选项 + 答案/解析', () => {
    const text = `1. 关于氧解离曲线，以下正确的是
A. 右移说明……
B. 左移说明……
答案：A
解析：右移提示氧易释放

2. 第二题
答案：B
`;
    const qs = parseQuestionsFromText(text);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ type: 'choice', answer: 0, answerText: '右移说明……' });
    expect(qs[0].explanation).toBe('右移提示氧易释放');
  });

  it('内联选项一行式 A.xx B.yy 同行带 答案：B', () => {
    const qs = parseQuestionsFromText('1. 胸外按压频率？ A.60 B.100 C.80 答案：B');
    expect(qs[0]).toMatchObject({ type: 'choice', answer: 1 });
    expect(qs[0].options).toEqual(['60', '100', '80']);
  });

  it('章节/笔记行与续行说明并入题干', () => {
    const text = `1. 肺炎链球菌
这是补充说明
章节：呼吸
笔记：肺炎链球菌感染
答案：D
`;
    const qs = parseQuestionsFromText(text);
    expect(qs[0].stem).toContain('这是补充说明');
    expect(qs[0].chapter).toBe('呼吸');
    expect(qs[0].note).toBe('肺炎链球菌感染');
  });

  it('无答案的题被跳过', () => {
    expect(parseQuestionsFromText('1. 只有题干')).toEqual([]);
  });
});

describe('rowsToQuestions（Excel/CSV 行）', () => {
  it('中英文表头与 A-D 选项列', () => {
    const qs = rowsToQuestions([
      { stem: 'q?', A: 'a1', B: 'a2', C: 'a3', D: 'a4', answer: 'C', 解析: 'e' },
    ]);
    expect(qs[0]).toMatchObject({ type: 'choice', options: ['a1', 'a2', 'a3', 'a4'], answer: 2 });
  });
});

describe('addBank/removeBank/import/export', () => {
  const bank: QuizBank = {
    name: '生理',
    importedAt: 100,
    questions: [{ id: 'q-1', type: 'recall', stem: '1?', options: [], answer: -1, answerText: 'a' }],
  };

  it('首次加载迁移旧题库，并在 IndexedDB 写入成功后移除旧键', async () => {
    localStorage.setItem('knowlattice-qbanks', JSON.stringify([bank]));
    expect(await loadBanks()).toEqual([bank]);
    expect(localStorage.getItem('knowlattice-qbanks')).toBeNull();
  });

  it('迁移旧题库不覆盖 IndexedDB 中较新的同名题库', async () => {
    const newer = { ...bank, importedAt: 200, questions: bank.questions.concat([{ ...bank.questions[0], id: 'new' }]) };
    await importQbanks([newer]);
    localStorage.setItem('knowlattice-qbanks', JSON.stringify([bank]));
    expect((await loadBanks())[0]).toEqual(newer);
  });

  it('同名覆盖导入', async () => {
    await addBank('生理', bank.questions);
    await addBank('生理', bank.questions.concat([{ ...bank.questions[0], id: 'q-2' }]));
    expect(await loadBanks()).toHaveLength(1);
    expect((await loadBanks())[0].questions).toHaveLength(2);
  });

  it('removeBank 只删目标', async () => {
    await addBank('a', bank.questions);
    await addBank('b', bank.questions);
    await removeBank('a');
    expect((await loadBanks()).map((b) => b.name)).toEqual(['b']);
  });

  it('removeBank 连带清掉该题库的逐题历史（不清就是永久孤儿）', async () => {
    await addBank('a', bank.questions);
    await addBank('b', bank.questions);
    await recordAnswer('a', 'q-1', true);
    await recordAnswer('b', 'q-1', true);
    expect(statOf(loadStats(), 'a', 'q-1')).toBeDefined();

    await removeBank('a');

    expect(statOf(loadStats(), 'a', 'q-1')).toBeUndefined();
    // 别的题库不受影响——清错范围会让用户莫名丢进度
    expect(statOf(loadStats(), 'b', 'q-1')).toBeDefined();
  });

  it('删除前也会先迁移旧逐题记录，避免清理后重新变成孤儿', async () => {
    await addBank('待删除', bank.questions);
    localStorage.setItem('knowlattice-qstats', JSON.stringify({
      '待删除': { 'q-1': [100, 1, 1, 0, 0, 0, 0, 0, 0, -1, 1] },
    }));
    await removeBank('待删除');
    expect(await getAllQuestionStats()).toEqual([]);
    expect(localStorage.getItem('knowlattice-qstats')).toBeNull();
  });

  it('导入备份：合并、忽略非法条目', async () => {
    await addBank('existing', []);
    const n = await importQbanks([bank, { name: 42 }, { not: 'bank' }]);
    expect(n).toBe(1);
    expect((await loadBanks()).map((b) => b.name).sort()).toEqual(['existing', '生理']);
    expect((await loadBanks()).find((b) => b.name === '生理')!.importedAt).toBe(100);
  });

  it('exportQbanks 与导入回环', async () => {
    await addBank('回环', bank.questions);
    const state = await exportQbanks();
    await resetQbankStorageForTests();
    resetQbankStatsForTests();
    expect(await loadBanks()).toEqual([]);
    expect(await importQbanks(state)).toBe(1);
    expect((await loadBanks())[0].name).toBe('回环');
  });
});

describe('pickQuestions', () => {
  it('限流抽题且不修改原数组', () => {
    const qs = Array.from({ length: 10 }, (_, i) => ({
      id: `q-${i}`, type: 'recall' as const, stem: `${i}?`, options: [], answer: -1, answerText: `${i}`,
    }));
    const bank: QuizBank = { name: 'b', importedAt: 0, questions: qs };
    const picked = pickQuestions(bank, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((q) => q.id)).size).toBe(3);
    expect(bank.questions).toEqual(qs);
  });
});

describe('选项批注', () => {
  const choice = {
    id: 'q-c1', type: 'choice' as const,
    stem: '氧解离曲线右移？',
    options: ['容易放氧', '容易结合氧', '亲和力增大'],
    answer: 0, answerText: '容易放氧',
  };
  const seed = () => addBank('生理', [choice]);

  it('写入的是指定选项，且落盘可读回', async () => {
    await seed();
    await setOptionNote('生理', 'q-c1', 1, '  右移是亲和力下降  ');
    const notes = (await loadBanks())[0].questions[0].optionNotes;
    expect(notes).toEqual(['', '右移是亲和力下降', '']);
  });

  it('同一题多次批注互不覆盖', async () => {
    await seed();
    await setOptionNote('生理', 'q-c1', 0, '正确项：记住 P50 增大');
    await setOptionNote('生理', 'q-c1', 2, '亲和力增大是左移');
    expect((await loadBanks())[0].questions[0].optionNotes)
      .toEqual(['正确项：记住 P50 增大', '', '亲和力增大是左移']);
  });

  it('清空即删除，全部清空后不留空数组', async () => {
    await seed();
    await setOptionNote('生理', 'q-c1', 1, '先写一条');
    await setOptionNote('生理', 'q-c1', 1, '   ');
    expect((await loadBanks())[0].questions[0].optionNotes).toBeUndefined();
  });

  it('题库名/题号/下标不成立时原样返回', async () => {
    await seed();
    await setOptionNote('不存在的库', 'q-c1', 0, 'x');
    await setOptionNote('生理', 'q-nope', 0, 'x');
    await setOptionNote('生理', 'q-c1', 9, 'x');
    expect((await loadBanks())[0].questions[0].optionNotes).toBeUndefined();
  });

  it('导入时读入 optionNotes，并按选项数补齐/裁齐', () => {
    const qs = normalizeQuestions([{
      stem: '题干', options: ['a', 'b', 'c'], answer: 'A',
      optionNotes: ['  第一项  ', '', '第三项', '多出来的'],
    }]);
    expect(qs[0].optionNotes).toEqual(['第一项', '', '第三项']);
    expect(normalizeQuestions([{ stem: '题干2', options: ['a', 'b'], answer: 0, optionNotes: ['', ' '] }])[0].optionNotes)
      .toBeUndefined();
  });

  it('重导同名题库时按题干+选项接回旧批注', async () => {
    await seed();
    await setOptionNote('生理', 'q-c1', 1, '右移是亲和力下降');
    // 修订版：同一道题换了 id，另加一道新题
    await addBank('生理', [
      { ...choice, id: 'q-new-1' },
      { ...choice, id: 'q-new-2', stem: '另一题', options: ['x', 'y'], answer: 0, answerText: 'x' },
    ]);
    const questions = (await loadBanks())[0].questions;
    expect(questions[0].optionNotes).toEqual(['', '右移是亲和力下降', '']);
    expect(questions[1].optionNotes).toBeUndefined();
  });
});
