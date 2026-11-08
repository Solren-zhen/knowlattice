import { describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  integrityReport,
  integritySummary,
  noteNameSet,
  planRepairs,
  type IntegrityData,
} from '../integrity';
function data(overrides: Partial<IntegrityData> = {}): IntegrityData {
  return {
    banks: [
      {
        name: '内科',
        questions: [
          { id: 'q1', stem: '高血压诊断标准？' },
          { id: 'q2', stem: '心衰分级？' },
        ],
      },
    ],
    stats: [
      { bank: '内科', qid: 'q1' },
      { bank: '内科', qid: 'gone' },
      { bank: '已删题库', qid: 'q1' },
    ],
    stars: [
      { bank: '内科', qid: 'q2' },
      { bank: '内科', qid: 'gone' },
    ],
    docs: new Map([
      ['内科/高血压.md', '见 [[内科/心衰]] 与 [[不存在的笔记]]\n![x](_attachments/used.png)'],
      ['内科/心衰.md', '正文'],
    ]),
    attachmentPaths: ['_attachments/used.png', '_attachments/orphan.png'],
    linkIndex: {
      outgoing: new Map([
        ['内科/高血压.md', ['内科/心衰', '不存在的笔记']],
        ['内科/心衰.md', []],
      ]),
      incoming: new Map(),
    },
    ...overrides,
  };
}

describe('integrity', () => {
  it('发现指向不存在题库/题目的统计与收藏', () => {
    const checks = checkIntegrity(data());
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get('stat-bank-missing')?.count).toBe(1);
    expect(byId.get('stat-question-missing')?.count).toBe(1);
    expect(byId.get('star-question-missing')?.count).toBe(1);
  });

  it('空题干 / 缺 id / 同库重复 id 只报告不修', () => {
    const checks = checkIntegrity(data({
      banks: [{ name: '外科', questions: [{ id: 'a', stem: '' }, { id: 'a', stem: '重复' }, { stem: '缺 id' }] }],
      stats: [],
      stars: [],
      docs: new Map(),
      attachmentPaths: [],
      linkIndex: undefined,
    }));
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get('empty-question')?.count).toBe(2);
    expect(byId.get('duplicate-question-id')?.count).toBe(1);
    expect(planRepairs(checks).ops).toEqual([]);
  });

  it('失效双链：路径与文件名都算可解析目标', () => {
    const names = noteNameSet(data().docs);
    expect(names.has('内科/心衰')).toBe(true);
    expect(names.has('心衰')).toBe(true);
    const checks = checkIntegrity(data());
    expect(checks.find((c) => c.id === 'broken-link')?.count).toBe(1);
  });

  it('疑似孤儿附件只报告，不生成删除动作', () => {
    const checks = checkIntegrity(data());
    const orphan = checks.find((c) => c.id === 'orphan-attachment');
    expect(orphan?.items.map((item) => item.id)).toEqual(['_attachments/orphan.png']);
    expect(planRepairs(checks).ops.every((op) => op.kind !== 'remove-stat' || op.qid !== '_attachments/orphan.png')).toBe(true);
  });

  it('修复计划只包含悬空统计/收藏，且按 kind+bank+qid 去重', () => {
    const plan = planRepairs(checkIntegrity(data()));
    expect(plan.ops).toEqual([
      { kind: 'remove-stat', bank: '已删题库', qid: 'q1' },
      { kind: 'remove-stat', bank: '内科', qid: 'gone' },
      { kind: 'remove-star', bank: '内科', qid: 'gone' },
    ]);
    expect(plan.skipped.map((s) => s.check)).toContain('broken-link');
  });

  it('汇总按严重度计数；报告包含修复计数', () => {
    const checks = checkIntegrity(data());
    const summary = integritySummary(checks);
    expect(summary.problems).toBeGreaterThan(0);
    expect(summary.issues).toBeGreaterThanOrEqual(3);
    const text = integrityReport(checks, { at: 0, removedStats: 2, removedStars: 1 });
    expect(text).toContain('本次修复：删除统计 2 条、收藏 1 条');
    expect(text).toContain('失效双链');
  });

  it('没有 linkIndex 时不误报断链', () => {
    const checks = checkIntegrity(data({ linkIndex: undefined }));
    expect(checks.find((c) => c.id === 'broken-link')?.count).toBe(0);
  });
});
