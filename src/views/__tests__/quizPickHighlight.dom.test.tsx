// @vitest-environment jsdom
/**
 * 选项选中态：X 型题勾完不判定，必须能一眼看出「我勾了哪几个」。
 * 这里钉三件事：选中的按钮可被 aria 读出、尾部出现勾、提交行列出已选字母。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';

const BANK = '选中态测试库';

function seedBank() {
  const questions = Array.from({ length: 6 }, (_, i) => ({
    id: BANK + '-' + i,
    type: 'choice' as const,
    stem: '第 ' + i + ' 题题干（X 型题）',
    options: ['甲', '乙', '丙', '丁'],
    answers: [0, 2],
    answer: 0,
    chapter: '选中态章节',
  }));
  return putBank({ name: BANK, importedAt: Date.now(), questions });
}

const props = {
  docs: new Map<string, string>(),
  resolveLink: () => null,
  onOpenPath: vi.fn(),
  onClose: vi.fn(),
};

afterEach(async () => {
  cleanup();
  await removeBankAndStats(BANK);
});

describe('选项选中高亮', () => {
  it('多选勾两项：选中项可读出、有勾、提交行列出已选字母', async () => {
    await seedBank();
    await initializeStats();
    render(<QuizView {...props} />);
    await waitFor(() => expect(screen.getByText(/今日知识点 · 选中态章节/)).toBeTruthy());
    fireEvent.click(screen.getByText('练这 5 题'));
    await waitFor(() => expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy());

    fireEvent.click(screen.getByText('甲', { exact: false }));
    fireEvent.click(screen.getByText('丙', { exact: false }));

    // 用 classList 精确比对：className.includes('on') 会命中 opt-note 之类的相邻类名
    const opts = screen.getAllByRole('button').filter((b) => b.classList.contains('opt'));
    const on = opts.filter((b) => b.classList.contains('on'));
    expect(on).toHaveLength(2);
    for (const b of on) expect(b.getAttribute('aria-pressed')).toBe('true');

    expect(screen.getByText('已选：A、C')).toBeTruthy();

    // 取消勾选后回到一项
    fireEvent.click(screen.getByText('甲', { exact: false }));
    expect(screen.getByText('已选：C')).toBeTruthy();
  });
});
