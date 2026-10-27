import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_REGISTRY, GOVERNED_AGENT_TOOLS, classifyToolResult, createAgentRuntime,
  makeWriteVerifier, riskFor,
} from '../agentRuntime';

/** 只读工具名（登记表里 toolType 非 write 的那些） */
function runtimeWith(docs: Map<string, string>, execute: (name: string, argsJson: string) => Promise<string>) {
  return createAgentRuntime({
    registry: AGENT_TOOL_REGISTRY,
    execute: (name, argsJson) => execute(name, argsJson),
    verify: makeWriteVerifier((p) => docs.get(p)),
  });
}

describe('classifyToolResult', () => {
  it('区分拒绝 / 失败 / 成功三种句式', () => {
    expect(classifyToolResult('用户拒绝了这次修改。同一提案不要再次提交')).toBe('refused');
    expect(classifyToolResult('用户放弃了这次修改（笔记已被用户改动过）。')).toBe('refused');
    expect(classifyToolResult('错误：找不到笔记「a.md」。')).toBe('failed');
    expect(classifyToolResult('写入失败：磁盘只读')).toBe('failed');
    expect(classifyToolResult('已写入「a.md」。')).toBe('ok');
  });
});

describe('riskFor', () => {
  it('写指令文件比写普通笔记高一档', () => {
    const def = AGENT_TOOL_REGISTRY.get('propose_note_edit')!;
    expect(riskFor(def, { path: '心衰.md' })).toBe('medium');
    expect(riskFor(def, { path: 'AGENT.md' })).toBe('high');
    expect(riskFor(def, { path: 'AI命令/复盘.md' })).toBe('high');
  });
  it('只读工具不受路径影响', () => {
    const def = AGENT_TOOL_REGISTRY.get('read_note')!;
    expect(riskFor(def, { path: 'AGENT.md' })).toBe('low');
  });
});

describe('createAgentRuntime 记录', () => {
  it('只读成功：auto + success + skipped', async () => {
    const rt = runtimeWith(new Map([['a.md', 'x']]), async () => '全部笔记：a.md');
    const out = await rt.executeTool('list_notes', '{}', new AbortController().signal);
    expect(out).toBe('全部笔记：a.md');
    const [rec] = rt.records();
    expect(rec.approvalStatus).toBe('auto');
    expect(rec.executionStatus).toBe('success');
    expect(rec.verificationStatus).toBe('skipped');
    expect(rec.toolType).toBe('read');
    expect(rt.stats()).toMatchObject({ calls: 1, reads: 1, writes: 0, failed: 0 });
  });

  it('只读返回错误句式记成 failed', async () => {
    const rt = runtimeWith(new Map(), async () => '错误：找不到笔记「a.md」。');
    await rt.executeTool('read_note', '{"path":"a.md"}', new AbortController().signal);
    const [rec] = rt.records();
    expect(rec.executionStatus).toBe('failed');
    expect(rec.errorMessage).toContain('找不到笔记');
  });

  it('写入成功并经核对一致：approved + verified', async () => {
    const docs = new Map([['a.md', '新正文']]);
    const rt = runtimeWith(docs, async () => '已写入「a.md」。');
    await rt.executeTool('propose_note_edit', '{"path":"a.md","content":"新正文"}', new AbortController().signal);
    const [rec] = rt.records();
    expect(rec.approvalStatus).toBe('approved');
    expect(rec.executionStatus).toBe('success');
    expect(rec.verificationStatus).toBe('verified');
    expect(rec.executedAt).not.toBeNull();
    expect(rt.stats()).toMatchObject({ writes: 1, verified: 1 });
  });

  it('写入后正文与提案不符：mismatch', async () => {
    const docs = new Map([['a.md', '别的正文']]);
    const rt = runtimeWith(docs, async () => '已写入「a.md」。');
    await rt.executeTool('propose_note_edit', '{"path":"a.md","content":"新正文"}', new AbortController().signal);
    expect(rt.records()[0].verificationStatus).toBe('mismatch');
    expect(rt.stats().mismatched).toBe(1);
  });

  it('定点改写核对替换结果是否落地', async () => {
    const docs = new Map([['a.md', '前 后']]);
    const rt = runtimeWith(docs, async () => '已写入「a.md」。');
    await rt.executeTool('propose_note_patch', '{"path":"a.md","find_text":"前","replace_text":"后"}', new AbortController().signal);
    expect(rt.records()[0].verificationStatus).toBe('verified');
  });

  it('用户拒绝：rejected + pending + 未执行', async () => {
    const rt = runtimeWith(new Map(), async () => '用户拒绝了这次修改。同一提案不要再次提交（内容相同或近似都算重复）；先问用户想怎么调整，得到新方向后再重新提案。');
    await rt.executeTool('propose_note_edit', '{"path":"a.md","content":"x"}', new AbortController().signal);
    const [rec] = rt.records();
    expect(rec.approvalStatus).toBe('rejected');
    expect(rec.executionStatus).toBe('pending');
    expect(rec.executedAt).toBeNull();
    expect(rt.stats().refused).toBe(1);
  });

  it('执行抛错：记录失败并把异常继续抛出去', async () => {
    const rt = runtimeWith(new Map(), async () => { throw new Error('磁盘满了'); });
    await expect(rt.executeTool('propose_note_create', '{"path":"b.md","content":"x"}', new AbortController().signal))
      .rejects.toThrow('磁盘满了');
    const [rec] = rt.records();
    expect(rec.executionStatus).toBe('failed');
    expect(rec.errorMessage).toBe('磁盘满了');
  });

  it('未注册工具与非法参数原样透传且不留记录', async () => {
    const seen: string[] = [];
    const rt = runtimeWith(new Map(), async (name) => { seen.push(name); return 'ok'; });
    await rt.executeTool('no_such_tool', '{}', new AbortController().signal);
    await rt.executeTool('list_notes', '{不是 JSON', new AbortController().signal);
    expect(seen).toEqual(['no_such_tool', 'list_notes']);
    expect(rt.records()).toHaveLength(0);
  });
});

describe('takeAuditSummary', () => {
  it('只报异常，且取一次就清空', async () => {
    const docs = new Map([['a.md', '旧']]);
    const rt = createAgentRuntime({
      registry: AGENT_TOOL_REGISTRY,
      execute: async (name) => (name === 'propose_note_edit'
        ? '用户拒绝了这次修改。'
        : name === 'read_note' ? '错误：找不到笔记「b.md」。' : 'ok'),
      verify: makeWriteVerifier((p) => docs.get(p)),
    });
    const sig = new AbortController().signal;
    await rt.executeTool('propose_note_edit', '{"path":"a.md","content":"x"}', sig);
    await rt.executeTool('read_note', '{"path":"b.md"}', sig);
    const s = rt.takeAuditSummary();
    expect(s).toContain('【上一轮工具执行异常】');
    expect(s).toContain('用户拒绝了这次写入');
    expect(s).toContain('执行失败');
    expect(rt.takeAuditSummary()).toBe('');
  });

  it('全成功时返回空串', async () => {
    const rt = runtimeWith(new Map(), async () => 'ok');
    await rt.executeTool('list_notes', '{}', new AbortController().signal);
    expect(rt.takeAuditSummary()).toBe('');
  });
});

describe('注册表', () => {
  it('wire 出来的数组只含 function calling 三字段', () => {
    const wire = AGENT_TOOL_REGISTRY.wire();
    expect(wire).toHaveLength(GOVERNED_AGENT_TOOLS.length);
    for (const t of wire) expect(Object.keys(t).sort()).toEqual(['description', 'name', 'parameters']);
  });
  it('白名单裁剪', () => {
    const picked = AGENT_TOOL_REGISTRY.wire(['read_note', 'list_notes']);
    expect(picked.map((t) => t.name).sort()).toEqual(['list_notes', 'read_note']);
  });
});
