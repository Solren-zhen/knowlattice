// @vitest-environment jsdom
/**
 * 搜题的 DOM 验收：跨题库按关键词找题、等价词命中、单题精练、结果里直接收藏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import type { QuizQuestion } from '../../core/qbank';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { resetQbankStatsForTests } from '../../core/qbankStats';
import { isStarred, loadStars, resetStarsForTests } from '../../core/qbankStarred';

const BANK = '绿皮书·生理学';

const QUESTIONS: QuizQuestion[] = [
  { id: 'a', type: 'choice', stem: '氧解离曲线右移的意义是？', options: ['容易放氧', '容易结合氧'], answer: 0, answerText: '容易放氧', chapter: '生理学' },
  { id: 'b', type: 'choice', stem: '心肌梗死的典型表现', options: ['胸痛', '头痛'], answer: 0, answerText: '胸痛', chapter: '内科学' },
  { id: 'c', type: 'choice', stem: '家族史采集要点', options: ['问三代', '不问'], answer: 0, answerText: '问三代', chapter: '全科' },
];

const DOCS = new Map<string, string>();

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  resetStarsForTests();
  await resetQbankStorageForTests();
  localStorage.setItem('knowlattice-qbanks', JSON.stringify([
    { name: BANK, importedAt: Date.now(), questions: QUESTIONS },
  ]));
});

afterEach(() => cleanup());

async function setup() {
  const rendered = render(
    <QuizView docs={DOCS} resolveLink={() => null} onOpenPath={vi.fn()} onClose={vi.fn()} />,
  );
  await screen.findByRole('button', { name: '组题' });
  return rendered;
}

const search = (q: string) => fireEvent.change(screen.getByLabelText('搜索题目'), { target: { value: q } });
const items = (c: HTMLElement) => Array.from(c.querySelectorAll('.quiz-search-item'));

describe('搜题', () => {
  it('输入关键词跨题库找题，题干带高亮', async () => {
    const { container } = await setup();
    search('氧解离');
    await waitFor(() => expect(items(container)).toHaveLength(1));
    expect(items(container)[0].textContent).toContain('氧解离曲线');
    expect(container.querySelector('.qs-mark')?.textContent).toBe('氧解离');
  });

  it('等价词命中：搜「心梗」找到写着「心肌梗死」的题', async () => {
    const { container } = await setup();
    search('心梗');
    await waitFor(() => expect(items(container)).toHaveLength(1));
    expect(items(container)[0].textContent).toContain('心肌梗死');
  });

  it('无命中时给出空结果提示', async () => {
    const { container } = await setup();
    search('zzz没有这题qqq');
    await waitFor(() => expect(container.textContent).toContain('没有匹配的题目'));
    expect(items(container)).toHaveLength(0);
  });

  it('点「练这题」进入单题精练', async () => {
    const { container } = await setup();
    search('心梗');
    await waitFor(() => expect(items(container)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '练这题' }));
    expect(container.textContent).toContain('第 1 / 1 题');
  });

  it('结果里可直接收藏，状态落到存储', async () => {
    const { container } = await setup();
    search('氧解离');
    await waitFor(() => expect(items(container)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '收藏这道题（重点题）' }));
    await waitFor(() => expect(isStarred(loadStars(), BANK, 'a')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消收藏' })).toBeTruthy());
  });

  it('关键词为空时不进结果态', async () => {
    const { container } = await setup();
    expect(container.querySelector('.quiz-search-results')).toBeNull();
  });
});
