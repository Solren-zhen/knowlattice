// @vitest-environment jsdom
/**
 * Workspace 布局冒烟测试（jsdom + fake-indexeddb，不跑真实浏览器）：
 * 守住历史回归——树卡片在未打开笔记时消失、内容不居中、导航轨缺失入口等。
 * 只断言「结构存在 + 关键流程可达」，不测像素。
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { openDB } from 'idb';
import Workspace from '../Workspace';

// jsdom 没有 ResizeObserver（ChapterTree 虚拟滚动用到）
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const NOTE_A = {
  path: '00-三分钟上手.md',
  content: '---\ntitle: 三分钟上手\ntype: concept\n---\n\n## 试试看\n\n- 新建: 点左上角 ＋\n- 这里是 [[分隔线]] 测试',
  mtime: Date.now(),
  size: 10,
};
const NOTE_B = {
  path: '01-生理学/呼吸/波尔效应.md',
  content: '# 波尔效应\n\npH 降低时氧解离曲线右移。',
  mtime: Date.now(),
  size: 10,
};

async function seed() {
  const db = await openDB('knowlattice', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments', { keyPath: 'path' });
    },
  });
  for (const n of [NOTE_A, NOTE_B]) await db.put('files', n);
  db.close();
}

beforeAll(async () => {
  localStorage.clear();
  localStorage.removeItem('knowlattice-onboarded');
  await seed();
});

describe('Workspace 布局冒烟', () => {
  it('导航轨完整渲染（17 个入口）', async () => {
    render(<Workspace />);
    await waitFor(() => expect(screen.getByLabelText('回到主界面')).toBeTruthy());
    for (const name of ['目录', '搜索', '历史版本', '解剖图谱', '知识图谱', '间隔复习', '错题本',
      '题库练习', '待办清单', '标签', '学习统计', 'AI 助手', '智能草稿', 'PDF 对照', '格式转换', '切换主题']) {
      expect(screen.getByLabelText(name), `缺少 rail 入口：${name}`).toBeTruthy();
    }
    cleanup();
  });

  it('导航可展开为带分组的文字标签，并记住偏好', async () => {
    localStorage.removeItem('knowlattice-rail-expanded');
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByRole('button', { name: '展开导航标签' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开导航标签' }));
    expect(container.querySelector('.rail')?.classList.contains('rail--expanded')).toBe(true);
    expect(screen.getByText('工作区')).toBeTruthy();
    expect(screen.getByText('学习')).toBeTruthy();
    expect(localStorage.getItem('knowlattice-rail-expanded')).toBe('true');
    cleanup();
    localStorage.removeItem('knowlattice-rail-expanded');
  });

  it('目录入口会真实折叠章节卡片，并同步无障碍状态', async () => {
    const { container } = render(<Workspace />);
    const toggle = await screen.findByRole('button', { name: '目录' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.card.c-tree')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.card.c-tree')).toBeNull();
    expect(container.querySelector('.deck')?.classList.contains('with-tree')).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.card.c-tree')).toBeTruthy();
    cleanup();
  });

  it('手机窄屏首次进入直接展示欢迎页，目录保持为可打开的抽屉', async () => {
    localStorage.removeItem('knowlattice-rail-expanded');
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: ['(max-width: 700px)', '(max-width: 980px)', '(max-width: 1040px)'].includes(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { container } = render(<Workspace />);

    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());
    expect(container.querySelector('.card.c-tree')).toBeNull();
    expect(container.querySelector('.deck')?.classList.contains('with-tree')).toBe(false);
    expect(screen.getByRole('button', { name: '目录' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    fireEvent.click(screen.getByRole('button', { name: '目录' }));
    expect(container.querySelector('.card.c-tree')).toBeTruthy();
    const row = [...container.querySelectorAll('.tree-row.file')]
      .find((candidate) => candidate.textContent?.includes('波尔效应'));
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);
    await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), { timeout: 8000 });
    expect(container.querySelector('.card.c-tree')).toBeNull();
    expect(container.querySelector('.card.c-insp')).toBeNull();

    const backlinksToggle = container.querySelector<HTMLButtonElement>('.editor-toolbar button[aria-controls="backlinks-panel"]');
    expect(backlinksToggle?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(backlinksToggle!);
    expect(container.querySelector('.card.c-insp')).toBeTruthy();
    expect(backlinksToggle?.getAttribute('aria-expanded')).toBe('true');
    cleanup();
    vi.unstubAllGlobals();
  }, 20000);

  it('未打开笔记时：目录卡片 + 欢迎页同时可见，目录列出全部笔记', async () => {
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());
    // 回归守卫：欢迎页时目录卡片必须仍然渲染（历史 bug：曾被条件渲染吞掉）
    expect(container.querySelector('.card.c-tree')).toBeTruthy();
    expect(container.querySelector('.welcome-stage')).toBeTruthy();
    await waitFor(() => {
      const rows = [...container.querySelectorAll('.tree-row.file')];
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
    cleanup();
  });

  it('打开笔记：编辑器 + 预览 + 关联面板三卡齐全，回到主页后恢复欢迎页', async () => {
    const { container } = render(<Workspace />);
    await waitFor(() => {
      const rows = [...container.querySelectorAll('.tree-row.file')];
      if (!rows.some((r) => r.textContent?.includes('波尔效应'))) {
        throw new Error('目录尚未列出「波尔效应」');
      }
    });

    const row = [...container.querySelectorAll('.tree-row.file')]
      .find((r) => r.textContent?.includes('波尔效应'));
    expect(row, '目录中应能找到「波尔效应」').toBeTruthy();
    fireEvent.click(row as HTMLElement);

    // Editor/markdown-it 都是懒加载 chunk，等待异步就绪
    await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), { timeout: 8000 });
    await waitFor(() => expect(container.querySelector('.note-path')?.textContent).toContain('波尔效应'));
    // 三卡布局（回归守卫：任何一张卡缺失都是布局回归）
    expect(container.querySelector('.card.c-tree')).toBeTruthy();
    expect(container.querySelector('.card.c-edit')).toBeTruthy();
    expect(container.querySelector('.card.c-insp')).toBeTruthy();
    // 笔记内容进入编辑器（编辑模式下预览由 CodeMirror livePreview 装饰承担，无独立 .preview）
    await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('波尔效应'));

    // 点左上角 logo 回主页
    fireEvent.click(screen.getByLabelText('回到主界面'));
    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());
    cleanup();
  }, 20000);
});
