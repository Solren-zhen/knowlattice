import { describe, expect, it } from 'vitest';
import { needsAttention, severityInfo, severityOf } from '../mistakeSeverity';
import type { MistakeRecord } from '../mistakes';

function rec(p: Partial<MistakeRecord>): MistakeRecord {
  return { path: 'a.md', chapter: 'c', title: 't', count: 1, lastFailedAt: 1, ...p } as MistakeRecord;
}

describe('mistakeSeverity', () => {
  it('第 0 阶段反复错 → 致命盲区', () => {
    expect(severityOf(rec({ count: 2, stage: 0 }))).toBe('critical');
    expect(severityInfo(rec({ count: 2 })).label).toBe('致命盲区');
  });

  it('反复回炉 → 顽固病灶（优先级高于地雷）', () => {
    expect(severityOf(rec({ count: 3, stage: 0, lapses: 2, lastAdvanceAt: 9 }))).toBe('stubborn');
  });

  it('推进过又被打回 → 隐形地雷', () => {
    expect(severityOf(rec({ count: 2, stage: 0, lapses: 1, lastAdvanceAt: 9 }))).toBe('landmine');
  });

  it('只错一次且没推进过 → 普通题', () => {
    expect(severityOf(rec({ count: 1, stage: 0 }))).toBe('normal');
    expect(needsAttention(rec({ count: 1 }))).toBe(false);
  });

  it('已归档不再挂标签', () => {
    expect(severityOf(rec({ count: 9, lapses: 5, stage: 3 }))).toBe('normal');
    expect(needsAttention(rec({ count: 9, stage: 3 }))).toBe(false);
  });

  it('悬停说明带上建议动作', () => {
    expect(severityInfo(rec({ count: 2 })).action).toBe('优先清理');
  });
});
