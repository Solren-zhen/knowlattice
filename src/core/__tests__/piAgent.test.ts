/** pi 引擎适配层（runPiAgent / toPiMessages）的行为回归：假流注入，不发网络请求。 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, TranscriptContext } from '@earendil-works/pi-ai';
import { isAbortError, type RunAgentOptions, type WireMessage } from '../aiAgent';
import { runPiAgent, toPiMessages } from '../piAgent';

const SETTINGS = { baseUrl: 'http://mock.local/v1/', apiKey: 'sk-test', model: 'mock' };

const piUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function piMsg(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  over: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'knowlattice-relay',
    model: 'mock', usage: { ...piUsage, cost: { ...piUsage.cost } }, stopReason, timestamp: Date.now(),
    ...over,
  };
}

const textDelta = (delta: string): AssistantMessageEvent =>
  ({ type: 'text_delta', contentIndex: 0, delta, partial: piMsg([{ type: 'text', text: '' }], 'stop') });
const done = (m: AssistantMessage): AssistantMessageEvent =>
  ({ type: 'done', reason: m.stopReason as 'stop' | 'toolUse', message: m });

/** 把一组 pi 流事件包成 AssistantMessageEventStream 形状（pi 只在 start 后转发增量，故自动补 start） */
function eventStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  let i = 0;
  const seq = events[0]?.type === 'start' ? events : [{ type: 'start', partial: piMsg([], 'stop') } as AssistantMessageEvent, ...events];
  const lastDone = [...seq].reverse().find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done');
  const lastError = [...seq].reverse().find((e): e is Extract<AssistantMessageEvent, { type: 'error' }> => e.type === 'error');
  return {
    async *[Symbol.asyncIterator]() {
      while (i < seq.length) yield seq[i++];
    },
    result: async () => lastDone?.message ?? lastError?.error ?? piMsg([], 'error', { errorMessage: '脚本里没有 done 事件' }),
  } as unknown as AssistantMessageEventStream;
}

/** 每次请求消费脚本里的一组事件；记录收到的 transcript 供断言 */
function scriptStream(script: AssistantMessageEvent[][], calls: TranscriptContext[] = []): StreamFn {
  let i = 0;
  return ((_model, ctx) => {
    calls.push(ctx);
    const events = script[i++];
    if (!events) throw new Error('脚本事件用尽');
    return eventStream(events);
  }) as StreamFn;
}

/** 连接失败形态的流：第一个事件就是 error（真实 pi-ai 在 fetch 失败时不发 start） */
function errorFirstStream(msg: AssistantMessage): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'error', reason: 'error', error: msg } as AssistantMessageEvent;
    },
    result: async () => msg,
  } as unknown as AssistantMessageEventStream;
}

/** 测试里用到的工具声明：pi 只执行 transcript 里声明过的工具 */
const TEST_TOOLS: RunAgentOptions['tools'] = [
  { name: 'get_time', description: '报时', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'x', description: '占位', parameters: { type: 'object', properties: {} } },
];

function run(
  script: AssistantMessageEvent[][],
  over: Partial<RunAgentOptions> = {},
): { calls: TranscriptContext[]; execute: ReturnType<typeof vi.fn>; promise: ReturnType<typeof runPiAgent> } {
  const calls: TranscriptContext[] = [];
  const execute = vi.fn(async () => '工具结果');
  const promise = runPiAgent(
    {
      settings: SETTINGS,
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '你好' },
      ],
      tools: TEST_TOOLS,
      executeTool: execute,
      signal: new AbortController().signal,
      ...over,
    },
    { streamFn: scriptStream(script, calls) },
  );
  return { calls, execute, promise };
}

describe('runPiAgent（pi 引擎适配）', () => {
  it('文本直答：正文增量、最终消息、本地估算用量', async () => {
    const onDelta = vi.fn();
    const onAssistantMessage = vi.fn();
    const onUsage = vi.fn();
    const { promise } = run(
      [[textDelta('你'), textDelta('好呀'), done(piMsg([{ type: 'text', text: '你好呀' }], 'stop'))]],
      { onDelta, onAssistantMessage, onUsage },
    );
    await expect(promise).resolves.toEqual({ content: '你好呀' });
    expect(onDelta).toHaveBeenCalledWith('你');
    expect(onAssistantMessage).toHaveBeenCalledWith({ role: 'assistant', content: '你好呀' });
    const u = onUsage.mock.calls.at(-1)![0] as { estimated: boolean; promptTokens: number; completionTokens: number };
    expect(u.estimated).toBe(true);
    expect(u.promptTokens).toBeGreaterThan(0);
    expect(u.completionTokens).toBeGreaterThan(0);
  });

  it('工具往返：执行工具并把结果回填，最终回答返回', async () => {
    const onAssistantMessage = vi.fn();
    const { execute, promise } = run(
      [
        [done(piMsg([{ type: 'toolCall', id: 'c1', name: 'get_time', arguments: { city: '北京' } }], 'toolUse'))],
        [textDelta('现在 12 点'), done(piMsg([{ type: 'text', text: '现在 12 点' }], 'stop'))],
      ],
      { onAssistantMessage },
    );
    await expect(promise).resolves.toEqual({ content: '现在 12 点' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe('get_time');
    expect(JSON.parse(String(execute.mock.calls[0][1]))).toEqual({ city: '北京' });
    const first = onAssistantMessage.mock.calls[0][0] as Extract<WireMessage, { role: 'assistant' }>;
    expect(first.tool_calls?.[0]?.function.name).toBe('get_time');
    const second = onAssistantMessage.mock.calls[1][0] as Extract<WireMessage, { role: 'assistant' }>;
    expect(second.content).toBe('现在 12 点');
  });

  it('服务商报 usage 时原样透传（不标估算）', async () => {
    const onUsage = vi.fn();
    const { promise } = run(
      [[done(piMsg([{ type: 'text', text: '好' }], 'stop', { usage: { ...piUsage, input: 10, output: 5 } }))]],
      { onUsage },
    );
    await expect(promise).resolves.toEqual({ content: '好' });
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, estimated: false });
  });

  it('流式错误事件 → 抛错给面板展示', async () => {
    const { promise } = run([[{ type: 'error', reason: 'error', error: piMsg([], 'error', { errorMessage: '接口返回 401：key 不对' }) }]]);
    await expect(promise).rejects.toThrow(/401/);
  });

  it('用户中止 → 抛 AbortError（面板按「已停止」处理）', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { promise } = run([[done(piMsg([{ type: 'text', text: '好' }], 'stop'))]], { signal: ctrl.signal });
    await expect(promise).rejects.toSatisfy(isAbortError);
  });

  it('轮数上限：maxSteps 轮后阻断后续工具并抛出友好错误', async () => {
    const toolUse = [done(piMsg([{ type: 'toolCall', id: 'c1', name: 'x', arguments: {} }], 'toolUse'))];
    const { execute, promise } = run([toolUse, toolUse], { maxSteps: 1 });
    await expect(promise).rejects.toThrow(/轮数上限/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('思考过程增量映射到 onThinking', async () => {
    const onThinking = vi.fn();
    const { promise } = run(
      [[
        { type: 'thinking_delta', contentIndex: 0, delta: '想一想', partial: piMsg([{ type: 'thinking', thinking: '' }], 'stop') },
        done(piMsg([{ type: 'text', text: '答' }], 'stop')),
      ]],
      { onThinking },
    );
    await expect(promise).resolves.toEqual({ content: '答' });
    expect(onThinking).toHaveBeenCalledWith('想一想');
  });

  it('到达 maxSteps 前的正常多轮不受影响', async () => {
    const toolUse = [done(piMsg([{ type: 'toolCall', id: 'c1', name: 'x', arguments: {} }], 'toolUse'))];
    const { execute, promise } = run([toolUse, toolUse, [done(piMsg([{ type: 'text', text: '完成' }], 'stop'))]], { maxSteps: 2 });
    await expect(promise).resolves.toEqual({ content: '完成' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('连接期瞬时错误：首个事件是 5xx 时退避重试，重试成功整轮照常返回', async () => {
    let attempts = 0;
    const streamFn: StreamFn = (() => {
      attempts++;
      if (attempts === 1) return errorFirstStream(piMsg([], 'error', { errorMessage: '接口返回 502：Bad Gateway' }));
      return eventStream([done(piMsg([{ type: 'text', text: '恢复了' }], 'stop'))]);
    }) as StreamFn;
    const promise = runPiAgent(
      {
        settings: SETTINGS,
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
        tools: TEST_TOOLS,
        executeTool: async () => 'ok',
        signal: new AbortController().signal,
      },
      { streamFn, retryDelays: [0, 0] },
    );
    await expect(promise).resolves.toEqual({ content: '恢复了' });
    expect(attempts).toBe(2);
  });

  it('确定错误（401）不重试，直接抛给面板', async () => {
    let attempts = 0;
    const streamFn: StreamFn = (() => {
      attempts++;
      return errorFirstStream(piMsg([], 'error', { errorMessage: '接口返回 401：key 不对' }));
    }) as StreamFn;
    const promise = runPiAgent(
      {
        settings: SETTINGS,
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
        tools: TEST_TOOLS,
        executeTool: async () => 'ok',
        signal: new AbortController().signal,
      },
      { streamFn, retryDelays: [0, 0] },
    );
    await expect(promise).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  it('重试耗尽：连续瞬时错误超过上限后抛最后一个错误', async () => {
    let attempts = 0;
    const streamFn: StreamFn = (() => {
      attempts++;
      return errorFirstStream(piMsg([], 'error', { errorMessage: `接口返回 503（第 ${attempts} 次）` }));
    }) as StreamFn;
    const promise = runPiAgent(
      {
        settings: SETTINGS,
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
        tools: TEST_TOOLS,
        executeTool: async () => 'ok',
        signal: new AbortController().signal,
      },
      { streamFn, retryDelays: [0, 0] },
    );
    await expect(promise).rejects.toThrow(/第 3 次/);
    expect(attempts).toBe(3);
  });
});

describe('toPiMessages（wire → pi 回放）', () => {
  it('四类消息完整映射，toolResult 反查工具名', () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant', content: '好的',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_note', arguments: '{"path":"a.md"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '内容' },
    ];
    const msgs = toPiMessages(wire);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'sys' });
    expect(msgs[1]).toMatchObject({ role: 'user' });
    const assistant = msgs[2] as Extract<AgentMessage, { role: 'assistant' }>;
    expect(assistant.stopReason).toBe('toolUse');
    expect(assistant.content).toContainEqual({ type: 'text', text: '好的' });
    expect(assistant.content).toContainEqual(expect.objectContaining({ type: 'toolCall', id: 'c1', name: 'read_note' }));
    expect(msgs[3]).toMatchObject({ role: 'toolResult', toolCallId: 'c1', toolName: 'read_note', isError: false });
  });

  it('工具声明挂在开头 system 消息；没有 system 时插入空 system 承载', () => {
    const tool = { name: 't', label: 't', description: 'd', parameters: {}, execute: async () => ({ content: [], details: {} }) };
    const withSys = toPiMessages([{ role: 'user', content: 'x' }], [tool]);
    expect((withSys[0] as { toolsAdded?: unknown }).toolsAdded).toEqual([tool]);
    const without = toPiMessages([{ role: 'user', content: 'x' }]);
    expect(without[0]).toMatchObject({ role: 'user' });
  });
});
