// @vitest-environment jsdom
/**
 * 番茄工作台的 DOM 测试：模块切换、计时（用假时钟走真实时间线）、番茄与待办联动、
 * 统计页数字、关掉面板后重开的补记。计时逻辑本身的单测在 core/__tests__/pomodoro.test.ts。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodoView from '../TodoView';
import { dayKey } from '../../core/todos';

const DOCS = new Map<string, string>([['内科学/呼吸系统.md', '# 呼吸系统\n\n氧解离曲线。\n']]);
const T0 = Date.parse('2026-09-21T10:00:00');
const MIN = 60_000;

function renderView() {
  const props = { onClose: vi.fn(), docs: DOCS, onOpenPath: vi.fn(), onSaveNote: vi.fn() };
  return { ...render(<TodoView {...props} />), props };
}

function seedTodo(over: Record<string, unknown> = {}) {
  const t = { id: 't-1', text: '复习呼吸', done: false, createdAt: 1, ...over };
  localStorage.setItem('knowlattice-todos', JSON.stringify([t]));
  return t;
}

const todos = (): Array<Record<string, unknown>> => JSON.parse(localStorage.getItem('knowlattice-todos') ?? '[]');
const records = (): Array<Record<string, unknown>> => JSON.parse(localStorage.getItem('knowlattice-pomodoros') ?? '[]');
const composer = () => screen.getByPlaceholderText(/加一条/) as HTMLInputElement;
const foot = () => document.querySelector('.todo-foot') as HTMLElement;
const chip = () => document.querySelector('.wb-chip') as HTMLElement;
/**
 * 标签页按钮。不能全局按名字取：「专注」这个词在待办行上也有一份（行上的一键去专注），
 * 全局取必然撞重复——先定位标签栏，再在里面查。
 */
const tab = (label: string) =>
  within(document.querySelector('.wb-tabs') as HTMLElement).getByRole('button', { name: new RegExp(`^${label}$`) });

/**
 * 把系统时间往前推 ms，再让定时器走一步（只跑一次回调，测试不用等几百次渲染）。
 * 假时钟下不要用 waitFor：它自己靠真实定时器轮询，会一直等到超时——状态在 act 里已经同步刷完了。
 */
function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
  act(() => { vi.advanceTimersByTime(500); });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.querySelectorAll('.mv-confirm-toast, .mv-confirm-overlay').forEach((n) => n.remove());
});

describe('工作台外壳', () => {
  it('默认在「待办」页，三个模块都能切', () => {
    renderView();
    expect(screen.getByRole('dialog', { name: '工作台' }).getAttribute('aria-modal')).toBe('true');
    // 默认落在待办页：原来的面板功能一个不少
    expect(screen.getByPlaceholderText(/加一条/)).toBeTruthy();
    expect(tab('专注')).toBeTruthy();
    expect(tab('统计')).toBeTruthy();
    expect(tab('待办').getAttribute('aria-current')).toBe('page');

    fireEvent.click(tab('专注'));
    expect(screen.getByText('开始专注')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/加一条/)).toBeNull(); // 待办页的内容收起来了

    fireEvent.click(tab('统计'));
    expect(screen.getByText('近 7 天专注趋势')).toBeTruthy();
    expect(screen.getByText('待办完成率')).toBeTruthy();
  });

  it('模块选择会被记住（重开还是那一页）', () => {
    const first = renderView();
    fireEvent.click(tab('专注'));
    expect(localStorage.getItem('knowlattice-todo-module')).toBe('focus');
    first.unmount();

    renderView();
    expect(screen.getByText('开始专注')).toBeTruthy();
  });

  it('计时条常驻：切到待办页也看得到剩余时间', () => {
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.click(screen.getByText('开始专注'));
    expect(chip().textContent).toContain('25:00');
    expect(chip().getAttribute('aria-label')).toContain('点击暂停');

    fireEvent.click(tab('待办'));
    expect(screen.getByPlaceholderText(/加一条/)).toBeTruthy(); // 回到待办
    expect(chip().textContent).toContain('25:00');              // 计时还在
    advance(10 * MIN);
    expect(chip().textContent).toContain('15:00');              // 而且在走
  });
});

describe('专注页计时', () => {
  it('开始 → 暂停 → 继续，暂停的时间不算进专注', () => {
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.click(screen.getByText('开始专注'));

    advance(5 * MIN);
    expect(screen.getByLabelText(/专注剩余/).getAttribute('aria-label')).toContain('20:00');

    fireEvent.click(screen.getByText('暂停'));
    advance(30 * MIN); // 暂停期间什么都不该发生
    expect(screen.getByLabelText(/专注剩余/).getAttribute('aria-label')).toContain('20:00');

    fireEvent.click(screen.getByText('继续'));
    advance(20 * MIN);
    expect(records()).toHaveLength(1); // 20 分钟跑完正好到点
  });

  it('跳过专注不记番茄', () => {
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.click(screen.getByText('开始专注'));
    advance(MIN);
    fireEvent.click(screen.getByText('跳过'));
    expect(records()).toHaveLength(0);
    expect(screen.getByLabelText(/短休息剩余/).getAttribute('aria-label')).toContain('05:00');
  });

  it('专注页的快捷键：空格 开始/暂停、S 跳过（不会顺手勾选待办）', () => {
    seedTodo();
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.keyDown(window, { key: ' ' });
    expect(chip().getAttribute('aria-label')).toContain('点击暂停');

    fireEvent.keyDown(window, { key: ' ' });
    expect(chip().getAttribute('aria-label')).toContain('点击开始');

    fireEvent.keyDown(window, { key: 's' });
    expect(screen.getByLabelText(/短休息剩余/)).toBeTruthy();
    expect(todos()[0].done).toBe(false); // 空格没被待办那套快捷键吃掉
  });
});

describe('番茄与待办联动', () => {
  it('行上的「专注」把这条设为本次专注对象并切到专注页', () => {
    seedTodo();
    renderView();
    fireEvent.click(within(document.querySelector('.todo-item') as HTMLElement).getByText('专注'));
    const select = screen.getByLabelText('关联待办') as HTMLSelectElement;
    expect(select.value).toBe('t-1');
  });

  it('完成一个番茄：记录落库 + 关联待办 +1 + 行上出现番茄数', () => {
    seedTodo();
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.change(screen.getByLabelText('关联待办'), { target: { value: 't-1' } });
    fireEvent.click(screen.getByText('开始专注'));
    advance(25 * MIN);

    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ minutes: 25, taskId: 't-1', day: dayKey(new Date(T0)) });
    expect(todos()[0].pomos).toBe(1);
    // 到点自动进入短休息
    expect(screen.getByLabelText(/短休息剩余/).getAttribute('aria-label')).toContain('05:00');

    fireEvent.click(tab('待办'));
    expect(screen.getByLabelText('已投入 1 个番茄')).toBeTruthy();
  });

  it('没关联待办时只记番茄，不动任何待办', () => {
    seedTodo();
    renderView();
    fireEvent.click(tab('专注'));
    fireEvent.click(screen.getByText('开始专注'));
    advance(25 * MIN);
    expect(records()).toHaveLength(1);
    expect(records()[0].taskId).toBeUndefined();
    expect(todos()[0].pomos).toBeUndefined();
  });

  it('面板关着的时候到点了，重开按真实时间补记（时间点算真正跑完那刻）', () => {
    localStorage.setItem('knowlattice-pomodoro', JSON.stringify({
      phase: 'focus', running: true, startedAt: T0 - 26 * MIN, elapsedMs: 0, focusDone: 0, taskId: 't-1',
    }));
    seedTodo();
    renderView();
    advance(0); // 让引擎的「开面板先对一次表」那一步跑起来
    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ minutes: 25, taskId: 't-1', endedAt: T0 - MIN });
    expect(todos()[0].pomos).toBe(1);
    // 已经进入下一阶段，而不是卡在到点的专注上
    expect(chip().textContent).toContain('短休息');
  });
});

describe('底部短语法说明', () => {
  it('四个符号各有含义和示例', () => {
    renderView();
    for (const [sign, desc] of [['@', '日期'], ['!', '优先级'], ['#', '关联笔记'], ['*', '重复']]) {
      const item = within(foot()).getByText(desc).closest('.todo-foot__item') as HTMLElement;
      expect(within(item).getByText(sign)).toBeTruthy();
    }
    expect(foot().textContent).toContain('没认出来的词原样留在正文里');
  });

  it('点一下示例就插进输入框（追加式，末尾补空格）', () => {
    renderView();
    fireEvent.click(within(foot()).getByText('@明天'));
    expect(composer().value).toBe('@明天 ');
    fireEvent.click(within(foot()).getByText('!高'));
    expect(composer().value).toBe('@明天 !高 ');
    // 插进去的就是真语法：预览认出来了
    fireEvent.click(within(foot()).getByText('*每周'));
    expect(document.querySelector('.todo-chips')!.textContent).toContain('每周');
  });

  it('不再占地方列快捷键（那块地方改成解释短语法了）', () => {
    renderView();
    expect(foot().textContent).not.toContain('快捷键');
    expect(foot().querySelector('kbd')).toBeNull();
  });
});

describe('统计页', () => {
  it('番茄总览、趋势、完成率、热力图都按真实数据画', () => {
    const today = dayKey(new Date(T0));
    const yesterday = dayKey(new Date(T0 - 24 * 60 * MIN));
    localStorage.setItem('knowlattice-pomodoros', JSON.stringify([
      { id: 'p-1', day: today, endedAt: T0, minutes: 25 },
      { id: 'p-2', day: today, endedAt: T0, minutes: 25 },
      { id: 'p-3', day: yesterday, endedAt: T0 - 24 * 60 * MIN, minutes: 15 },
    ]));
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 'a', text: '做完的', done: true, createdAt: 1 },
      { id: 'b', text: '没做完的', done: false, createdAt: 2 },
    ]));
    renderView();
    fireEvent.click(tab('统计'));

    const stats = document.querySelector('.wb-cards') as HTMLElement;
    expect(stats.textContent).toContain('今日番茄2');
    expect(stats.textContent).toContain('今日专注50');
    expect(stats.textContent).toContain('累计番茄3');
    expect(stats.textContent).toContain('累计专注65');
    expect(screen.getByText('50%')).toBeTruthy();          // 1/2 完成率
    expect(document.querySelectorAll('.wb-heat__col')).toHaveLength(12);
    expect(document.querySelectorAll('.wb-heat__col .wb-heat__cell')).toHaveLength(84);
    // 今天的柱子有 2 个番茄
    expect((document.querySelector('.wb-trend__item:last-child') as HTMLElement).title).toContain('2 个番茄');
  });
});
