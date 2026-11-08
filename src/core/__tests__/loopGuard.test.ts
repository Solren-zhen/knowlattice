/**
 * 原地打转防护：连续同名同参第 3 次起拦截。
 *
 * 为什么是「连续」而不是「累计」：跨轮重复是正常行为（每轮先读同一篇笔记），
 * 真正要拦的是「一步没推进、参数一个字没改又调一次」。
 */
import { describe, expect, it } from 'vitest';
import { createLoopGuard, repeatHint, repeatKey } from '../loopGuard';
import { AGENT_TOOL_REGISTRY, createAgentRuntime } from '../agentRuntime';

describe('repeatKey', () => {
  it('参数键序不同视为同一份参数', () => {
    expect(repeatKey('t', { a: 1, b: 2 })).toBe(repeatKey('t', { b: 2, a: 1 }));
  });

  it('嵌套对象的键序也归一', () => {
    expect(repeatKey('t', { x: { p: 1, q: 2 } })).toBe(repeatKey('t', { x: { q: 2, p: 1 } }));
  });

  it('数组保序（顺序不同就是不同调用）', () => {
    expect(repeatKey('t', { list: [1, 2] })).not.toBe(repeatKey('t', { list: [2, 1] }));
  });

  it('循环引用不抛异常，退化成同名同参', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => repeatKey('t', a)).not.toThrow();
    expect(repeatKey('t', a)).toBe('t:{}');
  });

  it('工具名不同就不是同一个 key', () => {
    expect(repeatKey('a', { x: 1 })).not.toBe(repeatKey('b', { x: 1 }));
  });
});

describe('createLoopGuard', () => {
  it('同名同参允许 2 次，第 3 次起拦截', () => {
    const g = createLoopGuard(2);
    expect(g.hit('k')).toBe(1);
    expect(g.hit('k')).toBe(2);
    expect(g.hit('k')).toBe(3);
    expect(g.blockedAny()).toBe(true);
    expect(g.blocks('k')).toBe(1);
  });

  it('中间插一次别的调用就重新计数（不是累计）', () => {
    const g = createLoopGuard(2);
    g.hit('a');
    g.hit('a');
    g.hit('b');
    expect(g.hit('a')).toBe(1);
    expect(g.blockedAny()).toBe(false);
  });

  it('reset 清空连续状态', () => {
    const g = createLoopGuard(2);
    g.hit('a');
    g.hit('a');
    g.reset();
    expect(g.hit('a')).toBe(1);
  });

  it('提示语说清了为什么和怎么办', () => {
    const hint = repeatHint('read_note', 3);
    expect(hint).toContain('read_note');
    expect(hint).toContain('3');
    expect(hint).toContain('换一个工具');
  });
});

describe('运行时接线', () => {
  const make = (execute: (name: string) => Promise<string>) => {
    let calls = 0;
    const runtime = createAgentRuntime({
      registry: AGENT_TOOL_REGISTRY,
      execute: (name) => {
        calls += 1;
        return execute(name);
      },
    });
    return { runtime, count: () => calls };
  };

  it('连续三次相同调用只执行前两次，第三次返回拦截提示', async () => {
    const { runtime, count } = make(async () => '结果');
    const args = '{"path":"解剖/心脏.md"}';
    expect(await runtime.executeTool('read_note', args, new AbortController().signal)).toBe('结果');
    expect(await runtime.executeTool('read_note', args, new AbortController().signal)).toBe('结果');
    const third = await runtime.executeTool('read_note', args, new AbortController().signal);
    expect(third).toContain('已拦截');
    expect(count()).toBe(2);
    // 被拦的这次不算一次工具执行，所以审计里只有 2 条
    expect(runtime.records()).toHaveLength(2);
  });

  it('换了参数就重新执行', async () => {
    const { runtime, count } = make(async () => 'ok');
    const sig = new AbortController().signal;
    await runtime.executeTool('read_note', '{"path":"a.md"}', sig);
    await runtime.executeTool('read_note', '{"path":"a.md"}', sig);
    await runtime.executeTool('read_note', '{"path":"b.md"}', sig);
    expect(count()).toBe(3);
  });

  it('参数不是合法 JSON 时照旧透传，不参与绕圈计数', async () => {
    const { runtime, count } = make(async () => '原样透传');
    const sig = new AbortController().signal;
    expect(await runtime.executeTool('read_note', '{坏', sig)).toBe('原样透传');
    expect(await runtime.executeTool('read_note', '{坏', sig)).toBe('原样透传');
    expect(await runtime.executeTool('read_note', '{坏', sig)).toBe('原样透传');
    expect(count()).toBe(3);
  });
});
