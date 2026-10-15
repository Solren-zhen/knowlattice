// @vitest-environment jsdom
/**
 * 题库导入的「自动识别形状」分支（core/qbankMapper 的接线）DOM 测试。
 *
 * 守两件事：
 *  ① 旧格式路径拿不到题目时，形状映射真的接进来了，并且**走同一条写库通道**
 *     （题库列表里出现它、报告区仍是 role=status），报告里写明识别成什么形状与置信度；
 *  ② 识别不出来时**不猜**：报告里给出「缺哪些字段」，一条题都不入库。
 *
 * 样例全部自造（占位内容），不含任何真实题目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { loadBanks } from '../../core/qbank';
import { resetQbankStatsForTests } from '../../core/qbankStats';

const BANK = '已有题库甲';

/** 「短键」形状的合成题库（字段名按万川式写法；内容是占位符） */
const SHORT_KEYS = [
  { s: '题干甲？', o: ['选项甲', '选项乙'], a: 0, t: 1, x: '解析甲' },
  { s: '题干乙？', o: ['选项丙', '选项丁'], a: 'B', t: 1 },
];

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
  // 预置一个题库：面板不处于「首次导入」态（那个分支与本次改动无关）
  localStorage.setItem('knowlattice-qbanks', JSON.stringify([
    {
      name: BANK, importedAt: Date.now(), questions: [
        { id: 'q1', type: 'choice', stem: '题干丙？', options: ['选项戊', '选项己'], answer: 0, answerText: '选项戊' },
      ],
    },
  ]));
});

afterEach(cleanup);

async function setup() {
  const rendered = render(
    <QuizView docs={new Map()} resolveLink={() => null} onOpenPath={vi.fn()} onClose={vi.fn()} />
  );
  await screen.findByRole('button', { name: '组题' });
  fireEvent.click(screen.getByRole('button', { name: '导入题库' }));
  return rendered;
}

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

describe('题库导入 · 自动识别形状', () => {
  it('旧路径拿不到题目时按形状映射导入，报告里写明识别结果与跳过情况', async () => {
    const { container } = await setup();
    fireEvent.change(jsonInput(container), { target: { files: [jsonFile('同业题库甲.json', SHORT_KEYS)] } });

    await waitFor(() => expect(container.textContent).toContain('识别为「短键题库（万川医考风格）」'));
    expect(container.textContent).toContain('2 题');
    // 写库通道仍是既有那条：题库列表里出现这个名字
    expect((await loadBanks()).some((b) => b.name === '同业题库甲')).toBe(true);
    // 报告区接线不动（仍是 role=status 的既有块）
    expect(container.querySelector('.quiz-import-report')?.getAttribute('role')).toBe('status');
  });

  it('识别不出来时只报「缺哪些字段」，不导入任何题目', async () => {
    const { container } = await setup();
    fireEvent.change(jsonInput(container), { target: { files: [jsonFile('不认识的甲.json', { records: [{ foo: '甲' }] })] } });

    await waitFor(() => expect(container.querySelector('.quiz-import-report-err')).toBeTruthy());
    const err = container.querySelector('.quiz-import-report-err')?.textContent ?? '';
    expect(err).toContain('也没识别出已知的题库形状');
    expect(err).toContain('没找到题目数组');
    expect((await loadBanks()).some((b) => b.name === '不认识的甲')).toBe(false);
  });
});
