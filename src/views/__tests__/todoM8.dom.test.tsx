// @vitest-environment jsdom
/**
 * 待办清单的 DOM 测试：短语法、行内编辑、键盘操作、过滤持久化、重复任务，
 * 以及 M9 的整页三栏（智能列表 / 批量 / 撤销 / 笔记里的任务）。
 * 纯逻辑（解析/分组/排序/统计）在 core/__tests__/todos.test.ts 与 noteTasks.test.ts 已有单测，这里只验接线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TodoView from '../TodoView';
import { addDays, dayKey } from '../../core/todos';

const DOCS = new Map<string, string>([
  ['内科学/呼吸系统.md', '# 呼吸系统\n\n氧解离曲线。\n'],
  ['内科学/循环系统.md', '# 循环系统\n\n心电传导。\n'],
]);

function renderView(docs: Map<string, string> = DOCS) {
  const props = { onClose: vi.fn(), docs, onOpenPath: vi.fn(), onSaveNote: vi.fn() };
  return { ...render(<TodoView {...props} />), props };
}

/**
 * 按行取元素。行内的 aria-label（标记为完成 / 删除这条待办 / 勾选笔记任务…）**每行都有一份**，
 * 多行时全局取必然撞重复——所以一律先定位行，再在行内查。
 */
const rowOf = (text: string) => screen.getByText(text).closest('.todo-item') as HTMLElement;
const inRow = (text: string, label: string) => within(rowOf(text)).getByLabelText(label);

const todos = (): Array<Record<string, unknown>> => JSON.parse(localStorage.getItem('knowlattice-todos') ?? '[]');
const composer = () => screen.getByPlaceholderText(/加一条/) as HTMLInputElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  document.querySelectorAll('.mv-confirm-overlay').forEach((n) => n.remove());
});

describe('短语法快速添加', () => {
  it('边打边显示解析结果，回车后写进待办（正文已剥掉标记）', async () => {
    renderView();
    fireEvent.change(composer(), { target: { value: '复习呼吸 @明天 !高 #呼吸系统 *每天' } });

    // 预览：认出来的标记单独显示，正文里不再有它们
    // （按容器取文本：下面的语法提示里也有 @明天 / *每天 这些字）
    const chips = document.querySelector('.todo-chips') as HTMLElement;
    expect(chips.textContent).toContain('@明天');
    expect(chips.textContent).toContain('!高');
    expect(chips.textContent).toContain('*每天');
    expect(chips.textContent).toContain('正文：复习呼吸');

    fireEvent.keyDown(composer(), { key: 'Enter' });

    await waitFor(() => expect(todos()).toHaveLength(1));
    const t = todos()[0];
    expect(t.text).toBe('复习呼吸');
    expect(t.priority).toBe(1);
    expect(t.repeat).toBe('daily');
    expect(t.note).toBe('内科学/呼吸系统.md');
    expect(String(t.due)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 输入框已清空，界面上出现徽标
    expect(composer().value).toBe('');
    expect(screen.getByText('优先级 高')).toBeTruthy();
    expect(screen.getByText('每天')).toBeTruthy();
  });

  it('认不出的词留在正文里，不会被吃掉', async () => {
    renderView();
    fireEvent.change(composer(), { target: { value: '看 @下辈子 的书' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(todos()).toHaveLength(1));
    expect(todos()[0].text).toBe('看 @下辈子 的书');
    expect(todos()[0].due).toBeUndefined();
  });

  it('空输入不添加（只有标记没有正文也不行）', () => {
    renderView();
    fireEvent.change(composer(), { target: { value: '  @明天  ' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(todos()).toEqual([]);
  });
});

describe('行内编辑（TodoMVC 语义）', () => {
  beforeEach(() => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'a', text: '原始文本', done: false, createdAt: 1 }]));
  });

  it('双击进入编辑，回车保存', async () => {
    renderView();
    fireEvent.doubleClick(screen.getByText('原始文本'));
    const input = document.querySelector('.todo-edit') as HTMLInputElement;
    expect(input.value).toBe('原始文本');
    fireEvent.change(input, { target: { value: '  改过的  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(todos()[0].text).toBe('改过的'));
  });

  it('Esc 丢弃修改', async () => {
    renderView();
    fireEvent.doubleClick(screen.getByText('原始文本'));
    const input = document.querySelector('.todo-edit') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '不要这个' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.todo-edit')).toBeNull());
    expect(todos()[0].text).toBe('原始文本');
    expect(screen.getByText('原始文本')).toBeTruthy();
  });

  it('清空内容即删除该条', async () => {
    renderView();
    fireEvent.doubleClick(screen.getByText('原始文本'));
    const input = document.querySelector('.todo-edit') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(todos()).toEqual([]));
  });
});

describe('键盘操作与过滤', () => {
  beforeEach(() => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '第一条', done: false, createdAt: 1 },
      { id: 'b', text: '第二条', done: false, createdAt: 2 },
    ]));
  });

  it('点选后用 x 勾完成，再按 x 取消', async () => {
    renderView();
    fireEvent.click(screen.getByText('第一条'));
    fireEvent.keyDown(window, { key: 'x' });
    await waitFor(() => expect(todos().find((t) => t.id === 'a')?.done).toBe(true));
    fireEvent.keyDown(window, { key: 'x' });
    await waitFor(() => expect(todos().find((t) => t.id === 'a')?.done).toBe(false));
  });

  it('↑↓ 在列表里移动选择，Delete 删除选中项', async () => {
    renderView();
    // 手动排序默认新的在上：第二条（createdAt 2）在第一条之前
    fireEvent.click(screen.getByText('第二条'));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(document.querySelectorAll('.todo-item.sel')).toHaveLength(1));
    expect((document.querySelector('.todo-item.sel') as HTMLElement).textContent).toContain('第一条');
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(todos().map((t) => t.id)).toEqual(['b']));
  });

  it('n 聚焦新增输入框', async () => {
    renderView();
    (composer() as HTMLInputElement).blur();
    fireEvent.keyDown(window, { key: 'n' });
    expect(document.activeElement).toBe(composer());
  });

  it('过滤状态写进 localStorage（刷新后还在）', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: '已完成 0' }));
    expect(localStorage.getItem('knowlattice-todo-filter')).toBe('done');
    await waitFor(() => expect(screen.getByText('还没有已完成的待办')).toBeTruthy());
  });

  it('全部完成按钮一次勾完，再点一次全部取消', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: '全部完成' }));
    await waitFor(() => expect(todos().every((t) => t.done)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '全部取消完成' }));
    await waitFor(() => expect(todos().every((t) => !t.done)).toBe(true));
  });
});

describe('详情面板：到期日 / 关联笔记 / 子任务 / 重复', () => {
  it('设置重复后勾完成，自动顺延生成下一条', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'a', text: '每天背单词', done: false, createdAt: 1 }]));
    renderView();
    fireEvent.click(screen.getByText('详情'));
    const select = document.querySelector('.todo-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'daily' } });
    await waitFor(() => expect(todos()[0].repeat).toBe('daily'));

    fireEvent.click(screen.getByRole('button', { name: '标记为完成' }));
    await waitFor(() => expect(todos()).toHaveLength(2));
    const fresh = todos().find((t) => t.id !== 'a')!;
    expect(fresh.done).toBe(false);
    expect(fresh.due).toBeTruthy();
  });

  it('加子任务、勾子任务、删子任务', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'a', text: '复习', done: false, createdAt: 1 }]));
    renderView();
    fireEvent.click(screen.getByText('详情'));
    const subInput = screen.getByPlaceholderText(/拆一步/);
    fireEvent.change(subInput, { target: { value: '先看心电图' } });
    fireEvent.keyDown(subInput, { key: 'Enter' });
    await waitFor(() => expect(todos()[0].subtasks).toHaveLength(1));
    expect(screen.getByText('子任务 0/1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '标记子任务完成' }));
    await waitFor(() => expect(screen.getByText('子任务 1/1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '删除子任务' }));
    await waitFor(() => expect(todos()[0].subtasks).toEqual([]));
  });

  it('关联笔记徽标点击后打开那篇笔记', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '复习', done: false, createdAt: 1, note: '内科学/呼吸系统.md' },
    ]));
    const { props } = renderView();
    // 左栏「按笔记」分组里也会出现同一个笔记名，所以按徽标的类取，不按文字取（否则命中两个元素）
    fireEvent.click(document.querySelector('.todo-note-badge') as HTMLElement);
    expect(props.onOpenPath).toHaveBeenCalledWith('内科学/呼吸系统.md');
  });

  it('搜索命中子任务与关联笔记', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '复习', done: false, createdAt: 1, note: '内科学/呼吸系统.md', subtasks: [{ id: 's', text: '氧解离曲线', done: false }] },
      { id: 'b', text: '别的', done: false, createdAt: 2 },
    ]));
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/搜索待办/), { target: { value: '氧解离' } });
    await waitFor(() => expect(screen.getByText('复习')).toBeTruthy());
    expect(screen.queryByText('别的')).toBeNull();
  });
});

describe('M9 整页三栏：智能列表 / 批量 / 撤销 / 笔记任务', () => {
  it('左栏智能列表带计数，点一下切列表', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '今天做', done: false, createdAt: 3, due: dayKey() },
      { id: 'b', text: '以后做', done: false, createdAt: 2, due: addDays(dayKey(), 5) },
      { id: 'c', text: '已做完', done: true, createdAt: 1, completedAt: Date.now() },
    ]));
    renderView();
    expect(screen.getByText('今天做')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '已完成 1' }));
    await waitFor(() => expect(screen.getByText('已做完')).toBeTruthy());
    expect(screen.queryByText('今天做')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '已逾期 0' }));
    await waitFor(() => expect(screen.getByText('没有逾期的事，很好')).toBeTruthy());
  });

  it('Ctrl+点击多选，批量条一次勾完', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '甲', done: false, createdAt: 2 },
      { id: 'b', text: '乙', done: false, createdAt: 1 },
    ]));
    renderView();
    fireEvent.click(screen.getByText('甲'), { ctrlKey: true });
    fireEvent.click(screen.getByText('乙'), { ctrlKey: true });
    await waitFor(() => expect(screen.getByText('已选 2 项')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await waitFor(() => expect(todos().every((t) => t.done)).toBe(true));
  });

  it('删除后可撤销（整份列表原样放回）', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'a', text: '别删我', done: false, createdAt: 1 }]));
    renderView();
    fireEvent.click(inRow('别删我', '删除这条待办'));
    await waitFor(() => expect(todos()).toEqual([]));

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(todos()).toHaveLength(1));
    expect(todos()[0].text).toBe('别删我');
  });

  it('笔记里的 `- [ ]` 任务：勾选写回源文件并补 ✅ 日期', async () => {
    const docs = new Map<string, string>([
      ['内科学/呼吸系统.md', '# 呼吸系统\n\n- [ ] 背氧解离曲线 📅 2026-09-25 ⏫\n- [x] 看心电图\n'],
    ]);
    const { props } = renderView(docs);
    fireEvent.click(screen.getByRole('button', { name: '待勾选 1' }));
    await waitFor(() => expect(screen.getByText('背氧解离曲线')).toBeTruthy());
    // 勾过的也列在下面（点错了还能取消）
    expect(screen.getByText('看心电图')).toBeTruthy();

    fireEvent.click(inRow('背氧解离曲线', '勾选笔记任务'));
    await waitFor(() => expect(props.onSaveNote).toHaveBeenCalledTimes(1));
    const [path, content] = props.onSaveNote.mock.calls[0] as [string, string];
    expect(path).toBe('内科学/呼吸系统.md');
    expect(content).toContain(`- [x] 背氧解离曲线 📅 2026-09-25 ⏫ ✅ ${dayKey()}`);
    expect(content).toContain('- [x] 看心电图'); // 别的行一个字都不许动
  });

  it('没选中时右栏是统计：近 7 天 + 连续完成天数', () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '今天做完了', done: true, createdAt: 1, completedAt: Date.now() },
      { id: 'b', text: '昨天也做了', done: true, createdAt: 2, completedAt: Date.now() - 86400000 },
    ]));
    renderView();
    expect(screen.getByText('近 7 天完成')).toBeTruthy();
    expect(screen.getByText('连续完成')).toBeTruthy();
    expect(screen.getByText('2 天')).toBeTruthy();
  });

  it('优先级快捷键 1/2/3 与 0（清除）', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'a', text: '定级', done: false, createdAt: 1 }]));
    renderView();
    fireEvent.click(screen.getByText('定级'));
    fireEvent.keyDown(document.body, { key: '1' });
    await waitFor(() => expect(todos()[0].priority).toBe(1));

    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(todos()[0].priority).toBe(3));

    fireEvent.keyDown(document.body, { key: '0' });
    await waitFor(() => expect(todos()[0].priority).toBeUndefined());
  });

  it('左栏按笔记分组能只看一篇，chip 可清除', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '呼吸的活', done: false, createdAt: 2, note: '内科学/呼吸系统.md' },
      { id: 'b', text: '循环的活', done: false, createdAt: 1, note: '内科学/循环系统.md' },
    ]));
    renderView();
    fireEvent.click(screen.getByRole('button', { name: '呼吸系统 1' }));
    await waitFor(() => expect(screen.queryByText('循环的活')).toBeNull());
    expect(screen.getByText('呼吸的活')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('清除笔记筛选'));
    await waitFor(() => expect(screen.getByText('循环的活')).toBeTruthy());
  });
});
