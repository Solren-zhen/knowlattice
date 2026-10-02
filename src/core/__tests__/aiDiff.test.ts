import { describe, expect, it } from 'vitest';
import { collapseDiff, diffLines } from '../aiDiff';

describe('diffLines', () => {
  it('完全一致的文本返回全 same', () => {
    const rows = diffLines('a\nb\nc', 'a\nb\nc');
    expect(rows).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('识别中间插入与删除，保持文档顺序', () => {
    const rows = diffLines('定义\n机制\n治疗', '定义\n机制（新版）\n补充\n治疗');
    const types = rows.map((r) => r.type);
    expect(types).toEqual(['same', 'del', 'add', 'add', 'same']);
    expect(rows[2]).toEqual({ type: 'add', text: '机制（新版）' });
    expect(rows[3]).toEqual({ type: 'add', text: '补充' });
  });

  it('空旧文 = 全部新增', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('超长输入退化为粗粒度对比：中间整块删加', () => {
    // 2500 × 2500 = 625 万格，超过 LCS 上限；两文本无公共行 → 纯删 + 纯加
    const a = Array.from({ length: 2500 }, (_, i) => `旧 ${i}`).join('\n');
    const b = Array.from({ length: 2500 }, (_, i) => `新 ${i}`).join('\n');
    const rows = diffLines(a, b);
    const del = rows.filter((r) => r.type === 'del').length;
    const add = rows.filter((r) => r.type === 'add').length;
    expect(del).toBe(2500);
    expect(add).toBe(2500);
  });
});

describe('collapseDiff', () => {
  it('短未变段原样保留', () => {
    const rows = diffLines('a\nb\nc\nd', 'a\nb\nX\nd');
    const collapsed = collapseDiff(rows, 2);
    expect(collapsed.some((r) => r.type === 'gap')).toBe(false);
  });

  it('长未变段折叠成 gap，前后各留 context 行', () => {
    const old = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const next = old.replace('L10', 'L10 改');
    const collapsed = collapseDiff(diffLines(old, next), 2);
    // L0..L9（10 行）与 L11..L19（9 行）两段超长：各保留 4 行，其余折叠
    const gaps = collapsed.filter((r) => r.type === 'gap');
    expect(gaps.map((g) => (g as { count: number }).count)).toEqual([6, 5]);
  });
});
