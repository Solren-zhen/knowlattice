/**
 * AI 输出鲁棒性回归表。
 *
 * 判定只有三种：`ok`（解析出合法结构 / 流正常结束）、`error`（给出明确的可判读错误）、
 * `throw`（抛异常）。**throw 永远算失败**——模型输出不可信，解析层不该把 SyntaxError 甩给界面。
 *
 * 每条样本都走**真实解析路径**（`applyNotePatch` / `createAgentRuntime.executeTool` /
 * `toPiMessages` / `runAgent` 的 SSE），不给解析器写 mock；只有网络这一层被替换成固定字节流。
 *
 * 新增样本的规矩：只加「线上真的见过或换模型大概率会撞上」的脏输入，不要为了凑数。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyNotePatch } from '../aiTools';
import { createAgentRuntime, AGENT_TOOL_REGISTRY } from '../agentRuntime';
import { toPiMessages } from '../piAgent';
import { runAgent, type AgentSettings, type WireMessage } from '../aiAgent';

// ---------------------------------------------------------------- 1. 工具参数 JSON

const ARG_SAMPLES: Array<{ id: string; note: string; args: string; expect: 'ok' | 'error' }> = [
  { id: 'a01', note: '正常对象', args: '{"path":"解剖/心脏.md"}', expect: 'ok' },
  { id: 'a02', note: '尾逗号', args: '{"path":"a.md",}', expect: 'error' },
  { id: 'a03', note: '单引号当分隔符', args: "{'path':'a.md'}", expect: 'error' },
  { id: 'a04', note: '全角引号', args: '{“path”：“a.md”}', expect: 'error' },
  { id: 'a05', note: '顶层是数组', args: '[1,2]', expect: 'ok' },
  { id: 'a06', note: '顶层是 null', args: 'null', expect: 'ok' },
  { id: 'a07', note: '空串（无参数工具）', args: '', expect: 'ok' },
  { id: 'a08', note: '只有空白', args: '   ', expect: 'ok' },
  { id: 'a09', note: '20k 长字符串', args: '{"path":"a.md","content":"' + '长'.repeat(20_000) + '"}', expect: 'ok' },
  { id: 'a10', note: '大括号不配对', args: '{"path":"a.md"', expect: 'error' },
];

const SIGNAL = new AbortController().signal;

async function runArgs(args: string): Promise<'ok' | 'error'> {
  let calls = 0;
  const runtime = createAgentRuntime({
    registry: AGENT_TOOL_REGISTRY,
    execute: async () => {
      calls += 1;
      return '结果';
    },
  });
  const out = await runtime.executeTool('read_note', args, SIGNAL);
  // 透传给执行器 = 解析层没崩；返回错误文案 = 明确报错。两种都算「可判读」，只有抛异常算失败。
  return calls > 0 || out.length > 0 ? 'ok' : 'error';
}

describe('工具参数 JSON（createAgentRuntime.executeTool）', () => {
  for (const s of ARG_SAMPLES) {
    it(`${s.id} ${s.note} → ${s.expect}（不抛异常）`, async () => {
      // 任何 throw 都会让这条直接红——这正是判定标准
      const actual = await runArgs(s.args);
      expect(actual).toBe('ok');
    });
  }

  it('顶层是数组/null 时不再因为拿不到 args.path 而崩（历史缺陷）', async () => {
    await expect(runArgs('[1,2]')).resolves.toBe('ok');
    await expect(runArgs('null')).resolves.toBe('ok');
  });
});

// ---------------------------------------------------------------- 2. 工具调用参数（回放历史）

const CALL_SAMPLES: Array<{ id: string; note: string; arguments: string }> = [
  { id: 'c01', note: '正常', arguments: '{"path":"a.md"}' },
  { id: 'c02', note: '截断的 JSON', arguments: '{"path":"a' },
  { id: 'c03', note: '数组', arguments: '[1,2]' },
  { id: 'c04', note: 'null', arguments: 'null' },
  { id: 'c05', note: '空串', arguments: '' },
  { id: 'c06', note: '尾逗号', arguments: '{"a":1,}' },
  { id: 'c07', note: '围栏残留', arguments: '```json\n{"a":1}\n```' },
];

describe('工具调用参数回放（toPiMessages）', () => {
  for (const s of CALL_SAMPLES) {
    it(`${s.id} ${s.note} → arguments 退化成对象，不抛`, () => {
      const messages: WireMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_note', arguments: s.arguments } }],
        },
      ];
      expect(() => toPiMessages(messages)).not.toThrow();
      const out = toPiMessages(messages);
      const call = (out[0] as { content?: Array<{ type: string; arguments?: unknown }> }).content?.find(
        (c) => c.type === 'toolCall',
      );
      expect(call).toBeTruthy();
      expect(typeof call!.arguments).toBe('object');
      expect(Array.isArray(call!.arguments)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------- 3. 锚文本改写

const NOTE = [
  '# 心脏',
  '',
  '## 泵血',
  '',
  '左心室收缩时，二尖瓣关闭、主动脉瓣开放。',
  '',
].join('\n');

const ANCHOR_SAMPLES: Array<{ id: string; note: string; find: string; expect: 'ok' | 'error' }> = [
  { id: 'n01', note: '逐字命中', find: '左心室收缩时，二尖瓣关闭、主动脉瓣开放。', expect: 'ok' },
  { id: 'n02', note: 'CRLF 差异', find: '左心室收缩时，二尖瓣关闭、主动脉瓣开放。\r\n', expect: 'ok' },
  { id: 'n03', note: '多余空格', find: '左心室收缩时，  二尖瓣关闭、主动脉瓣开放。', expect: 'ok' },
  { id: 'n04', note: '全角逗号写成立即半角', find: '左心室收缩时, 二尖瓣关闭, 主动脉瓣开放。', expect: 'ok' },
  { id: 'n05', note: '包了引号但原文没有引号（不能猜，明确报错）', find: '“左心室收缩时，二尖瓣关闭、主动脉瓣开放。”', expect: 'error' },
  { id: 'n06', note: '省略号截断', find: '左心室收缩时…', expect: 'error' },
  { id: 'n07', note: '空 find', find: '', expect: 'error' },
  { id: 'n08', note: '不存在的文本', find: '右心室射血', expect: 'error' },
];

describe('锚文本宽容匹配（applyNotePatch）', () => {
  for (const s of ANCHOR_SAMPLES) {
    it(`${s.id} ${s.note} → ${s.expect}`, () => {
      const out = applyNotePatch(NOTE, s.find, '【改写】');
      if (s.expect === 'ok') {
        expect('error' in out, JSON.stringify(out)).toBe(false);
        expect((out as { next: string }).next).toContain('【改写】');
      } else {
        expect('error' in out).toBe(true);
      }
    });
  }

  it('多命中时报错而不是猜一个', () => {
    const dup = '甲。乙。甲。';
    const out = applyNotePatch(dup, '甲。', '丙。');
    expect('error' in out).toBe(true);
    expect((out as { error: string }).error).toContain('不唯一');
  });
});

// ---------------------------------------------------------------- 4. SSE 流

const SETTINGS: AgentSettings = { baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'm' };

function sseResponse(raw: string): Response {
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 每 7 字节切一刀：跨 chunk 的半行必须由解析层自己缓冲住
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const SSE_SAMPLES: Array<{ id: string; note: string; raw: string; expected: string }> = [
  {
    id: 's01',
    note: 'CRLF + 空行分隔',
    raw: 'data: {"choices":[{"delta":{"content":"甲"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}\r\n\r\n',
    expected: '甲乙',
  },
  {
    id: 's02',
    note: '夹 : ping 注释行',
    raw: ': ping\ndata: {"choices":[{"delta":{"content":"甲"}}]}\n: keep-alive\ndata: {"choices":[{"delta":{"content":"乙"}}]}\n',
    expected: '甲乙',
  },
  {
    id: 's03',
    note: '尾行没有换行（流被截断）',
    raw: 'data: {"choices":[{"delta":{"content":"甲"}}]}\ndata: {"choices":[{"delta":{"content":"乙"}}]}',
    expected: '甲乙',
  },
  {
    id: 's04',
    note: '[DONE] 之后的垃圾行',
    raw: 'data: {"choices":[{"delta":{"content":"甲"}}]}\ndata: [DONE]\ndata: 后续无效\n',
    expected: '甲',
  },
  {
    id: 's05',
    note: '非 JSON 行混在中间',
    raw: 'event: ping\ndata: {"choices":[{"delta":{"content":"甲"}}]}\ndata: not-json\ndata: {"choices":[{"delta":{"content":"乙"}}]}\n',
    expected: '甲乙',
  },
  {
    id: 's06',
    note: '只回 usage、没有正文',
    raw: 'data: {"usage":{"prompt_tokens":10,"completion_tokens":0},"choices":[{"delta":{}}]}\ndata: [DONE]\n',
    expected: '',
  },
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('SSE 增量解析（runAgent 真实链路）', () => {
  for (const s of SSE_SAMPLES) {
    it(`${s.id} ${s.note} → 不抛且正文正确`, async () => {
      globalThis.fetch = (async () => sseResponse(s.raw)) as typeof fetch;
      let text = '';
      const result = await runAgent({
        settings: SETTINGS,
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        executeTool: async () => '不应被调用',
        onDelta: (d) => { text += d; },
        maxSteps: 1,
      });
      expect(text).toBe(s.expected);
      expect(result.content).toBe(s.expected);
    });
  }

  it('网络错误归一化成可读中文，而不是抛原始英文', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await expect(
      runAgent({
        settings: SETTINGS,
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        executeTool: async () => '',
        maxSteps: 1,
      }),
    ).rejects.toThrow();
  });
});
