// @vitest-environment jsdom
/**
 * 首页「继续刷题」进来时，题库面板要**直接停在断点那一题**。
 * 只在组件上点一遍才看得见的差别：点了首页的续做 chip 却先落到题库列表、
 * 还要再点一次「继续上次」，那这个入口就等于没做。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';
import { clearCursor, saveCursor } from '../../core/quizCursor';

const BANK = '自动续做测试库';

function seedBank() {
  const questions = Array.from({ length: 4 }, (_, i) => ({
    id: `${BANK}-${i}`,
    type: 'choice' as const,
    stem: `自动续做第 ${i} 题`,
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

afterEach(async () => {
  cleanup();
  clearCursor();
  await removeBankAndStats(BANK);
});

describe('题库面板 · 首页续做直达', () => {
  it('autoResume 挂载后直接停在游标那一题，并回报已处理', async () => {
    await seedBank();
    await initializeStats();
    saveCursor({
      bank: BANK,
      qids: [`${BANK}-0`, `${BANK}-1`, `${BANK}-2`],
      idx: 2,
      rules: null,
      results: [true, false, null],
      at: Date.now(),
    });
    const done = vi.fn();
    render(<QuizView {...props} autoResume onAutoResumeDone={done} />);
    await waitFor(() => expect(screen.getByText(/第 3 \/ 3 题/)).toBeTruthy());
    expect(done).toHaveBeenCalledOnce();
  });

  it('没有 autoResume 时停在题库列表（不替用户擅自续做）', async () => {
    await seedBank();
    await initializeStats();
    saveCursor({ bank: BANK, qids: [`${BANK}-0`], idx: 0, rules: null, at: Date.now() });
    render(<QuizView {...props} />);
    await waitFor(() => expect(screen.getByText(/今日知识点 · 测试章节/)).toBeTruthy());
    expect(screen.queryByText(/第 1 \/ 1 题/)).toBeNull();
  });
});
