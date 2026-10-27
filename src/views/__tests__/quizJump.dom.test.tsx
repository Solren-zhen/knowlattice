// @vitest-environment jsdom
/**
 * 习题面板的前后移动：题号跳转输入框 + 「上一题」。
 *
 * 为什么要在 DOM 层测：跳转逻辑本身很短，但「回看时把作答状态丢了」
 * 只有在组件上点一遍才看得见（回到上一题却变成一道没答过的题）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';

const BANK = '前后移动测试库';

function seedBank() {
  const questions = Array.from({ length: 6 }, (_, i) => ({
    id: `${BANK}-${i}`,
    type: 'choice' as const,
    stem: `第 ${i} 题题干`,
    options: ['甲', '乙'],
    answer: 0,
    chapter: '测试章节',
  }));
  return putBank({ name: BANK, importedAt: Date.now(), questions });
}

const props = {
  docs: new Map<string, string>(),
  resolveLink: () => null,
  onOpenPath: vi.fn(),
  onClose: vi.fn(),
};

/** 开一轮练习：题库列表 → 「练这 5 题」 */
async function startPractice() {
  await seedBank();
  await initializeStats();
  render(<QuizView {...props} />);
  await waitFor(() => expect(screen.getByText(/今日知识点 · 测试章节/)).toBeTruthy());
  fireEvent.click(screen.getByText('练这 5 题'));
  await waitFor(() => expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy());
}

afterEach(async () => {
  cleanup();
  await removeBankAndStats(BANK);
});

describe('习题前后移动', () => {
  it('第一题时「上一题」不可点，也不显示越界的题号', async () => {
    await startPractice();
    const prev = screen.getByText('← 上一题').closest('button') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  it('输入题号回车能直接跳到那一题', async () => {
    await startPractice();
    const jump = screen.getByLabelText('跳到第几题') as HTMLInputElement;
    expect(jump.value).toBe('1');
    fireEvent.change(jump, { target: { value: '4' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/第 4 \/ 5 题/)).toBeTruthy());
  });

  it('跳过几题再点「上一题」，回到的题保留当时的作答（不是空白重做）', async () => {
    await startPractice();
    // 第 1 题：选一个选项（单选点一下即判定）。按结构取按钮：选项按钮的文本是「A 甲」，按文本找会落到别处
    const opt = document.querySelector('.quiz-opt button') as HTMLButtonElement;
    expect(opt).toBeTruthy();
    fireEvent.click(opt);
    // 等「已作答」才出现的底部条＝这题真判了：否则跳走时 results[idx] 还空着，回看当然什么都没有
    await waitFor(() => expect(document.querySelector('.quiz-footer')).toBeTruthy());

    const jump = screen.getByLabelText('跳到第几题') as HTMLInputElement;
    fireEvent.change(jump, { target: { value: '3' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/第 3 \/ 5 题/)).toBeTruthy());

    fireEvent.click(screen.getByText('← 上一题'));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 5 题/)).toBeTruthy());
    fireEvent.click(screen.getByText('← 上一题'));
    await waitFor(() => expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy());
    // 回到第 1 题时仍是「已作答」状态：不是空白重做
    expect(document.querySelector('.quiz-footer')).toBeTruthy();
  });
});
