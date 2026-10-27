// @vitest-environment jsdom
/**
 * 命令面板与生词本面板的行为测试（DOM 层）。
 *
 * 为什么测这一层：matchCommands / vocab 的纯逻辑已有单测，但「面板打开后键盘能不能用、
 * 点进去的词是不是真的写进了生词本」只有把组件挂起来才知道。这两处都是纯本地交互，
 * 没有网络与重依赖，适合直接 DOM 断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CommandPalette, { type PaletteCommand } from '../CommandPalette';
import VocabView from '../VocabView';
import { addVocab, loadVocab, removeVocab } from '../../core/vocab';

afterEach(cleanup);

function cmds(onRun: () => void): PaletteCommand[] {
  return [
    { id: 'quiz', title: '题库练习', group: '题库', run: onRun },
    { id: 'vocab', title: '生词本', group: '题库', aliases: ['单词'], run: () => {} },
  ];
}

describe('命令面板', () => {
  it('输入过滤后回车执行，执行完关闭', async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={cmds(onRun)} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/输入命令/);
    fireEvent.change(input, { target: { value: '刷题' } });
    // 「刷题」只是 title 里的字，不命中；换别名以外的词验证真实过滤
    expect(screen.queryByText('生词本')).toBeNull();

    fireEvent.change(input, { target: { value: '题库' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭面板且不执行任何命令', async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={cmds(onRun)} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/输入命令/), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe('生词本面板', () => {
  it('输入词点「收词」后写进本地词表并出现在列表里', async () => {
    const term = 'zz-dom-splenomegaly';
    removeVocab(term);
    const onClose = vi.fn();
    render(<VocabView onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/词（英文术语/), { target: { value: term } });
    fireEvent.change(screen.getByPlaceholderText(/释义（可留空/), { target: { value: '脾肿大' } });
    fireEvent.click(screen.getByText('收词'));

    await waitFor(() => expect(loadVocab().some((e) => e.term === term && e.def === '脾肿大')).toBe(true));
    expect(screen.getByText(term)).toBeTruthy();
    expect(screen.getByLabelText(`删除 ${term}`)).toBeTruthy();
    removeVocab(term);
  });

  it('词多了以后能在面板里筛（不改变词表本身）', async () => {
    const terms = Array.from({ length: 7 }, (_, i) => 'zz-filter-' + String(i));
    for (const t of terms) { removeVocab(t); addVocab(t, t.endsWith('3') ? '目标词' : '别的'); }
    render(<VocabView onClose={vi.fn()} />);
    // 7 条才出现搜索框：词少时不该多占一行
    const box = screen.getByPlaceholderText('在词表里找…');
    fireEvent.change(box, { target: { value: '目标' } });
    expect(screen.getByText('zz-filter-3')).toBeTruthy();
    expect(screen.queryByText('zz-filter-0')).toBeNull();
    // 筛掉的只是显示，词表本身不动
    expect(loadVocab().filter((e) => e.term.startsWith('zz-filter-')).length).toBe(7);
    for (const t of terms) removeVocab(t);
  });

  it('没有到期词时点「开始复习」只提示，不进入复习态', async () => {
    const onClose = vi.fn();
    render(<VocabView onClose={onClose} />);
    fireEvent.click(screen.getByText('开始复习'));
    expect(screen.queryByLabelText('生词复习')).toBeNull();
  });
});
