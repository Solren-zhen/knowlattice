// @vitest-environment jsdom
/**
 * 笔记上的「题目批注」条：题库里写的选项批注必须真的出现在对应章节的笔记上。
 *
 * core/qbankAnnotations 的筛选逻辑已单测过；这里守的是接线：
 * 组件读不读题库、"不对应章节的笔记"会不会连空壳都不渲染、有没有一条批注就显示一条。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import ChapterAnnotations from '../ChapterAnnotations';
import { putBank, removeBankAndStats } from '../../storage/qbank';

const BANK = '批注测试库';
const CHAPTER = '生理学·细胞的基本功能';
const NOTE = '题库/绿皮书/生理学/细胞的基本功能.md';

function seed() {
  return putBank({
    name: BANK,
    importedAt: Date.now(),
    questions: [
      {
        id: 'a1',
        type: 'choice',
        stem: '关于静息电位，下列正确的是',
        options: ['甲', '乙'],
        answer: 1,
        answerText: 'B',
        chapter: CHAPTER,
        optionNotes: ['', '因为钾外流'],
      },
      {
        id: 'a2',
        type: 'choice',
        stem: '另一章的题',
        options: ['甲', '乙'],
        answer: 0,
        answerText: 'A',
        chapter: '生理学·血液',
        optionNotes: ['这条不该出现在细胞那一章'],
      },
    ],
  });
}

afterEach(async () => {
  cleanup();
  await removeBankAndStats(BANK);
});

describe('题目批注条', () => {
  it('对应章节的笔记上显示批注（带选项字母与题库名）', async () => {
    await seed();
    render(<ChapterAnnotations path={NOTE} />);
    await waitFor(() => expect(screen.getByText('题目批注 · 1 条')).toBeTruthy());
    expect(screen.getByText('因为钾外流')).toBeTruthy();
    expect(screen.getByText(BANK)).toBeTruthy();
    // 别的章节的批注不能混进来
    expect(screen.queryByText('这条不该出现在细胞那一章')).toBeNull();
  });

  it('不是题库章节笔记时一条都不渲染（不留空壳）', async () => {
    await seed();
    const { container } = render(<ChapterAnnotations path="日常/随手记.md" />);
    // 等一轮，确认不是「延迟加载后才有」的错觉
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('.note-anno')).toBeNull();
  });
});
