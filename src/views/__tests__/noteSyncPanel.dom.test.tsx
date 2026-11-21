/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import NoteSyncPanel from '../NoteSyncPanel';
import { resetEscStack } from '../../core/escStack';

afterEach(() => {
  cleanup();
  resetEscStack();
});

describe('NoteSyncPanel Esc 与弹窗交互', () => {
  it('按 Esc 可关闭弹窗；焦点在搜索框时先退出输入再按一次才关闭', () => {
    const onClose = vi.fn();
    const docs = new Map<string, string>([['第一章/循环系统.md', '# 循环系统\n正文']]);
    const { getByRole, getByPlaceholderText } = render(
      <NoteSyncPanel docs={docs} paths={['第一章/循环系统.md']} onClose={onClose} />,
    );

    const dialog = getByRole('dialog', { name: '选择笔记发送到手机' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const search = getByPlaceholderText('搜索标题、章节或路径');
    search.focus();
    expect(document.activeElement).toBe(search);

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
