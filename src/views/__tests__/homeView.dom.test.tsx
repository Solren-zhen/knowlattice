// @vitest-environment jsdom
/**
 * 知识首页（最近使用）的契约：
 *   - 首页不复述功能清单：只摆调用方给的最近使用项，标题随调用方变；
 *   - 点条目调用 onFeature 并回传 RailKey，不是只做一个好看的图标；
 *   - 「继续」区只放最近笔记、没练完的那轮题库与到期/错题提示，空库时给出去处；
 *   - 搜索是首屏主入口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HomeView, { type HomeFeature } from '../HomeView';

const FEATURES: HomeFeature[] = [
  { key: 'tree', label: '目录', icon: null },
  { key: 'quiz', label: '题库练习', icon: null },
  { key: 'review', label: '间隔复习', icon: null },
];

function renderHome(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  const props = {
    features: FEATURES,
    featuresTitle: '最近使用',
    recents: [],
    dueCount: 0,
    mistakeCount: 0,
    quizResume: null,
    onFeature: vi.fn(),
    onOpenRecent: vi.fn(),
    onReview: vi.fn(),
    onMistake: vi.fn(),
    onResumeQuiz: vi.fn(),
    onSearch: vi.fn(),
    ...overrides,
  };
  return { ...render(<HomeView {...props} />), props };
}

afterEach(cleanup);

describe('知识首页 · 最近使用', () => {
  it('只渲染调用方给的那几项，标题跟着走', () => {
    const { container } = renderHome();
    expect(container.querySelectorAll('.home-feat')).toHaveLength(FEATURES.length);
    expect(screen.getByText('最近使用')).toBeTruthy();
    for (const label of ['目录', '题库练习', '间隔复习']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    }
    // 旧的「学习 / 资料 / 工具」功能地图不能再回来
    expect(container.querySelector('.home-groups')).toBeNull();
  });

  it('没有使用记录时标题换成常用入口（同一个列表）', () => {
    const { container } = renderHome({ featuresTitle: '常用入口' });
    expect(screen.getByText('常用入口')).toBeTruthy();
    expect(container.querySelectorAll('.home-feat')).toHaveLength(FEATURES.length);
  });

  it('点条目把键回传给 onFeature（不是只占位）', () => {
    const { props } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: /题库练习/ }));
    expect(props.onFeature).toHaveBeenCalledWith('quiz');
    fireEvent.click(screen.getByRole('button', { name: /间隔复习/ }));
    expect(props.onFeature).toHaveBeenLastCalledWith('review');
  });

  it('「继续」只显示最近笔记，点击打开；空库时给出可执行的去处', () => {
    const { props } = renderHome({ recents: [{ path: '解剖/心脏.md', title: '心脏' }] });
    fireEvent.click(screen.getByRole('button', { name: /心脏/ }));
    expect(props.onOpenRecent).toHaveBeenCalledWith('解剖/心脏.md');

    cleanup();
    renderHome();
    expect(screen.getByText(/还没有打开过笔记/)).toBeTruthy();
  });

  it('到期卡与错题数 > 0 时给出一键入口', () => {
    const { props } = renderHome({ dueCount: 4, mistakeCount: 2 });
    fireEvent.click(screen.getByRole('button', { name: '待复习 4 张' }));
    expect(props.onReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '未清错题 2 道' }));
    expect(props.onMistake).toHaveBeenCalledOnce();
  });

  it('没练完的那一轮在「继续」区给出续做入口', () => {
    const { props } = renderHome({ quizResume: { bank: '生理学', position: 4, total: 20 } });
    const chip = screen.getByRole('button', { name: /继续刷题 生理学 第 4\/20 题/ });
    fireEvent.click(chip);
    expect(props.onResumeQuiz).toHaveBeenCalledOnce();
  });

  it('没有可续的一轮就不出这个入口（只有计数 chip 时不冒充）', () => {
    renderHome({ dueCount: 3 });
    expect(screen.queryByRole('button', { name: /继续刷题/ })).toBeNull();
    expect(screen.getByRole('button', { name: '待复习 3 张' })).toBeTruthy();
  });

  it('搜索是首屏主入口', () => {
    const { props } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: /搜索/ }));
    expect(props.onSearch).toHaveBeenCalledOnce();
  });
});
