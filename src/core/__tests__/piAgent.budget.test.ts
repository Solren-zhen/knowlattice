/**
 * pi 引擎的上下文预算回归：
 * - 单条：工具结果回填 transcript 前过 capToolResult（长笔记不再一次撑爆上下文）；
 * - 整轮：每次请求模型前 trimPiToolResults 把超累计预算的更早结果换成占位说明；
 * - 畸形消息不得让 transformContext 抛异常（pi 契约：该钩子不得抛出）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, TranscriptContext } from '@earendil-works/pi-ai';
import type { RunAgentOptions } from '../aiAgent';
import { TOOL_RESULT_LIMIT, TOOL_RESULT_TOTAL_LIMIT } from '../aiBudget';
import { runPiAgent, trimPiToolResults } from '../piAgent';

const SETTINGS = { baseUrl: 'http://mock.local/v1/', apiKey: 'sk-test', model: 'mock' };
const piUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const TOOLS: RunAgentOptions['tools'] = [
  { name: 'read_note', description: '读笔记', parameters: { type: 'object', properties: {} } },
];

function piMsg(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'knowlattice-relay',
    model: 'mock', usage: { ...piUsage, cost: { ...piUsage.cost } }, stopReason, timestamp: Date.now(),
  };
}

const done = (m: AssistantMessage): AssistantMessageEvent =>
  ({ type: 'done', reason: m.stopReason as 'stop' | 'toolUse', message: m });
const textDelta = (delta: string): AssistantMessageEvent =>
  ({ type: 'text_delta', contentIndex: 0, delta, partial: piMsg([{ type: 'text', text: '' }], 'stop') });

/** 把一组 pi 流事件包成 AssistantMessageEventStream 形状（pi 只在 start 后转发增量，故自动补 start） */
function eventStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const seq = [{ type: 'start', partial: piMsg([], 'stop') } as AssistantMessageEvent, ...events];
  let i = 0;
  const lastDone = [...seq].reverse().find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done');
  return {
    async *[Symbol.asyncIterator]() {
      while (i < seq.length) yield seq[i++];
    },
    result: async () => lastDone?.message
      ?? { ...piMsg([], 'error'), errorMessage: '脚本里没有 done 事件' },
  } as unknown as AssistantMessageEventStream;
}

/** 每次请求消费脚本里的一组事件；记录收到的 transcript 供断言 */
function scriptStream(script: AssistantMessageEvent[][], calls: TranscriptContext[]): StreamFn {
  let i = 0;
  return ((_model, ctx) => {
    calls.push(ctx);
    const events = script[i++];
    if (!events) throw new Error('脚本事件用尽');
    return eventStream(events);
  }) as StreamFn;
}

function toolUse(id: string): AssistantMessageEvent[] {
  return [done(piMsg([{ type: 'toolCall', id, name: 'read_note', arguments: {} }], 'toolUse'))];
}

const stopText = (text: string): AssistantMessageEvent[] => [textDelta(text), done(piMsg([{ type: 'text', text }], 'stop'))];

/** 取出 transcript 里的工具结果文本 */
function toolResultTexts(messages: readonly { role: string }[]): string[] {
  return messages
    .filter((m): m is Extract<AgentMessage, { role: 'toolResult' }> => m.role === 'toolResult')
    .map((m) => m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(''));
}

describe('pi 上下文预算', () => {
  it('单条：30k 字的工具结果回填前被截断到 8k 以内并带截断标记', async () => {
    const calls: TranscriptContext[] = [];
    const huge = '字'.repeat(30_000);
    const promise = runPiAgent(
      {
        settings: SETTINGS,
        messages: [{ role: 'user', content: '读一下' }],
        tools: TOOLS,
        executeTool: async () => huge,
      },
      { streamFn: scriptStream([toolUse('c1'), stopText('读完了')], calls) },
    );
    await expect(promise).resolves.toEqual({ content: '读完了' });
    expect(calls).toHaveLength(2);
    const [backfilled] = toolResultTexts(calls[1].messages);
    expect(backfilled.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    expect(backfilled).toContain('已截断');
    expect(backfilled).toContain('30000');
  });

  it('整轮：6 条各 8k 的工具结果里，最旧的换成占位说明、最新的一条原文保留', async () => {
    const calls: TranscriptContext[] = [];
    const each = '字'.repeat(TOOL_RESULT_LIMIT);
    const script = [0, 1, 2, 3, 4, 5].map((i) => toolUse(`c${i}`)).concat([stopText('完成')]);
    const promise = runPiAgent(
      {
        settings: SETTINGS,
        messages: [{ role: 'user', content: '连读六篇' }],
        tools: TOOLS,
        executeTool: async () => each,
      },
      { streamFn: scriptStream(script, calls) },
    );
    await expect(promise).resolves.toEqual({ content: '完成' });
    expect(calls).toHaveLength(7);
    const results = toolResultTexts(calls[6].messages);
    expect(results).toHaveLength(6);
    // 最新一条原文保留；更早的超出累计预算的那条换成占位说明
    expect(results[5]).toBe(each);
    expect(results[0]).toContain('较早的工具结果已省略');
    expect(results[0]).toContain(String(TOOL_RESULT_LIMIT));
    expect(results[0].length).toBeLessThan(200);
    // 保留的原文合计不超累计预算（占位说明本身是固定小尾巴，与内置引擎 trimToolResults 同口径）
    const keptText = results.slice(1).reduce((n, t) => n + t.length, 0);
    expect(keptText).toBeLessThanOrEqual(TOOL_RESULT_TOTAL_LIMIT);
    expect(results.reduce((n, t) => n + t.length, 0)).toBeLessThan(TOOL_RESULT_TOTAL_LIMIT + 200);
  });

  it('畸形消息：role 不认识 / content 不是数组或字符串时不抛异常且原样返回', () => {
    const malformed = [
      { role: 'nonsense', content: 42 },
      { role: 'toolResult', content: 'not-an-array' },
      { role: 'toolResult' },
      { role: 'toolResult', content: [{ type: 'text', text: 123 }] },
      { role: 'toolResult', content: [null, undefined] },
      { role: 'user', content: '正常消息' },
    ] as unknown as AgentMessage[];
    let out: AgentMessage[] = [];
    expect(() => { out = trimPiToolResults(malformed); }).not.toThrow();
    expect(out).toHaveLength(malformed.length);
    malformed.forEach((m, i) => expect(out[i]).toBe(m));
  });
});
