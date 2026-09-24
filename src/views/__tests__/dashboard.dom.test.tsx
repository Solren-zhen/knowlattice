// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dashboard from '../Dashboard';

describe('学习统计面板', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('显示每日学习次数，并提供直接练题的下一步操作', async () => {
    const onOpenReview = vi.fn();
    const onOpenQuiz = vi.fn();
    render(
      <Dashboard docs={new Map()} onClose={vi.fn()} onOpenReview={onOpenReview} onOpenQuiz={onOpenQuiz} />,
    );

    const dialog = screen.getByRole('dialog', { name: '学习统计' });
    const days = within(dialog).getAllByRole('listitem');
    expect(days).toHaveLength(7);
    expect(days[6].getAttribute('aria-label')).toMatch(/：\d+ 次$/);
    expect(within(days[6]).getByText(/\d+/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '导入题库' }));
    await waitFor(() => expect(onOpenQuiz).toHaveBeenCalledOnce());
    expect(onOpenReview).not.toHaveBeenCalled();
  });

  it('有未学习的新卡时优先把用户送进复习队列', async () => {
    const onOpenReview = vi.fn();
    const onOpenQuiz = vi.fn();
    render(
      <Dashboard
        docs={new Map([['新笔记.md', '# 新笔记\n\n核心概念']])}
        onClose={vi.fn()}
        onOpenReview={onOpenReview}
        onOpenQuiz={onOpenQuiz}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始学习新卡' }));
    await waitFor(() => expect(onOpenReview).toHaveBeenCalledOnce());
    expect(onOpenQuiz).not.toHaveBeenCalled();
  });
});
