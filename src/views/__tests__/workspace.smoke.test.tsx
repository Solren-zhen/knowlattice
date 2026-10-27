// @vitest-environment jsdom
/**
 * Workspace 布局冒烟测试（jsdom + fake-indexeddb，不跑真实浏览器）：
 * 守住历史回归——树卡片在未打开笔记时消失、内容不居中、导航轨缺失入口等。
 * 只断言「结构存在 + 关键流程可达」，不测像素。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { openDB } from 'idb';
import Workspace from '../Workspace';
import { RAIL_GROUPS } from '../railCatalog';

/**
 * 入口挂在母主题下：先点母主题浮出该组，再点条目。
 * 已经开着的组不要重复点——母主题是开关，再点一次会把浮层收起来。
 */
function clickEntry(name: string): void {
  const group = RAIL_GROUPS.find((item) => item.entries.some((entry) => entry.label === name));
  if (!group) throw new Error(`rail 里没有这个入口：${name}`);
  const trigger = screen.getByRole('button', { name: group.title });
  // 宽屏看浮层，窄屏看 aria-expanded（原地展开）；已经开着就别再点，母主题是开关
  const already = document.querySelector('.rail-branch')?.getAttribute('aria-label') === group.title
    || trigger.getAttribute('aria-expanded') === 'true';
  if (!already) fireEvent.click(trigger);
  fireEvent.click(screen.getByLabelText(name));
}

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
  afterEach(cleanup);

  it('导航轨只有五个母主题：收起态与展开态装的是同一批东西', async () => {
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByLabelText('回到主界面')).toBeTruthy());
    // 收起来也扫得出软件能干什么：五类母主题，条目指到哪一组就浮在哪一组
    for (const title of ['工作区', '学习', '资料', '工具', '系统']) {
      expect(screen.getByRole('button', { name: title }), `缺少母主题：${title}`).toBeTruthy();
    }
    // 轨道上就这五个母主题：条目只以「当前那一组摊开」的形式出现，不会两态各列一套
    expect(container.querySelectorAll('.rail-group-btn')).toHaveLength(5);
    expect(container.querySelector('.rail-branch')).toBeNull();
  });

  it('导航可展开为文字标签，并记住偏好', async () => {
    localStorage.removeItem('knowlattice-rail-expanded');
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByRole('button', { name: '展开导航标签' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '展开导航标签' }));
    expect(container.querySelector('.rail')?.classList.contains('rail--expanded')).toBe(true);
    // 首页「最近使用」也会出现同名去处，这里限定在导航轨内查
    const rail = container.querySelector('.rail') as HTMLElement;
    expect(within(rail).getByText('工作区')).toBeTruthy();
    expect(within(rail).getByText('学习')).toBeTruthy();
    expect(localStorage.getItem('knowlattice-rail-expanded')).toBe('true');
    cleanup();
    localStorage.removeItem('knowlattice-rail-expanded');
  });

  it('目录入口会真实折叠章节卡片，并同步无障碍状态', async () => {
    const { container } = render(<Workspace />);
    /** 目录挂在「工作区」母主题下，选完浮层就收起来 —— 每次都从母主题重新进 */
    const toggle = async () => {
      // 浮层容器自己也带 aria-label="工作区"，按 label 查会撞车 —— 用 role + name 锁定母按钮
      await waitFor(() => expect(screen.getByRole('button', { name: '工作区' })).toBeTruthy());
      // 手风琴：组可能已经摊开着（默认摊当前组），已开就别点，再点会收起来
      const trigger = screen.getByRole('button', { name: '工作区' });
      if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
      return screen.getByLabelText('目录');
    };

    const first = await toggle();
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.card.c-tree')).toBeTruthy();

    fireEvent.click(first);
    expect(container.querySelector('.card.c-tree')).toBeNull();
    expect(container.querySelector('.deck')?.classList.contains('with-tree')).toBe(false);

    const again = await toggle();
    expect(again.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(again);
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
    expect(screen.getByRole('button', { name: '工作区' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    // 抽屉一打开就把当前所在的「工作区」摊在轨上（手风琴默认摊开当前组），不用再点母主题
    expect(screen.getByLabelText('目录').getAttribute('aria-pressed')).toBe('false');
    clickEntry('目录');
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

  it('医学通路页：点「回到主界面」「目录」和通路按钮本身都能退出工作区', async () => {
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());

    // 进入医学通路工作区（整屏替换三栏布局）：通路是「工作方式」，所以留在一等入口上
    clickEntry('医学通路');
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeTruthy());
    expect(container.querySelector('.deck')).toBeNull();

    // 回归守卫：历史 bug——点「回到主界面」只清了当前笔记，通路工作区纹丝不动
    fireEvent.click(screen.getByLabelText('回到主界面'));
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeNull());
    expect(container.querySelector('.deck')).toBeTruthy();
    expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy();

    // 再进一次：点「目录」（切换开关）也应退出工作区；treeOpen 翻为 false 时目录卡片消失
    const treeWasOpen = container.querySelector('.deck')?.classList.contains('with-tree') ?? false;
    clickEntry('医学通路');
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeTruthy());
    clickEntry('目录');
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeNull());
    expect(container.querySelector('.deck')).toBeTruthy();
    // 切换后目录状态取反（切换开关语义），但三栏布局必须回来
    expect(container.querySelector('.card.c-tree') ? true : false).toBe(!treeWasOpen);

    // 再进一次：通路按钮本身是开关，再点一次即关闭
    clickEntry('医学通路');
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeTruthy());
    clickEntry('医学通路');
    await waitFor(() => expect(container.querySelector('.pathway-builder')).toBeNull());
    cleanup();
  }, 20000);

  it('首页「最近使用」记下最近点过的去处，并落盘', async () => {
    localStorage.removeItem('knowlattice-recent-features');
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());
    // 一条记录都没有：退化成首页默认的那 8 个去处，标题跟着换
    expect(screen.getByText('常用入口')).toBeTruthy();
    expect(container.querySelectorAll('.home-feat')).toHaveLength(8);

    clickEntry('题库练习');
    await waitFor(() => expect(localStorage.getItem('knowlattice-recent-features')).toContain('quiz'));

    fireEvent.click(screen.getByLabelText('回到主界面'));
    await waitFor(() => expect(screen.getByText('最近使用')).toBeTruthy());
    expect(container.querySelector('.home-feat')?.textContent).toContain('题库练习');
    localStorage.removeItem('knowlattice-recent-features');
    cleanup();
  }, 20000);

  /**
   * 回归守卫：全屏面板互斥。
   * 每个面板自带一层 fixed inset:0 的遮罩，两个同时打开时后渲染的盖住前面的——
   * 表现是「点了新入口没反应」或「关掉题库，冒出个错题本」。入口切换时应当先关掉其余面板。
   */
  it('全屏面板互斥：换一个入口时，上一个自动关掉', async () => {
    localStorage.removeItem('knowlattice-recent-features');
    const { container } = render(<Workspace />);
    await waitFor(() => expect(screen.getByText('你的知识库，从这里开始')).toBeTruthy());

    clickEntry('题库练习');
    await waitFor(() => expect(container.querySelectorAll('.panel-backdrop')).toHaveLength(1), { timeout: 8000 });

    // 不关题库直接点错题本：遮罩必须仍然只有一层
    clickEntry('错题本');
    await waitFor(() => expect(container.querySelector('.mistake-book, .panel-backdrop')).toBeTruthy());
    expect(container.querySelectorAll('.panel-backdrop')).toHaveLength(1);

    // 再切到间隔复习：同样只有一层
    clickEntry('间隔复习');
    await waitFor(() => expect(container.querySelectorAll('.panel-backdrop')).toHaveLength(1), { timeout: 8000 });

    cleanup();
    localStorage.removeItem('knowlattice-recent-features');
  }, 20000);
});
