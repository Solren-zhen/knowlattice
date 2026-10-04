// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dashboard from '../Dashboard';
import { recordCalibration } from '../../core/qbankCalib';

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

  it('有作答记录时展示 5 档校准条形与高估结论', () => {
    // 4 档：报 2 次对 1 次；5 档：报 1 次对 1 次 → 平均自信 87%，正确率 67%，高估 20 个百分点
    recordCalibration(4, true);
    recordCalibration(4, false);
    recordCalibration(5, true);
    render(
      <Dashboard docs={new Map()} onClose={vi.fn()} onOpenReview={vi.fn()} onOpenQuiz={vi.fn()} />,
    );

    const section = screen.getByRole('region', { name: '元认知校准' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    // 档位按自信度升序：1 纯猜 → 5 很确定
    expect(within(rows[0]).getByText('纯猜')).toBeTruthy();
    expect(within(rows[4]).getByText('很确定')).toBeTruthy();
    // 有样本的档位：实际正确率 + 作答次数
    expect(within(rows[3]).getByText('50%')).toBeTruthy();
    expect(within(rows[3]).getByText('2 次')).toBeTruthy();
    expect(within(rows[4]).getByText('100%')).toBeTruthy();
    expect(within(rows[4]).getByText('1 次')).toBeTruthy();
    // 没样本的档位：0 宽度并注明「暂无」
    expect(within(rows[0]).getByText('暂无')).toBeTruthy();
    expect(within(rows[0]).getByText('0 次')).toBeTruthy();
    expect((rows[0].querySelector('.dash-calib-fill') as HTMLElement).style.width).toBe('0%');
    // 结论行
    expect(within(section).getByText('平均自信 87%，实际答对 67% —— 高估 20 个百分点')).toBeTruthy();
  });

  it('没有作答记录时展示校准空状态引导', () => {
    render(
      <Dashboard docs={new Map()} onClose={vi.fn()} onOpenReview={vi.fn()} onOpenQuiz={vi.fn()} />,
    );

    const section = screen.getByRole('region', { name: '元认知校准' });
    expect(
      within(section).getByText('还没有数据：去题库练习作答前先选一个把握程度，这里就会画出你的校准曲线。'),
    ).toBeTruthy();
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
  });
});
