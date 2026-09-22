// @vitest-environment jsdom
/**
 * 自动组题的 DOM 验收（错题加权 + FSRS 逐题排程的用户可见部分）。
 *
 * 守四件事：
 *  ① 组题弹窗把「候选多少题 / 将抽多少题」实时算给用户看——范围与章节一改就能看到，
 *     否则「做错过 + 某章」这种组合抽不到题时，用户只会以为按钮坏了；
 *  ② 题量真的生效（选了 10 就只出 10 题），不是又退回整库洗牌；
 *  ③ 章节筛选真的在过滤；
 *  ④ 作答会落盘成**逐题**历史（错题加权与 FSRS 排程的唯一数据源），
 *     并同步反映到题库列表的进度行上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import QuizView from '../QuizView';
import type { QuizQuestion } from '../../core/qbank';

const BANK = '绿皮书·生理学';
const CH1 = '生理学·第1章 绪论';
const CH2 = '生理学·第2章 细胞的基本功能';
const NOTE1 = '题库/绿皮书/生理学/第1章 绪论.md';
const NOTE2 = '题库/绿皮书/生理学/第2章 细胞的基本功能.md';

// 两章的选项文本必须一致：组题是加权随机，第一题来自哪一章不固定，
// 而「点第二个选项 = 答错」这条操作要能对任意一题成立。
const OPTIONS = ['容易放氧', '容易结合氧'];

const QUESTIONS: QuizQuestion[] = [
  ...Array.from({ length: 8 }, (_, i): QuizQuestion => ({
    id: `q1-${i}`, type: 'choice', stem: `绪论第 ${i} 题`, options: OPTIONS,
    answer: 0, answerText: OPTIONS[0], chapter: CH1,
  })),
  ...Array.from({ length: 4 }, (_, i): QuizQuestion => ({
    id: `q2-${i}`, type: 'choice', stem: `细胞第 ${i} 题`, options: OPTIONS,
    answer: 0, answerText: OPTIONS[0], chapter: CH2,
  })),
];

/** 两章都要有对应笔记：组题用的是加权随机，抽到哪道题不固定。
 *  少给一章的笔记，断言就会依赖「第一题恰好来自哪一章」而随机挂掉。 */
const DOCS = new Map<string, string>([
  [NOTE1, '# 第1章 绪论\n\n- 定义: 氧解离曲线描述血红蛋白与氧的结合能力\n'],
  [NOTE2, '# 第2章 细胞的基本功能\n\n- 定义: 静息电位是细胞未受刺激时的膜电位\n'],
]);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('knowlattice-qbanks', JSON.stringify([
    { name: BANK, importedAt: Date.now(), questions: QUESTIONS },
  ]));
});

afterEach(cleanup);

function setup() {
  return render(
    <QuizView docs={DOCS} resolveLink={() => null} onOpenPath={vi.fn()} onClose={vi.fn()} />
  );
}

/** 打开某个题库的组题弹窗 */
function openCompose() {
  fireEvent.click(screen.getByRole('button', { name: '组题' }));
}
const chip = (name: string) => screen.getByRole('button', { name });
const text = (c: HTMLElement) => c.textContent ?? '';

describe('自动组题 · 弹窗', () => {
  it('实时显示候选与将抽题量，题量选择真的生效', () => {
    const { container } = setup();
    openCompose();

    // 默认 20 题 > 题库 12 题 → 只能给 12
    expect(text(container)).toContain('本轮将抽 12 题');
    expect(text(container)).toContain('候选 12 题');

    fireEvent.click(chip('10'));
    expect(text(container)).toContain('本轮将抽 10 题');

    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    expect(text(container)).toContain(`第 1 / 10 题`);
    expect(text(container)).not.toContain('组题 · '); // 弹窗已关
  });

  it('章节筛选真的在过滤，且候选数随之变化', () => {
    const { container } = setup();
    openCompose();
    expect(text(container)).toContain('候选 12 题');

    // 勾第 2 章（4 题）
    fireEvent.click(screen.getByText(CH2));
    expect(text(container)).toContain('候选 4 题');
    expect(text(container)).toContain('本轮将抽 4 题');

    // 再勾第 1 章 → 又回到 12
    fireEvent.click(screen.getByText(CH1));
    expect(text(container)).toContain('候选 12 题');
  });

  it('候选为 0 时禁用「开始练习」，而不是让用户点了没反应', () => {
    const { container } = setup();
    openCompose();
    // 没做过任何题 → 「做错过」必然是空池
    fireEvent.click(chip('做错过'));
    expect(text(container)).toContain('候选 0 题');
    // 没装 jest-dom，直接读原生属性
    expect((screen.getByRole('button', { name: '开始练习' }) as HTMLButtonElement).disabled).toBe(true);
  });});

describe('自动组题 · 作答落盘', () => {
  it('答错一题：逐题历史与错题本都写了，题库列表的进度行跟着更新', () => {
    setup();
    openCompose();
    fireEvent.click(chip('10'));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    // 正确答案是第 1 个选项，这里点第 2 个 → 答错
    fireEvent.click(screen.getByRole('button', { name: /容易结合氧/ }));

    const raw = localStorage.getItem('knowlattice-qstats');
    expect(raw).toBeTruthy();
    const stats = JSON.parse(raw!) as Record<string, Record<string, number[]>>;
    expect(Object.keys(stats[BANK])).toHaveLength(1);
    // 紧凑数组，不是对象（存储体积的设计前提）
    expect(Array.isArray(Object.values(stats[BANK])[0])).toBe(true);

    // 答错且能关联到笔记 → 错题本也要有
    expect(localStorage.getItem('knowlattice-mistakes')).toBeTruthy();

    // 重开面板：进度行应显示做过 1 / 错过 1
    cleanup();
    const again = setup();
    expect(text(again.container)).toContain('做过 1');
    expect(text(again.container)).toContain('错过 1');

    // 「没做过」范围少了一题；刚答错的题按 FSRS 排到了将来，所以「今日待复习」仍为 0
    openCompose();
    fireEvent.click(chip('没做过'));
    expect(text(again.container)).toContain('候选 11 题');
    fireEvent.click(chip('今日待复习'));
    expect(text(again.container)).toContain('候选 0 题');
  });
});
