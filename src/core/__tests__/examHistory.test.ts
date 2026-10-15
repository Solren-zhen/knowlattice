// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExamResult } from '../exam';
import {
  clearExamHistory, EXAM_HISTORY_CAP, exportExamHistory, historyForBank,
  importExamHistory, loadExamHistory, removeExamResult, saveExamResult,
} from '../examHistory';

function make(id: string, bank: string, score: number, finishedAt: number): ExamResult {
  return {
    id, bankName: bank, startedAt: finishedAt - 1000, finishedAt, usedMs: 1000, timeLimitMs: 0,
    total: 10, correct: score / 10, score, perChapter: [], wrongIds: [],
  };
}

beforeEach(() => localStorage.clear());

describe('examHistory · 历史存取', () => {
  it('保存后按完成时间倒序读取', () => {
    saveExamResult(make('1', 'A', 60, 1000));
    const list = saveExamResult(make('2', 'A', 80, 2000));
    expect(list[0].id).toBe('2');
    expect(loadExamHistory().map((r) => r.id)).toEqual(['2', '1']);
  });

  it('同 id 覆盖不重复累积', () => {
    saveExamResult(make('1', 'A', 60, 1000));
    saveExamResult({ ...make('1', 'A', 90, 1500) });
    expect(loadExamHistory()).toHaveLength(1);
    expect(loadExamHistory()[0].score).toBe(90);
  });

  it('超过上限只留最近 N 场', () => {
    for (let i = 0; i < EXAM_HISTORY_CAP + 5; i++) saveExamResult(make(String(i), 'A', 50, i));
    expect(loadExamHistory()).toHaveLength(EXAM_HISTORY_CAP);
    expect(loadExamHistory()[0].id).toBe(String(EXAM_HISTORY_CAP + 4));
  });

  it('删除与清空', () => {
    saveExamResult(make('1', 'A', 60, 1000));
    saveExamResult(make('2', 'B', 70, 2000));
    expect(removeExamResult('1').map((r) => r.id)).toEqual(['2']);
    expect(clearExamHistory()).toEqual([]);
    expect(loadExamHistory()).toEqual([]);
  });

  it('historyForBank 只留本题库', () => {
    saveExamResult(make('1', 'A', 60, 1000));
    saveExamResult(make('2', 'B', 70, 2000));
    expect(historyForBank('A').map((r) => r.id)).toEqual(['1']);
  });

  it('损坏数据被丢弃、缺失字段被补零', () => {
    localStorage.setItem('knowlattice-exam-history', JSON.stringify([{ id: 'x' }, make('1', 'A', 60, 1000)]));
    const list = loadExamHistory();
    expect(list.map((r) => r.id)).toEqual(['1']);
  });

  it('import 按 id 去重（重复导入同一份备份不翻倍）', () => {
    const snapshot = [make('1', 'A', 60, 1000), make('2', 'A', 70, 2000)];
    expect(importExamHistory(snapshot)).toBe(2);
    expect(importExamHistory(snapshot)).toBe(0); // 全是重复 id
    expect(loadExamHistory()).toHaveLength(2);
    expect(importExamHistory([...snapshot, make('3', 'A', 80, 3000)])).toBe(1);
    expect(loadExamHistory()).toHaveLength(3);
    expect(exportExamHistory()).toHaveLength(3);
  });
});
