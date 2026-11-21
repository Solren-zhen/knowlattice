// @vitest-environment node
/** 章节 × 错因矩阵（P0-3）：条数、主要错因、正确率联结与排序。 */
import { describe, expect, it } from 'vitest';
import { CAUSE_KEYS, CAUSE_LABELS, mistakeMatrix, matrixTotal } from '../mistakeMatrix';
import type { MistakeMap, MistakeReason } from '../mistakes';
import type { ChapterMastery } from '../qbankStats';

const rec = (path: string, chapter: string, reason?: MistakeReason) => ({
  path, chapter, title: path, count: 1, lastFailedAt: 0, ...(reason ? { reason } : {}),
});
const map = (...rows: ReturnType<typeof rec>[]): MistakeMap =>
  Object.fromEntries(rows.map((r) => [r.path, r]));
const mastery = (chapter: string, seen: number, wrong: number): ChapterMastery => ({
  chapter, seen, wrong, accuracy: seen ? (seen - wrong) / seen : 0, weak: false,
});

describe('mistakeMatrix', () => {
  it('按章节汇总条数与错因，取条数最多的为主要错因', () => {
    const rows = mistakeMatrix(map(
      rec('a', '循环系统', 'knowledge'),
      rec('b', '循环系统', 'knowledge'),
      rec('c', '循环系统'),
    ));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.mistakes).toBe(3);
    expect(r.byCause.knowledge).toBe(2);
    expect(r.byCause.unlabeled).toBe(1);
    expect(r.byCause.confusion).toBe(0);
    expect(r.topCause).toBe('knowledge');
    expect(r.nextStep).toContain('回原文');
  });

  it('主要错因平局时按固定列序取前者（结果可复现）', () => {
    const rows = mistakeMatrix(map(rec('a', '呼吸', 'confusion'), rec('b', '呼吸', 'knowledge')));
    expect(rows[0].topCause).toBe('knowledge');
  });

  it('正确率按同名章节精确联结；对不上就是 null（不猜）', () => {
    const rows = mistakeMatrix(
      map(rec('a', '循环系统'), rec('b', '未知章节')),
      [mastery('循环系统', 4, 2)],
    );
    const byName = new Map(rows.map((r) => [r.chapter, r]));
    expect(byName.get('循环系统')?.accuracy).toBeCloseTo(0.5);
    expect(byName.get('循环系统')?.seen).toBe(4);
    expect(byName.get('未知章节')?.accuracy).toBeNull();
    expect(byName.get('未知章节')?.seen).toBe(0);
  });

  it('同名章节跨题库合并后重算正确率', () => {
    const rows = mistakeMatrix(map(rec('a', '循环系统')), [
      mastery('循环系统', 2, 0),
      mastery('循环系统', 2, 2),
    ]);
    expect(rows[0].seen).toBe(4);
    expect(rows[0].accuracy).toBeCloseTo(0.5);
  });

  it('错题多的章排前面；条数相同按章节自然序（第6章在第10章前）', () => {
    const rows = mistakeMatrix(map(
      rec('a', '第10章'), rec('b', '第6章'),
      rec('c', '第2章'), rec('d', '第2章'),
    ));
    expect(rows.map((r) => r.chapter)).toEqual(['第2章', '第6章', '第10章']);
  });

  it('没写章节的笔记归到空串那一档，不丢', () => {
    const rows = mistakeMatrix(map(rec('a', '')));
    expect(rows[0].chapter).toBe('');
    expect(rows[0].nextStep).toBe(CAUSE_LABELS.unlabeled === '未标注' ? rows[0].nextStep : '');
    expect(rows[0].nextStep.length).toBeGreaterThan(0);
  });

  it('矩阵总量 = 错题条数（一条一票，不看累计次数）', () => {
    const rows = mistakeMatrix(map(rec('a', '甲'), rec('b', '甲'), rec('c', '乙')));
    expect(matrixTotal(rows)).toBe(3);
  });

  it('列键固定：四类错因 + 未标注', () => {
    expect(CAUSE_KEYS).toEqual(['knowledge', 'confusion', 'careless', 'reasoning', 'unlabeled']);
  });
});
