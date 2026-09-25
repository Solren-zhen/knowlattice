import { describe, expect, it } from 'vitest';
import { repairMarkdown } from '../markdownRepair';

describe('repairMarkdown', () => {
  it('修复表格行首的单反斜杠管道符', () => {
    const input = '\\| A | B |\n| --- | --- |\n\\| x | y |';
    const result = repairMarkdown(input);
    expect(result.content).toBe('| A | B |\n| --- | --- |\n| x | y |');
    expect(result).toMatchObject({ changed: true, changes: [{ kind: 'escaped-table-pipe', count: 2 }] });
  });

  it('修复表格行首的双反斜杠管道符', () => {
    const result = repairMarkdown('\\\\| A | B |\n| --- | --- |\n\\\\| x | y |');
    expect(result.content).toBe('| A | B |\n| --- | --- |\n| x | y |');
  });

  it('不改普通文本中的转义管道符', () => {
    const result = repairMarkdown('说明：\\| 代表或。');
    expect(result.content).toBe('说明：\\| 代表或。');
    expect(result.changed).toBe(false);
  });

  it('不改 fenced code block 中的示例', () => {
    const source = '```md\n\\| A | B |\n| --- | --- |\n```';
    expect(repairMarkdown(source).content).toBe(source);
  });

  it('合法表格与未闭合强调标记保持不变', () => {
    const source = '| **A** | ==B== |\n| --- | --- |\n| x | y |\n\n**未闭合';
    expect(repairMarkdown(source).content).toBe(source);
    expect(repairMarkdown(source).changed).toBe(false);
  });
});
