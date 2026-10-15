// @vitest-environment jsdom
/**
 * 考试中心的 DOM 验收：首页四个入口齐全，且「模拟考试」能走完
 * 组卷 → 限时答题 → 交卷 → 分章节成绩报告 的完整链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExamCenter from '../ExamCenter';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { resetQbankStatsForTests } from '../../core/qbankStats';

const BANK = '绿皮书·生理学';
const OPTIONS = ['alpha', 'beta', 'gamma', 'delta'];
const QUESTIONS = Array.from({ length: 6 }, (_, i) => ({
  id: `q${i}`,
  type: 'choice' as const,
  stem: `题干 ${i}`,
  options: OPTIONS,
  answer: 0,
  answerText: OPTIONS[0],
  chapter: '生理学·第1章 绪论',
}));

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
  localStorage.setItem('knowlattice-qbanks', JSON.stringify([
    { name: BANK, importedAt: Date.now(), questions: QUESTIONS },
  ]));
});

afterEach(() => cleanup());

describe('考试中心', () => {
  it('首页给出模拟考试/每日一练/错题重练三个入口', async () => {
    render(<ExamCenter onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /模拟考试/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /每日一练/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /错题重练/ })).toBeTruthy();
    // 高频考点区随题库出现
    expect(screen.getByText('高频考点（按章节题量）')).toBeTruthy();
  });

  it('模拟考试：组卷 → 作答 → 交卷 → 分章节成绩报告', async () => {
    render(<ExamCenter onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /模拟考试/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /模拟考试/ }));
    fireEvent.click(await screen.findByRole('button', { name: '开始考试' }));

    // 答题页
    const submit = await screen.findByRole('button', { name: /交卷/ });
    fireEvent.click(screen.getByRole('button', { name: /alpha/ })); // 选正确项
    fireEvent.click(submit);

    // 成绩报告
    await waitFor(() => expect(screen.getByText('分章节得分')).toBeTruthy());
    expect(screen.getByText(/题正确/)).toBeTruthy();
    // 章节名同时出现在「分章节得分」与「薄弱章节」提示里，用 getAllByText
    expect(screen.getAllByText(/生理学·第1章 绪论/).length).toBeGreaterThan(0);
  });
});
