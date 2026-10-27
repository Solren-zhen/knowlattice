import { describe, expect, it } from 'vitest';
import { createGovernedExecutor, createToolRegistry, defineTool } from '../agentGovernance';
import { adviseCompaction, measureContext } from '../agentContextUsage';

const readTool = defineTool({ name: 'read_note', description: 'r', parameters: { type: 'object' } });
const writeTool = defineTool(
  { name: 'propose_note_edit', description: 'w', parameters: { type: 'object' } },
  { toolType: 'write', riskLevel: 'medium', executionDomain: 'note' },
);
const registry = createToolRegistry([readTool, writeTool]);

function makeExecutor(overrides: Partial<Parameters<typeof createGovernedExecutor>[0]> = {}) {
  const calls: string[] = [];
  const ex = createGovernedExecutor({
    registry,
    apply: async (name, args) => {
      calls.push(name + ':' + JSON.stringify(args));
      return 'ok:' + name;
    },
    ...overrides,
  });
  return { ex, calls };
}

describe('工具治理元数据', () => {
  it('只读工具默认自动放行，写入工具默认要求确认', () => {
    expect(readTool.governance.requiresConfirmation).toBe(false);
    expect(readTool.governance.readOnly).toBe(true);
    expect(writeTool.governance.requiresConfirmation).toBe(true);
    expect(writeTool.governance.readOnly).toBe(false);
    expect(writeTool.governance.riskLevel).toBe('medium');
  });

  it('wire() 剥掉治理字段，白名单为空时全给', () => {
    const wire = registry.wire();
    expect(wire).toHaveLength(2);
    expect(Object.keys(wire[0])).toEqual(['name', 'description', 'parameters']);
    expect(registry.wire(['read_note']).map((t) => t.name)).toEqual(['read_note']);
  });
});

describe('两段式执行器', () => {
  it('只读工具当场执行并记 auto', async () => {
    const { ex, calls } = makeExecutor();
    const out = await ex.run('read_note', '{"path":"解剖/心脏.md"}');
    expect(out.executed).toBe(true);
    expect(out.requiresConfirmation).toBe(false);
    expect(out.toolResult).toBe('ok:read_note');
    expect(out.action.approvalStatus).toBe('auto');
    expect(out.action.executionStatus).toBe('success');
    expect(out.action.verificationStatus).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('写入工具只出预览，不写、不阻塞', async () => {
    const { ex, calls } = makeExecutor();
    const out = await ex.run('propose_note_edit', '{"path":"解剖/心脏.md","content":"x"}');
    expect(out.executed).toBe(false);
    expect(out.requiresConfirmation).toBe(true);
    expect(out.action.approvalStatus).toBe('pending');
    expect(out.action.executionStatus).toBe('pending');
    expect(out.action.previewSummary).toContain('解剖/心脏.md');
    expect(out.toolResult).toContain('待确认改动');
    expect(calls).toHaveLength(0);
    expect(ex.pending()).toHaveLength(1);
  });

  it('确认后才真正执行，可以攒多条一次裁决', async () => {
    const { ex, calls } = makeExecutor();
    const a = await ex.run('propose_note_edit', '{"path":"a.md"}');
    const b = await ex.run('propose_note_edit', '{"path":"b.md"}');
    expect(calls).toHaveLength(0);
    const done = await ex.resolveAll([
      { id: a.action.id, approve: true },
      { id: b.action.id, approve: false },
    ]);
    expect(calls).toHaveLength(1);
    expect(done[0].executionStatus).toBe('success');
    expect(done[1].approvalStatus).toBe('rejected');
    expect(done[1].executionStatus).toBe('pending');
    expect(ex.pending()).toHaveLength(0);
  });

  it('执行失败落入 failed 并带回错误原文', async () => {
    const { ex } = makeExecutor({ apply: async () => { throw new Error('磁盘满'); } });
    const out = await ex.run('read_note', '{}');
    expect(out.executed).toBe(false);
    expect(out.action.executionStatus).toBe('failed');
    expect(out.action.errorMessage).toBe('磁盘满');
    expect(out.toolResult).toContain('磁盘满');
  });

  it('verify 返回 mismatch 时会标出来', async () => {
    const { ex } = makeExecutor({ verify: () => 'mismatch' });
    const out = await ex.run('read_note', '{}');
    expect(out.action.verificationStatus).toBe('mismatch');
  });

  it('undo 存在时可回滚并改状态', async () => {
    let undone = 0;
    const { ex } = makeExecutor({ undo: async () => { undone += 1; return true; } });
    const out = await ex.run('read_note', '{}');
    expect(out.action.canRollback).toBe(true);
    const rolled = await ex.rollback(out.action.id);
    expect(undone).toBe(1);
    expect(rolled.executionStatus).toBe('rolled_back');
  });

  it('非法 JSON 与未知工具都不抛异常', async () => {
    const { ex } = makeExecutor();
    const bad = await ex.run('read_note', '{not json');
    expect(bad.executed).toBe(false);
    expect(bad.toolResult).toContain('合法 JSON');
    const unknown = await ex.run('nope', '{}');
    expect(unknown.toolResult).toContain('没有名为');
  });

  it('formatResolvedSummary 汇总成一条系统消息', async () => {
    const { ex } = makeExecutor();
    const a = await ex.run('propose_note_edit', '{"path":"a.md"}');
    const b = await ex.run('propose_note_edit', '{"path":"b.md"}');
    expect(ex.formatResolvedSummary()).toBe('');
    await ex.confirm(a.action.id);
    ex.reject(b.action.id);
    const msg = ex.formatResolvedSummary();
    expect(msg).toContain('上一轮待确认的写入');
    expect(msg).toContain('已执行');
    expect(msg).toContain('用户已拒绝');
  });
});

describe('上下文分桶', () => {
  it('按段归桶并算剩余预算', () => {
    const b = measureContext([
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'y'.repeat(80) },
      { role: 'assistant', content: 'z'.repeat(80) },
      { role: 'user', content: 'q'.repeat(40) },
      { role: 'tool', content: 'w'.repeat(800) },
    ], { budget: 1000 });
    expect(b.systemPromptTokens).toBe(100);
    expect(b.toolResultTokens).toBe(200);
    expect(b.userInputTokens).toBe(10);
    // 早先那条 user 与 assistant 归历史；只有最后一条 user 算本次输入
    expect(b.historyTokens).toBe(40);
    expect(b.totalTokens).toBe(350);
    expect(b.remainingTokens).toBe(650);
    expect(b.compactActive).toBe(false);
  });

  it('超 85% 才建议压缩，且指向占比大的段', () => {
    const small = measureContext([{ role: 'system', content: 'x'.repeat(400) }], { budget: 1000 });
    expect(adviseCompaction(small, 1000).needed).toBe(false);
    const big = measureContext([
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'tool', content: 'w'.repeat(6000) },
    ], { budget: 1000 });
    const advise = adviseCompaction(big, 1000);
    expect(advise.needed).toBe(true);
    expect(advise.target).toBe('toolResults');
    expect(advise.reclaimTokens).toBeGreaterThan(0);
  });
});
