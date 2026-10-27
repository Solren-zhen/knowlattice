// @vitest-environment jsdom
/**
 * X 型题（多选）的选项批注。
 *
 * 用户报「X 型题无法批注」。根因不是判定逻辑：批注按钮原先只在 `answered` 之后渲染，
 * 而**多选要按「交卷」才算作答**——勾完选项还没交卷时点过去自然什么都没有；
 * 另一半原因在背题模式：那里压根没有铅笔按钮，而多选最常用的复习方式就是背题。
 *
 * 这里钉三条：
 * 1) 勾了选项、还没交卷，也能写批注；
 * 2) 交卷之后照样能写（不能因为放宽而丢掉原路径）；
 * 3) 背题模式每个选项都有批注入口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuizView from '../QuizView';
import { getAllBanks, putBank, removeBankAndStats } from '../../storage/qbank';
import { initializeStats } from '../../core/qbankStats';

const BANK = 'X型题批注测试库';

function seedBank() {
  const questions = Array.from({ length: 6 }, (_, i) => ({
    id: `${BANK}-${i}`,
    type: 'choice' as const,
    stem: `第 ${i} 题题干（X 型题）`,
    options: ['甲', '乙', '丙', '丁'],
    // answers 两个 → isMultiSelect 认定为多选，与机考 X 型题一致（全对才算对）
    answers: [0, 2],
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
  await removeBankAndStats(BANK);
});

/** 题库操作默认折叠：先把第一行的操作面板摊开（已展开就不重复点，避免又收回去） */
async function expandBankActions() {
  const toggle = await screen.findByRole('button', { name: /^操作：/ }, { timeout: 5000 });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

describe('X 型题批注', () => {
  it('勾了选项还没交卷，也能给选项写批注', async () => {
    await seedBank();
    await initializeStats();
    render(<QuizView {...props} />);
    await waitFor(() => expect(screen.getByText(/今日知识点 · 测试章节/)).toBeTruthy());
    fireEvent.click(screen.getByText('练这 5 题'));
    await waitFor(() => expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy());

    // 多选才有「交卷」，先确认这一题确实走的是 X 型题分支
    expect(screen.getByText(/交卷（已选/)).toBeTruthy();
    fireEvent.click(screen.getByText('甲', { exact: false }));

    // 关键：此刻还没交卷，铅笔也必须可用
    fireEvent.click(screen.getByLabelText('给选项 A 写批注'));
    const box = screen.getByPlaceholderText(/这个选项为什么对/);
    fireEvent.change(box, { target: { value: '甲是错的：静息电位靠钾外流' } });
    // 先确认受控值真的进了 state：commitNote 读的是 state 里的 draft，
    // 连着 fire 两个事件的写法会让 Ctrl+Enter 读到旧的空串，然后按「与原文相同」直接跳过保存。
    expect((box as HTMLTextAreaElement).value).toBe('甲是错的：静息电位靠钾外流');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    // commitNote 是 async（事件处理器不 await），写入要等一两个 tick；固定 sleep 在满载会漏
    await waitFor(async () => {
      const banks = (await getAllBanks()) as Array<{
        name: string;
        questions: Array<{ optionNotes?: (string | null)[] }>;
      }>;
      const bank = banks.find((b) => b.name === BANK);
      // 练题是洗牌的（pickQuestions 会随机打乱），当前这道不一定是 questions[0]：
      // 按「库里存在这道批注」断言，否则一半的运行会随机失败。
      const hit = bank?.questions.find((q) => q.optionNotes?.[0] === '甲是错的：静息电位靠钾外流');
      expect(hit).toBeTruthy();
    });
  });

  it('交卷之后照样能写批注', async () => {
    await seedBank();
    await initializeStats();
    render(<QuizView {...props} />);
    await waitFor(() => expect(screen.getByText(/今日知识点 · 测试章节/)).toBeTruthy());
    fireEvent.click(screen.getByText('练这 5 题'));
    await waitFor(() => expect(screen.getByText(/第 1 \/ 5 题/)).toBeTruthy());

    fireEvent.click(screen.getByText('甲', { exact: false }));
    fireEvent.click(screen.getByText('丙', { exact: false }));
    fireEvent.click(screen.getByText(/交卷（已选 2 项）/));

    // 原来只有这里才有铅笔；现在放宽了，这条老路径不能坏
    await waitFor(() => expect(screen.getByLabelText('给选项 C 写批注')).toBeTruthy());
  });

  it('背题模式每个选项都有批注入口', async () => {
    await seedBank();
    await initializeStats();
    render(<QuizView {...props} />);
    await expandBankActions();
    await waitFor(() => expect(screen.getByText('背题')).toBeTruthy());
    fireEvent.click(screen.getByText('背题'));

    await waitFor(() => expect(screen.getByText(/背题 · /)).toBeTruthy());
    expect(screen.getByLabelText('给选项 A 写批注')).toBeTruthy();
    expect(screen.getByLabelText('给选项 D 写批注')).toBeTruthy();
  });
});
