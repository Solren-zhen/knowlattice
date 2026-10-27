// @vitest-environment jsdom
/**
 * 题库面板顶部的「今日知识点」条：DOM 层验证它真的会出现在列表上方，
 * 并且「练这 5 题」能开出一轮只含该章节的练习。
 *
 * 为什么非要在 DOM 层再测一遍：挑选逻辑（core/dailyKnowledge）已经单测过，
 * 但「挑出来了却没有渲染」「按钮点了没进练习」这两类接线错误只有挂上组件才看得见。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';

const BANK = '今日知识点测试库';

function seedBank() {
  // 一个章节 6 题（全部同章）：低于 MIN_COUNT 的章节不会出现，这里正好越过门槛
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

afterEach(async () => {
  cleanup();
  await removeBankAndStats(BANK);
});

describe('今日知识点条', () => {
  it('题库里有够题的章节时，列表上方出现「今日知识点」并可开练', async () => {
    await seedBank();
    await initializeStats();
    const props = {
      docs: new Map<string, string>(),
      resolveLink: () => null,
      onOpenPath: vi.fn(),
      onClose: vi.fn(),
    };
    const { container } = render(<QuizView {...props} />);

    await waitFor(() => expect(screen.getByText(/今日知识点 · 测试章节/)).toBeTruthy());
    // 条必须在题库行之前：否则它会掉到列表下面，用户看不到
    const first = container.querySelector('.quiz-knowledge, .bank-item');
    expect(first?.classList.contains('quiz-knowledge')).toBe(true);

    fireEvent.click(screen.getByText('练这 5 题'));
    // 进入练习：题干出现，且题数按 5 题封顶
    await waitFor(() => expect(screen.getAllByText(/第 \d 题题干/).length).toBeGreaterThan(0));
    // 练习面板标题的真实文案：『<库名> · 第 1 / 5 题』——5 题封顶生效
    expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy();
  });

  it('点「今天看过了」后条上出现已看标记', async () => {
    await seedBank();
    await initializeStats();
    render(
      <QuizView
        docs={new Map<string, string>()}
        resolveLink={() => null}
        onOpenPath={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('今天看过了')).toBeTruthy());
    fireEvent.click(screen.getByText('今天看过了'));
    await waitFor(() => expect(screen.getByText('今天看过了', { selector: '.quiz-knowledge__flag' })).toBeTruthy());
  });
});
