/**
 * 题目批注索引：题库里的选项批注 ⇄ 章节笔记路径。
 *
 * 守两件事：① 只把「真写了字」的批注收进来（空批注会在笔记里变成一堆空行）；
 * ② 路径不是「题库/<源>/<学科>/<章节>.md」就一条都不给——否则随便点开一篇笔记
 *    都会冒出别的章节的批注，那比看不到更糟。
 */
import { describe, expect, it } from 'vitest';
import { annotationsForPath, collectAnnotations, type QuestionAnnotation } from '../qbankAnnotations';
import type { QuizBank } from '../qbank';

function bank(name: string, questions: QuizBank['questions']): QuizBank {
  return { name, importedAt: 1, questions };
}

const BANKS: QuizBank[] = [
  bank('生理学', [
    {
      id: 'q1',
      type: 'choice',
      stem: '  关于静息电位，下列正确的是  ',
      options: ['甲', '乙', '丙'],
      answer: 1, answerText: '',
      chapter: '生理学·细胞的基本功能',
      optionNotes: ['', '因为钾外流', undefined] as unknown as string[],
    },
    // 没有章节：落不到任何笔记上，收进来也看不见
    { id: 'q2', type: 'choice', stem: '无章节的题', options: ['甲', '乙'], answer: 0, answerText: '', optionNotes: ['批注'] },
    // 批注全是空白：不该出现在列表里
    { id: 'q3', type: 'choice', stem: '空批注', options: ['甲'], answer: 0, answerText: '', chapter: '生理学·血液', optionNotes: ['  '] },
  ]),
];

describe('collectAnnotations', () => {
  it('只收非空批注，并带上选项字母与题库名', () => {
    const all = collectAnnotations(BANKS);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ bank: '生理学', qid: 'q1', letter: 'B', note: '因为钾外流' });
    // 题干去掉首尾空白，列表里不该出现缩进
    expect(all[0].stem).toBe('关于静息电位，下列正确的是');
  });

  it('题干过长时截断并加省略号（列表是索引，不是阅读器）', () => {
    const long = '题'.repeat(120);
    const all = collectAnnotations([
      bank('b', [{ id: 'x', type: 'choice', stem: long, options: ['甲'], answer: 0, answerText: '', chapter: 'c', optionNotes: ['注'] }]),
    ]);
    expect(all[0].stem.length).toBeLessThanOrEqual(81);
    expect(all[0].stem.endsWith('…')).toBe(true);
  });
});

describe('annotationsForPath', () => {
  const all: QuestionAnnotation[] = collectAnnotations(BANKS);

  it('题库章节笔记只拿到本章的批注', () => {
    expect(annotationsForPath(all, '题库/绿皮书/生理学/细胞的基本功能.md')).toHaveLength(1);
  });

  it('同一章不同来源的笔记也认得（路径中间那层是来源）', () => {
    expect(annotationsForPath(all, '题库/医考帮/生理学/细胞的基本功能.md')).toHaveLength(1);
  });

  it('别的章节 / 普通笔记 / 更深的目录一律返回空', () => {
    expect(annotationsForPath(all, '题库/绿皮书/生理学/血液.md')).toEqual([]);
    expect(annotationsForPath(all, '生理学/细胞的基本功能.md')).toEqual([]);
    expect(annotationsForPath(all, '题库/绿皮书/生理学/细胞的基本功能/补充.md')).toEqual([]);
  });
});
