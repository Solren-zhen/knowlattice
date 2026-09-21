// @vitest-environment jsdom
/**
 * 复习卡片自定义 + 评分快捷键的 DOM 测试。
 *
 * 守两条链路：
 *   ① 快捷键 A/S/D/F 真的调到了评分（只在显示答案后生效，输入框里不抢键）；
 *   ② 编辑/删除卡片真的落到 core/cardEdits（笔记内容不动、删了还能恢复）。
 * 纯逻辑（切卡、迁移、分组）在 core/__tests__ 里已有单测，这里只验接线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// core/anki 静态 import 了 sql.js 与 wasm 资源，DOM 测试换成空实现：
// 导出链路由构建与 scripts/verify-pack 覆盖，这里只关心复习界面的交互。
vi.mock('../../core/anki', () => ({
  notesToAnki: () => '',
  exportApkg: async () => 0,
  downloadFile: () => {},
}));

import ReviewView from '../ReviewView';

const DOCS = new Map<string, string>([
  ['a.md', '# 甲笔记\n\n## 一、首选检查\n- 首选检查: 心电图\n\n## 二、机制\n- 机制: 折返\n'],
  ['b.md', '# 乙笔记\n\n这篇没有小节，应该只有一张卡。\n'],
]);

function renderView() {
  const props = {
    paths: ['a.md', 'b.md'],
    docs: DOCS,
    resolve: (() => null) as (n: string) => string | null,
    onOpenLink: vi.fn(),
    onClose: vi.fn(),
    onOpenPath: vi.fn(),
  };
  return { ...render(<ReviewView {...props} />), props };
}

const edits = () => JSON.parse(localStorage.getItem('knowlattice-card-edits') ?? '{}');
const srsRaw = () => localStorage.getItem('knowlattice-srs') ?? '';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('.mv-confirm-overlay').forEach((n) => n.remove());
});

describe('评分快捷键 A/S/D/F', () => {
  it('显示答案后按 d = 良好：调度写入 srs，队列前进到下一张', async () => {
    renderView();
    expect(screen.getByText('一、首选检查')).toBeTruthy();

    // 没显示答案时不响应：不能让人在没回忆完就打分
    fireEvent.keyDown(window, { key: 'd' });
    expect(srsRaw()).toBe('');
    expect(screen.getByText('一、首选检查')).toBeTruthy();

    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('良好');
    fireEvent.keyDown(window, { key: 'd' });

    await waitFor(() => expect(screen.getByText('二、机制')).toBeTruthy());
    expect(srsRaw()).toContain('a.md#一、首选检查');
  });

  it('按 a = 忘了：进入错题本并排到队尾，队列前进', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('忘了');
    fireEvent.keyDown(window, { key: 'a' });

    await waitFor(() => expect(screen.getByText('二、机制')).toBeTruthy());
    expect(srsRaw()).toContain('a.md#一、首选检查');
    expect(localStorage.getItem('knowlattice-mistakes') ?? '').toContain('a.md');
  });

  it('带修饰键的按键不触发评分（Ctrl+D 不该打分）', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('良好');
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(srsRaw()).toBe('');
  });

  it('输入框里打字不抢键（编辑器里按 a 不会评分）', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('良好');
    fireEvent.click(screen.getByText('编辑卡片'));
    const front = screen.getByLabelText('正面（问题）') as HTMLTextAreaElement;
    fireEvent.keyDown(front, { key: 'a' });
    expect(srsRaw()).toBe('');
  });
});

describe('编辑卡片（独立于笔记内容）', () => {
  it('保存后正面换成自定义内容，笔记原文一个字节没动', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('编辑卡片');
    fireEvent.click(screen.getByText('编辑卡片'));

    const front = screen.getByLabelText('正面（问题）') as HTMLTextAreaElement;
    fireEvent.change(front, { target: { value: '自定义问题' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(screen.getByText('自定义问题')).toBeTruthy());
    expect(edits()['a.md#一、首选检查']).toMatchObject({ front: '自定义问题' });
    // 笔记内容没被改写
    expect(DOCS.get('a.md')).toContain('## 一、首选检查');
    expect(DOCS.get('a.md')).not.toContain('自定义问题');
  });

  it('清空某一栏 = 那一面回到笔记原文；「恢复笔记原文」清掉整条自定义', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('编辑卡片');
    fireEvent.click(screen.getByText('编辑卡片'));
    fireEvent.change(screen.getByLabelText('背面（答案）'), { target: { value: '自定义答案' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(edits()['a.md#一、首选检查']?.back).toBe('自定义答案'));

    fireEvent.click(screen.getByText('编辑卡片'));
    fireEvent.click(screen.getByText('恢复笔记原文'));
    await waitFor(() => expect(edits()['a.md#一、首选检查']).toBeUndefined());
    // 背面回到笔记原文（按容器取文本：Preview 会把属性键和值拆成不同元素）
    await waitFor(() =>
      expect((document.querySelector('.review-back') as HTMLElement).textContent).toContain('心电图')
    );
  });
});

describe('删除卡片与恢复', () => {
  it('确认后卡片移出队列，笔记与进度都保留', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('删除卡片');
    fireEvent.click(screen.getByText('删除卡片'));

    await waitFor(() => expect(document.querySelector('.mv-confirm-ok')).toBeTruthy());
    fireEvent.click(document.querySelector('.mv-confirm-ok')!);

    await waitFor(() => expect(screen.getByText('二、机制')).toBeTruthy());
    expect(edits()['a.md#一、首选检查']).toMatchObject({ deleted: true });
    expect(DOCS.get('a.md')).toContain('## 一、首选检查');
  });

  it('取消确认则什么都不发生', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('删除卡片');
    fireEvent.click(screen.getByText('删除卡片'));
    await waitFor(() => expect(document.querySelector('.mv-confirm-cancel')).toBeTruthy());
    fireEvent.click(document.querySelector('.mv-confirm-cancel')!);

    await waitFor(() => expect(document.querySelector('.mv-confirm-overlay')).toBeNull());
    expect(edits()['a.md#一、首选检查']).toBeUndefined();
    expect(screen.getByText('一、首选检查')).toBeTruthy();
  });

  it('「已删卡片」列表能恢复回来（回到队列）', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('删除卡片');
    fireEvent.click(screen.getByText('删除卡片'));
    await waitFor(() => expect(document.querySelector('.mv-confirm-ok')).toBeTruthy());
    fireEvent.click(document.querySelector('.mv-confirm-ok')!);
    await waitFor(() => expect(screen.getByText('已删卡片 (1)')).toBeTruthy());

    fireEvent.click(screen.getByText('已删卡片 (1)'));
    await screen.findByText('恢复');
    expect(screen.getByText('甲笔记 · 一、首选检查')).toBeTruthy();
    fireEvent.click(screen.getByText('恢复'));

    await waitFor(() => expect(edits()['a.md#一、首选检查']).toBeUndefined());
    expect(screen.getByText('一、首选检查')).toBeTruthy();
  });
});

describe('建卡粒度在界面上真的生效', () => {
  it('一篇有小节的笔记出多张卡，正面是小节标题而不是整篇', () => {
    renderView();
    expect(screen.getByText('一、首选检查')).toBeTruthy();
    expect(screen.getByText(/共 2 节/)).toBeTruthy();
    // 属性键提示来自该小节
    expect(screen.getByText('首选检查')).toBeTruthy();
  });

  it('没有小节的笔记仍是一张整篇卡', async () => {
    renderView();
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('良好');
    fireEvent.keyDown(window, { key: 'f' });
    await waitFor(() => expect(screen.getByText('二、机制')).toBeTruthy());
    fireEvent.click(screen.getByText('显示答案'));
    await screen.findByText('良好');
    fireEvent.keyDown(window, { key: 'f' });
    await waitFor(() => expect(screen.getByText('乙笔记')).toBeTruthy());
  });
});
