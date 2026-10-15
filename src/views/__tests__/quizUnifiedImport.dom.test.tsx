// @vitest-environment jsdom
/**
 * 「题库练习」导入入口统一化的 DOM 测试。
 *
 * 守两件事：
 *  ① 传了 onUnifiedImport 时：不再单独摆 .json / .docx / .xlsx 三个按钮，
 *     只剩一条「导入…（自动识别格式）」，点了交给 Workspace 打开统一面板；
 *  ② 粘贴导入保留（剪贴板里的文本没有文件可拖，走不了自动识别）。
 *
 * 样例全部自造（占位内容），不含任何真实题目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import QuizView from '../QuizView';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { resetQbankStatsForTests } from '../../core/qbankStats';

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
  // 预置一个题库：面板不处于「首次导入」态（那个分支会自动摊开导入区，与本次改动无关）
  localStorage.setItem('knowlattice-qbanks', JSON.stringify([
    {
      name: '已有题库甲', importedAt: Date.now(), questions: [
        { id: 'q1', type: 'choice', stem: '题干甲？', options: ['选项甲', '选项乙'], answer: 0, answerText: '选项甲' },
      ],
    },
  ]));
});

afterEach(cleanup);

async function setup(onUnifiedImport: () => void) {
  render(
    <QuizView docs={new Map()} resolveLink={() => null} onOpenPath={vi.fn()} onClose={vi.fn()} onUnifiedImport={onUnifiedImport} />
  );
  await screen.findByRole('button', { name: '组题' });
  fireEvent.click(screen.getByRole('button', { name: '导入题库' }));
}

describe('题库练习 · 统一导入入口', () => {
  it('传了 onUnifiedImport 时：三个格式按钮收敛成一个，点了交给统一面板', async () => {
    const onUnifiedImport = vi.fn();
    await setup(onUnifiedImport);

    // 分门别类的三个按钮不再出现（用户不必先知道自己的文件是 json / docx / xlsx）
    expect(screen.queryByText('题库文件 (.json)')).toBeNull();
    expect(screen.queryByText('Word (.docx)')).toBeNull();
    expect(screen.queryByText('Excel/CSV (.xlsx/.csv)')).toBeNull();

    const unified = screen.getByText('导入…（自动识别格式）');
    fireEvent.click(unified);
    expect(onUnifiedImport).toHaveBeenCalledTimes(1);
  });

  it('粘贴导入保留：剪贴板文本没有文件可拖，走不了自动识别', async () => {
    await setup(vi.fn());
    expect(screen.getByText('粘贴导入')).toBeTruthy();
  });
});
