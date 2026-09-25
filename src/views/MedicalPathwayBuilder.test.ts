import { describe, expect, it } from 'vitest';
import { makePathwayMarkdown } from '../core/pathwayBuilder';

describe('makePathwayMarkdown', () => {
  it('keeps nodes and relationships in lane names that contain spaces', () => {
    const markdown = makePathwayMarkdown(
      '能量代谢',
      [{ name: '有氧 呼吸', color: '#1c7ed6', note: '' }],
      [{ name: '丙酮酸', group: '有氧 呼吸' }, { name: '乙酰辅酶A', group: '有氧 呼吸' }],
      [{ from: '丙酮酸', to: '乙酰辅酶A', label: '丙酮酸脱氢酶复合体', relation: 'convert', group: '有氧 呼吸' }],
    );

    expect(markdown).toContain('## 有氧 呼吸 | #1c7ed6');
    expect(markdown).toContain('丙酮酸 -> 乙酰辅酶A : 丙酮酸脱氢酶复合体');
  });
});
