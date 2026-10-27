// @vitest-environment jsdom
/**
 * 题库练习「答题中点外面 = 整轮静默退出」的回归测试。
 *
 * 遮罩 `.panel-backdrop.quiz-overlay` 铺满整屏并挂了 `onClick={requestClose}`，
 * 所以「点面板外面的任何东西」（包括外面看着还在的按钮）实际点到的都是它。
 * 旧判据是「有没有答过题」——刚开练、第一题还没提交时点一下外面，整轮一声不响地退掉
 * （用户实测反馈「题库训练时候点击外面的按钮会直接退出训练」）。
 * 现在按「还在答题中」拦：弹确认，取消就留在原题。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';
import { clearCursor } from '../../core/quizCursor';

const BANK = '退出策略测试库';

function seedBank() {
  const questions = Array.from({ length: 3 }, (_, i) => ({
    id: `${BANK}-${i}`,
    type: 'choice' as const,
    stem: `退出策略第 ${i} 题`,
    options: ['甲', '乙'],
    answer: 0,
    chapter: '测试章节',
  }));
  return putBank({ name: BANK, importedAt: Date.now(), questions });
}

function makeProps() {
  return {
    docs: new Map<string, string>(),
    resolveLink: () => null,
    onOpenPath: vi.fn(),
    onClose: vi.fn(),
  };
}

const backdrop = () => document.querySelector('.quiz-overlay') as HTMLElement;
const confirmDialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;

/** 从题库列表点进「整库练习」，停在第一题、一道都还没答 */
async function enterPractice() {
  await waitFor(() => screen.getByText(BANK));
  // 题库加载完可能还会再刷一次列表（把展开状态重置），所以点开这一步放进 waitFor 里重试
  await waitFor(() => {
    const toggle = document.querySelector('.bank-actions-toggle') as HTMLElement | null;
    expect(toggle).toBeTruthy();
    if (toggle?.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle!);
    expect(screen.getByRole('button', { name: '整库练习' })).toBeTruthy();
  });
  fireEvent.click(screen.getByRole('button', { name: '整库练习' }));
  await waitFor(() => screen.getByText(/第 1 \/ 3 题/));
}

afterEach(async () => {
  cleanup();
  clearCursor();
  document.querySelectorAll('.mv-confirm-overlay').forEach((el) => el.remove());
  await removeBankAndStats(BANK);
});

describe('题库练习 · 退出策略', () => {
  it('第一题还没答时点面板外面：弹确认，不直接退出', async () => {
    await seedBank();
    await initializeStats();
    const props = makeProps();
    render(<QuizView {...props} />);
    await enterPractice();

    fireEvent.click(backdrop());
    await waitFor(() => expect(confirmDialog()).toBeTruthy());

    expect(props.onClose).not.toHaveBeenCalled();
    expect(confirmDialog()?.textContent).toContain('这一轮还没做完');
    // 取消后仍在答题
    fireEvent.click(document.querySelector('.mv-confirm-cancel') as HTMLElement);
    await waitFor(() => expect(confirmDialog()).toBeNull());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/第 1 \/ 3 题/)).toBeTruthy();
  });

  it('确认里点「退出」才真的关闭', async () => {
    await seedBank();
    await initializeStats();
    const props = makeProps();
    render(<QuizView {...props} />);
    await enterPractice();

    fireEvent.click(backdrop());
    await waitFor(() => expect(confirmDialog()).toBeTruthy());
    fireEvent.click(document.querySelector('.mv-confirm-ok') as HTMLElement);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });

  it('没在答题（题库列表）时点外面照旧直接关闭', async () => {
    await seedBank();
    await initializeStats();
    const props = makeProps();
    render(<QuizView {...props} />);
    await waitFor(() => screen.getByText(BANK));

    fireEvent.click(backdrop());
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(confirmDialog()).toBeNull();
  });
});
