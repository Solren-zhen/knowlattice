// @vitest-environment jsdom
/**
 * 增量导入（core/qbankMerge）的验收：只补新题、不重复、不覆盖用户已有题目。
 *
 * 守六件事：
 *  ① 指纹与 id 无关（id 带 Date.now()，见 core/qbank.ts:472；拿 id 去重永远检测不出重复）；
 *  ② 同一批题（含同库重导、同一批次内重复）不重复入库，顺序确定（existing 原序在前、
 *     新题按 incoming 原序追加、同内容取首个出现者），界面顺序不会抖；
 *  ③ **existing 里题目的原 id 一个都不动** —— 逐题统计（qbankStats 的 QStat）、错题本、
 *     FSRS 复习、组题、Anki 导出全部以「题库名 + 题目 id」为键，换 id 等于把用户历史作废；
 *  ④ 用户已有内容不被覆盖（只补缺：解析/章节/笔记这类空字段才填）；
 *  ⑤ 上一轮的 X 型多选 / 一题多解析 / 选项图 / 共用题干 / 多章节字段合并后原样保留（不裁剪字段）；
 *  ⑥ 报告文案：新库名走原路径、文案逐字不变；同名库走合并时写明「新增 N 题 / 已存在 M 题（跳过）」。
 *
 * 样例全部自造（甲/乙/丙 + 题干 N 的占位内容），**不含任何真实医学题目**。
 *
 * 关于最后那段 DOM 验收为什么写在这个文件里：本轮任务只允许新建
 * `src/core/qbankMerge.ts`、`src/core/__tests__/qbankMerge.test.ts` 与修改 `src/views/QuizView.tsx`，
 * 不能再在 `src/views/__tests__/` 下新建文件；所以界面部分用 `createElement` 直接渲染 QuizView
 * （`.ts` 文件里不能写 JSX）。跑法：
 *   npx vitest run src/core/__tests__/qbankMerge.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mergeQuestions, mergeSummary, questionFingerprint } from '../qbankMerge';
import { loadBanks, type QuizQuestion } from '../qbank';
import { resetQbankStatsForTests } from '../qbankStats';
import { resetQbankStorageForTests } from '../../storage/qbank';
import QuizView from '../../views/QuizView';

const OPTS = ['甲选项', '乙选项'];

/** 造一道占位选择题。内容全是占位符，结构与真实题库一致（type/options/answer/answerText） */
function q(id: string, stem: string, extra: Partial<QuizQuestion> = {}): QuizQuestion {
  return { id, type: 'choice', stem, options: [...OPTS], answer: 0, answerText: OPTS[0], ...extra };
}

const stems = (qs: QuizQuestion[]) => qs.map((x) => x.stem);
const ids = (qs: QuizQuestion[]) => qs.map((x) => x.id);

describe('内容指纹 questionFingerprint', () => {
  it('与 id 无关：同一道题换 id，指纹一模一样', () => {
    // id 是解析时现造的、带 Date.now() 时间戳（core/qbank.ts:472），同一文件导两次每道题 id 都不同
    expect(questionFingerprint(q('q-甲-0', '题干甲？'))).toBe(questionFingerprint(q('q-乙-99', '题干甲？')));
  });

  it('对空白与全角半角做归一：全角空格/全角字母 + 多余空格视作同一道题', () => {
    const half = q('a1', 'Hb 与氧结合？', {
      options: ['A 选项', 'B 选项'],
      chapter: '生理 学',
    });
    const full = q('a2', '　Ｈｂ　与氧结合？　', {
      options: ['Ａ 选项', 'B  选项'],
      chapter: '生理　学',
    });
    expect(questionFingerprint(full)).toBe(questionFingerprint(half));
  });

  it('不把大小写当成同一道题（pH / PH 在题库里是有意义的内容差异）', () => {
    expect(questionFingerprint(q('a1', 'pH 值？'))).not.toBe(questionFingerprint(q('a2', 'PH 值？')));
  });

  it('章节的单值写法与数组写法等价；多选（X 型）按答案集合比对', () => {
    expect(questionFingerprint(q('a1', '题干甲？', { chapter: '章节甲' })))
      .toBe(questionFingerprint(q('a2', '题干甲？', { chapters: ['章节甲'] })));

    const x1 = q('m1', '题干多选？', { answer: 0, answers: [0, 2], answerText: 'A. 甲选项；C. 丙选项' });
    const x2 = q('m2', '题干多选？', { answer: 0, answers: [0, 2], answerText: '写法不同但不影响判分' });
    expect(questionFingerprint(x1)).toBe(questionFingerprint(x2));
  });
});

describe('合并 mergeQuestions', () => {
  it('空 existing：全部按 incoming 原序入库', () => {
    const res = mergeQuestions([], [q('n1', '题干甲？'), q('n2', '题干乙？')]);
    expect(res.added).toBe(2);
    expect(res.duplicated).toBe(0);
    expect(stems(res.questions)).toEqual(['题干甲？', '题干乙？']);
    expect(ids(res.questions)).toEqual(['n1', 'n2']);
  });

  it('空 incoming：什么都不变，且不改入参（纯函数）', () => {
    const existing = [q('e1', '题干甲？')];
    const res = mergeQuestions(existing, []);
    expect(res.added).toBe(0);
    expect(res.duplicated).toBe(0);
    expect(res.questions).toEqual(existing);
    expect(existing).toHaveLength(1);
  });

  it('完全相同的一批（同一文件导两次，id 不同）：0 新增，且保留旧 id 与旧对象', () => {
    const existing = [q('old-1', '题干甲？')];
    const res = mergeQuestions(existing, [q('new-1', '题干甲？')]);
    expect(res.added).toBe(0);
    expect(res.duplicated).toBe(1);
    expect(res.questions).toHaveLength(1);
    // 硬性要求：旧题的 id 原样保留（统计/错题本/复习/组题都以它为键）
    expect(res.questions[0].id).toBe('old-1');
    // 连对象引用都没换 —— 说明真的一个字段都没动
    expect(res.questions[0]).toBe(existing[0]);
  });

  it('部分重叠：只补缺的那几道，重叠的跳过', () => {
    const existing = [q('e1', '题干甲？'), q('e2', '题干乙？')];
    const res = mergeQuestions(existing, [q('n2', '题干乙？'), q('n3', '题干丙？')]);
    expect(res.added).toBe(1);
    expect(res.duplicated).toBe(1);
    expect(stems(res.questions)).toEqual(['题干甲？', '题干乙？', '题干丙？']);
    expect(res.questions[1].id).toBe('e2');
  });

  it('增删改各一种：新增入库、被删的不删、用户自己的解析不被覆盖', () => {
    const existing = [
      q('keep-1', '题干甲？'),
      q('old-2', '题干乙？'),
      q('user-3', '题干丙？', { explanation: '我自己写的解析' }),
    ];
    // 更新后的一批：甲没变、乙没了（删）、丙的解析被改（改）、丁是新的（增）
    const incoming = [
      q('n1', '题干甲？'),
      q('n3', '题干丙？', { explanation: '题源给的解析' }),
      q('n4', '题干丁？'),
    ];
    const res = mergeQuestions(existing, incoming);

    expect(res.added).toBe(1); // 增：只有丁
    expect(res.duplicated).toBe(2); // 甲、丙已在库
    expect(stems(res.questions)).toEqual(['题干甲？', '题干乙？', '题干丙？', '题干丁？']); // 删：乙还在
    expect(res.questions[2].explanation).toBe('我自己写的解析'); // 改：用户内容优先，不替换
    expect(res.enriched).toBe(0);
  });

  it('指纹相同但新数据更全：只补缺（解析/章节/笔记），不算新增', () => {
    const existing = [q('old-1', '题干甲？', { chapter: '章节甲' })];
    const res = mergeQuestions(existing, [
      q('n1', '题干甲？', { chapter: '章节甲', explanation: '题源补上的解析', note: '关联笔记甲' }),
    ]);
    expect(res.added).toBe(0);
    expect(res.duplicated).toBe(1);
    expect(res.enriched).toBe(1);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].id).toBe('old-1');
    expect(res.questions[0].explanation).toBe('题源补上的解析');
    expect(res.questions[0].note).toBe('关联笔记甲');
    expect(existing[0].explanation).toBeUndefined(); // 纯函数：入参没被改
  });

  it('已有题缺章节、新数据补了章节：算同一道题（不因章节变更让整库翻倍）', () => {
    const existing = [q('old-1', '题干甲？')];
    const res = mergeQuestions(existing, [q('n1', '题干甲？', { chapter: '章节甲' })]);
    expect(res.added).toBe(0);
    expect(res.enriched).toBe(1);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].chapter).toBe('章节甲');
    expect(res.questions[0].id).toBe('old-1');
  });

  it('题干相同但章节不同：按新题入库并在结果里点名（不静默丢题、也不覆盖旧题）', () => {
    const existing = [q('old-1', '题干甲？', { chapter: '章节甲' })];
    const res = mergeQuestions(existing, [q('n1', '题干甲？', { chapter: '章节乙' })]);
    expect(res.added).toBe(1);
    expect(res.chapterMismatch).toBe(1);
    expect(res.questions).toHaveLength(2);
    expect(res.questions[0].chapter).toBe('章节甲'); // 旧题不动
    expect(res.questions[1].id).toBe('n1');
  });

  it('顺序确定：existing 原序在前、新题按 incoming 原序追加、同内容取首个出现者', () => {
    const existing = [q('e1', '题干甲？'), q('e2', '题干乙？')];
    const incoming = [q('n1', '题干丙？'), q('n2', '题干甲？'), q('n3', '题干丁？'), q('n4', '题干丙？')];
    const a = mergeQuestions(existing, incoming);
    const b = mergeQuestions(existing, incoming);
    expect(stems(a.questions)).toEqual(['题干甲？', '题干乙？', '题干丙？', '题干丁？']);
    expect(a.added).toBe(2); // 丙（n1）、丁（n3）
    expect(a.duplicated).toBe(2); // 甲（n2）、丙（n4 与前一份同内容）
    expect(ids(a.questions)).toEqual(ids(b.questions)); // 同样输入 → 同样结果，不会抖动
    expect(a.questions[2].id).toBe('n1'); // tie-break：先出现的那一份为准
  });

  it('X 型多选 / 一题多解析 / 选项图 / 共用题干 / 多章节：合并后原样保留（不裁剪字段）', () => {
    const rich: QuizQuestion = {
      id: 'rich-1',
      type: 'choice',
      stem: '题干共用？',
      options: ['甲选项', '乙选项', '丙选项'],
      answer: 0,
      answers: [0, 2],
      answerText: 'A. 甲选项；C. 丙选项',
      explanations: [
        { source: '甲老师版', text: '解析甲' },
        { source: '乙老师版', text: '解析乙' },
      ],
      optionImages: ['_attachments/甲.png', null, '_attachments/丙.png'],
      groupStem: '共用题干甲',
      groupNo: 2,
      groupTotal: 3,
      groupId: 'g-甲',
      chapter: '章节甲',
      chapters: ['章节甲', '章节乙'],
    };
    const res = mergeQuestions([rich], [{ ...rich, id: 'rich-2' }]);
    expect(res.duplicated).toBe(1);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0]).toBe(rich);
    expect(res.questions[0].answers).toEqual([0, 2]);
    expect(res.questions[0].explanations).toHaveLength(2);
    expect(res.questions[0].optionImages).toEqual(['_attachments/甲.png', null, '_attachments/丙.png']);
    expect(res.questions[0].groupStem).toBe('共用题干甲');
    expect(res.questions[0].chapters).toEqual(['章节甲', '章节乙']);
  });

  it('新题 id 与已有题撞号时：旧题 id 不动，给新题另发一个（id 撞号 = 两道题共用一份记录）', () => {
    const existing = [q('same-1', '题干甲？')];
    const res = mergeQuestions(existing, [q('same-1', '题干乙？')]);
    expect(res.added).toBe(1);
    expect(res.questions[0].id).toBe('same-1');
    expect(res.questions[1].id).not.toBe('same-1');
    expect(res.questions[1].stem).toBe('题干乙？');
  });

  it('新题连 id 都没有（手造数据）也会补一个可用 id', () => {
    const res = mergeQuestions([], [q('', '题干甲？')]);
    expect(res.questions[0].id).toBeTruthy();
    expect(res.questions[0].id).not.toBe('');
  });
});

describe('mergeSummary 文案', () => {
  it('新增 + 跳过是最常规的一句', () => {
    const res = mergeQuestions([q('e1', '题干甲？')], [q('n1', '题干甲？'), q('n2', '题干乙？')]);
    expect(mergeSummary(res)).toBe('增量导入：新增 1 题，已存在 1 题（跳过）');
  });

  it('补全过缺失字段、有章节冲突时各补一句（不静默）', () => {
    const filled = mergeQuestions([q('e1', '题干甲？')], [q('n1', '题干甲？', { explanation: '解析甲' })]);
    expect(mergeSummary(filled)).toContain('1 题补全了缺失的解析/章节等字段');

    const conflict = mergeQuestions([q('e1', '题干甲？', { chapter: '章节甲' })], [q('n1', '题干甲？', { chapter: '章节乙' })]);
    expect(mergeSummary(conflict)).toContain('题干相同但章节不同');
    expect(mergeSummary(conflict)).toContain('请核对');
  });

  it('没有可合并的题目时也要说得出口', () => {
    expect(mergeSummary(mergeQuestions([], []))).toBe('增量导入：这次没有可合并的题目');
  });
});

// ---------- 界面验收：同库名二次导入 ----------

const BANK = '库甲';

/** 库里预置的那道题（占位内容） */
const SEEDED: QuizQuestion[] = [
  { id: 'seed-1', type: 'choice', stem: '题干甲？', options: ['甲选项', '乙选项'], answer: 0, answerText: '甲选项', chapter: '章节甲' },
];

/** 题库 JSON 的隐藏 file input（三个里唯一 accept 含 json 的那个） */
function jsonInput(container: HTMLElement): HTMLInputElement {
  const el = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .find((i) => (i.getAttribute('accept') ?? '').includes('json'));
  if (!el) throw new Error('没找到题库 JSON 的 file input');
  return el;
}

/** 造一个能被 file.text() 读出来的 JSON 文件 */
const jsonFile = (name: string, value: unknown) =>
  new File([JSON.stringify(value)], name, { type: 'application/json' });

/** 打开面板并展开导入区（题库非空 → 面板不处于首次导入态） */
async function setup() {
  const rendered = render(createElement(QuizView, {
    docs: new Map<string, string>(),
    resolveLink: () => null,
    onOpenPath: vi.fn(),
    onClose: vi.fn(),
  }));
  await screen.findByRole('button', { name: '组题' });
  fireEvent.click(screen.getByRole('button', { name: '导入题库' }));
  return rendered;
}

describe('增量导入 · 界面（同库名二次导入）', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetQbankStatsForTests();
    await resetQbankStorageForTests();
    localStorage.setItem('knowlattice-qbanks', JSON.stringify([
      { name: BANK, importedAt: Date.now(), questions: SEEDED },
    ]));
  });

  afterEach(cleanup);

  it('同库名再导一次：报告写明「已存在」、库里题数不翻倍、已有题 id 不变', async () => {
    const { container } = await setup();
    fireEvent.change(jsonInput(container), {
      target: {
        files: [jsonFile('库甲.json', {
          name: BANK,
          questions: [
            { stem: '题干甲？', options: ['甲选项', '乙选项'], answer: 0, chapter: '章节甲' }, // 已在库
            { stem: '题干乙？', options: ['甲选项', '乙选项'], answer: 0, chapter: '章节甲' }, // 新题
          ],
        })],
      },
    });

    await waitFor(() => expect(container.querySelector('.quiz-import-report')).toBeTruthy());
    const report = container.querySelector('.quiz-import-report')?.textContent ?? '';
    expect(report).toContain('增量导入：新增 1 题，已存在 1 题（跳过）');

    const bank = (await loadBanks()).find((b) => b.name === BANK);
    expect(bank?.questions).toHaveLength(2); // 旧题留着、新题补上：不翻倍、也不整库替换
    expect(bank?.questions[0].id).toBe('seed-1'); // 原 id 保留：逐题统计/错题本/复习不会错位
  });

  it('同一个文件连导两次：第二次 0 新增，库里题数不变', async () => {
    const { container } = await setup();
    const same = {
      name: BANK,
      questions: [{ stem: '题干乙？', options: ['甲选项', '乙选项'], answer: 0, chapter: '章节甲' }],
    };

    fireEvent.change(jsonInput(container), { target: { files: [jsonFile('库甲.json', same)] } });
    await waitFor(() => expect(container.querySelector('.quiz-import-report')?.textContent).toContain('新增 1 题'));
    expect((await loadBanks()).find((b) => b.name === BANK)?.questions).toHaveLength(2);

    fireEvent.change(jsonInput(container), { target: { files: [jsonFile('库甲.json', same)] } });
    await waitFor(() => expect(container.querySelector('.quiz-import-report')?.textContent).toContain('新增 0 题'));
    expect(container.querySelector('.quiz-import-report')?.textContent).toContain('已存在 1 题（跳过）');
    expect((await loadBanks()).find((b) => b.name === BANK)?.questions).toHaveLength(2); // 不重复
  });

  it('库里没有的库名：仍走原来的整库导入路径，报告文案逐字不变', async () => {
    const { container } = await setup();
    fireEvent.change(jsonInput(container), {
      target: {
        files: [jsonFile('库乙.json', [{ stem: '题干丙？', options: ['甲选项', '乙选项'], answer: 0 }])],
      },
    });

    await waitFor(() => expect(container.querySelector('.quiz-import-report')).toBeTruthy());
    const report = container.querySelector('.quiz-import-report')?.textContent ?? '';
    expect(report).toContain('库乙 · 1 题');
    expect(report).not.toContain('增量导入');
    expect((await loadBanks()).some((b) => b.name === '库乙')).toBe(true);
  });
});
