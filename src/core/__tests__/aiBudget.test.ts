// @vitest-environment node
/** 工具结果上下文预算：单条截断与整轮累计裁剪。 */
import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_LIMIT, TOOL_RESULT_TOTAL_LIMIT, capToolResult, trimToolResults } from '../aiBudget';

describe('capToolResult', () => {
  it('不超限原样返回（不做无谓拷贝）', () => {
    const short = '心肌收缩泵血。';
    expect(capToolResult(short)).toBe(short);
    expect(capToolResult('x'.repeat(TOOL_RESULT_LIMIT))).toHaveLength(TOOL_RESULT_LIMIT);
  });

  it('超限保留首尾、写明原长与分段重读提示，且不超上限', () => {
    const text = `开头${'A'.repeat(20_000)}中间${'Z'.repeat(20_000)}结尾`;
    const out = capToolResult(text);
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    expect(out.startsWith('开头')).toBe(true);
    expect(out.endsWith('结尾')).toBe(true);
    expect(out).toContain('已截断');
    expect(out).toContain(String(text.length));
    expect(out).toContain('read_note');
  });

  it('可用更小的上限（累计预算的边界那一条走同一口径）', () => {
    const out = capToolResult('y'.repeat(5_000), 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain('已截断');
  });
});

describe('trimToolResults', () => {
  const tool = (content: string) => ({ role: 'tool', content });

  it('预算内不动，非工具消息不受影响', () => {
    const msgs = [tool('短结果'), { role: 'user', content: '问题' }, { role: 'assistant', content: '回答' }];
    expect(trimToolResults(msgs)).toEqual(msgs);
  });

  it('超预算：保留最新的，更早的换成占位说明', () => {
    const half = 'x'.repeat(TOOL_RESULT_TOTAL_LIMIT / 2);
    const msgs = [tool(half), tool(half), tool(half)];
    const out = trimToolResults(msgs);
    expect(out[2].content).toBe(msgs[2].content);
    expect(out[1].content).toBe(msgs[1].content);
    expect(out[0].content).toContain('已省略');
    expect(out[0].content).toContain(String(half.length));
    expect(out[0].content).toContain('重新调用工具');
  });

  it('边界那一条按剩余额度截断（不整条丢）', () => {
    const big = 'y'.repeat(30_000);
    const out = trimToolResults([tool(big), tool(big)]);
    expect(out[1].content).toBe(big);
    expect(out[0].content.length).toBeLessThanOrEqual(TOOL_RESULT_TOTAL_LIMIT - 30_000);
    expect(out[0].content).toContain('已截断');
  });

  it('非字符串 content 与缺失 content 原样保留', () => {
    const msgs = [{ role: 'tool', content: [{ type: 'text', text: 'x'.repeat(50_000) }] }, { role: 'tool' }];
    expect(trimToolResults(msgs)).toEqual(msgs);
  });
});
