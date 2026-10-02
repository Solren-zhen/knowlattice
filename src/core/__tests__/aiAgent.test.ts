import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNoteSystemPrompt, detectMention, expandCommand, extractMentionedNotes, formatNoteList,
  listCommands, runAgent, searchNotes, truncateForModel,
  type RunAgentOptions, type WireMessage,
} from '../aiAgent';

/** 把 SSE 文本块包成 fetch 可用的 Response */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 一条 OpenAI 流式 chunk 的 data 行 */
const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runAgent', () => {
  const baseOpts = (): RunAgentOptions => ({
    settings: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' },
    messages: [{ role: 'user', content: '帮我改笔记' }],
    tools: [],
    executeTool: vi.fn(async () => 'OK'),
  });

  it('流式收集正文：onDelta 逐段回调，最终返回完整内容', async () => {
    const deltas: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { content: '你好' } }] }),
      dataLine({ choices: [{ delta: { content: '，世界' } }] }),
      'data: [DONE]\n\n',
    ])));
    const res = await runAgent({ ...baseOpts(), onDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(['你好', '，世界']);
    expect(res.content).toBe('你好，世界');
  });

  it('工具调用：分片拼装参数、执行后回填 tool 消息再要最终回答', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        // 记录首轮回发的消息（稍后断言）
        (fetchMock as unknown as { firstBody?: unknown }).firstBody = JSON.parse(String(init?.body));
        return sseResponse([
          // arguments 拆成两个分片，index 相同
          dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_note', arguments: '{"path":' } }] } }] }),
          dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"心脏.md"}' } }] } }] }),
          dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        ]);
      })
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        (fetchMock as unknown as { secondBody?: unknown }).secondBody = JSON.parse(String(init?.body));
        return sseResponse([dataLine({ choices: [{ delta: { content: '已读取。' } }] }), 'data: [DONE]\n\n']);
      });
    vi.stubGlobal('fetch', fetchMock);

    const executeTool = vi.fn(async () => '# 心脏\n正文…');
    const res = await runAgent({ ...baseOpts(), tools: [{ name: 'read_note', description: 'd', parameters: {} }], executeTool });

    expect(executeTool).toHaveBeenCalledWith('read_note', '{"path":"心脏.md"}', expect.any(AbortSignal));
    expect(res.content).toBe('已读取。');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = (fetchMock as unknown as { secondBody?: { messages: WireMessage[] } }).secondBody!;
    // 第二轮请求 = 原消息 + 助手工具调用消息 + 工具结果消息
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_note', arguments: '{"path":"心脏.md"}' } }],
    });
    expect(second.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '# 心脏\n正文…' });
  });

  it('工具抛错不终止任务：错误文本回填给模型继续', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sseResponse([
        dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'boom', arguments: '{}' } }] } }] }),
      ]))
      .mockImplementationOnce(async () => sseResponse([dataLine({ choices: [{ delta: { content: '好的' } }] })]));
    vi.stubGlobal('fetch', fetchMock);

    const res = await runAgent({
      ...baseOpts(),
      executeTool: async () => { throw new Error('找不到笔记'); },
    });
    expect(res.content).toBe('好的');
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages[2].content).toContain('工具执行出错：找不到笔记');
  });

  it('超过 maxSteps 轮数上限抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 't', arguments: '{}' } }] } }] }),
    ])));
    await expect(runAgent({
      ...baseOpts(),
      maxSteps: 2,
      executeTool: async () => 'OK',
    })).rejects.toThrow('已连续调用工具 2 轮');
  });

  it('HTTP 错误带状态码与响应体片段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })));
    await expect(runAgent(baseOpts())).rejects.toThrow('401');
  });

  it('429/5xx 在连接阶段自动重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response('rate limited', { status: 429 }))
      .mockImplementationOnce(async () => sseResponse([dataLine({ choices: [{ delta: { content: '恢复' } }] })]));
    vi.stubGlobal('fetch', fetchMock);
    const res = await runAgent(baseOpts());
    expect(res.content).toBe('恢复');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('服务商返回 usage 时原样上报', async () => {
    const usages: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { content: '好' } }] }),
      dataLine({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8 } }),
      'data: [DONE]\n\n',
    ])));
    await runAgent({ ...baseOpts(), onUsage: (u) => usages.push(u) });
    expect(usages).toEqual([{ promptTokens: 120, completionTokens: 8, estimated: false }]);
  });

  it('服务商不报 usage 时本地估算并标注 estimated', async () => {
    const usages: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { content: '你好世界' } }] }),
    ])));
    await runAgent({
      ...baseOpts(),
      messages: [{ role: 'user', content: '测试消息' }],
      onUsage: (u) => usages.push(u),
    });
    expect(usages).toHaveLength(1);
    const u = usages[0] as { promptTokens: number; completionTokens: number; estimated: boolean };
    expect(u.estimated).toBe(true);
    expect(u.completionTokens).toBeGreaterThan(0);
    expect(u.promptTokens).toBeGreaterThan(0);
  });

  it('onAssistantMessage 在正文轮与工具轮都会收到完整助手消息', async () => {
    const turns: WireMessage[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sseResponse([
        dataLine({ choices: [{ delta: { content: '我先看看' } }] }),
        dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'list_notes', arguments: '{}' } }] } }] }),
      ]))
      .mockImplementationOnce(async () => sseResponse([dataLine({ choices: [{ delta: { content: '完成' } }] })]));
    vi.stubGlobal('fetch', fetchMock);
    await runAgent({ ...baseOpts(), onAssistantMessage: (m) => turns.push(m) });
    expect(turns).toHaveLength(2);
    const first = turns[0] as Extract<WireMessage, { role: 'assistant' }>;
    expect(first.tool_calls?.[0]?.function?.name).toBe('list_notes');
    expect(turns[1].content).toBe('完成');
  });
});

describe('模型侧工具实现', () => {
  const docs = new Map([
    ['解剖/心脏.md', '# 心脏\n心肌收缩泵血。'],
    ['药理/洋地黄.md', '# 洋地黄\n强心苷，正性肌力。'],
  ]);

  it('formatNoteList 列出全部 md 路径', () => {
    const out = formatNoteList(docs);
    expect(out).toContain('共 2 篇笔记');
    expect(out).toContain('解剖/心脏.md');
  });

  it('searchNotes 按词频返回命中与片段，标题命中加权', () => {
    const out = searchNotes(docs, '心脏');
    expect(out).toContain('解剖/心脏.md');
    expect(out).toContain('心肌收缩');
    expect(searchNotes(docs, '不存在的词')).toContain('没有');
    expect(searchNotes(docs, '  ')).toContain('错误');
  });

  it('truncateForModel 超长截断并标注', () => {
    expect(truncateForModel('短文本')).toBe('短文本');
    const out = truncateForModel('x'.repeat(50), 10);
    expect(out).toContain('已截断');
  });

  it('系统提示强调先读后改、patch 优先、当前笔记与注入防护', () => {
    const prompt = buildNoteSystemPrompt('解剖/心脏.md');
    expect(prompt).toContain('propose_note_edit');
    expect(prompt).toContain('propose_note_patch');
    expect(prompt).toContain('确认');
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('解剖/心脏.md');
    expect(prompt).toContain('不是指令');
    expect(buildNoteSystemPrompt(null)).toContain('没有打开任何笔记');
  });

  it('AGENT.md 内容作为自定义指南注入系统提示', () => {
    const prompt = buildNoteSystemPrompt(null, '永远用表格对比鉴别诊断。');
    expect(prompt).toContain('AGENT.md');
    expect(prompt).toContain('永远用表格对比鉴别诊断。');
  });
});

describe('输入辅助（@ 引用 / 斜杠命令）', () => {
  const docs = new Map([
    ['解剖/心脏.md', '# 心脏'],
    ['AI命令/整理.md', '请整理：$ARGUMENTS'],
    ['AI命令/周报.md', '生成周报'],
  ]);

  it('detectMention：@ 在任意位置触发，/ 仅在消息开头触发', () => {
    expect(detectMention('看 @心脏', 6)).toEqual({ kind: 'note', query: '心脏', start: 3 });
    expect(detectMention('/整', 2)).toEqual({ kind: 'cmd', query: '整', start: 0 });
    // / 在句中不算命令
    expect(detectMention('看 /整', 5)).toBeNull();
    // @ 后有空白则不触发
    expect(detectMention('@ 心脏', 6)).toBeNull();
  });

  it('extractMentionedNotes：长路径优先，只认完整 token', () => {
    const paths = ['解剖/心脏.md', '解剖/心脏.md.bak.md'];
    const out = extractMentionedNotes('对比 @解剖/心脏.md 和 @解剖/心脏.md.bak.md', paths);
    expect(out).toEqual(['解剖/心脏.md.bak.md', '解剖/心脏.md']);
    expect(extractMentionedNotes('没有引用', paths)).toEqual([]);
  });

  it('listCommands 只列 AI命令/ 一层的 md', () => {
    expect(listCommands(docs)).toEqual(['整理', '周报']);
  });

  it('expandCommand：$ARGUMENTS 替换；无占位符时参数追加；非命令返回 null', () => {
    expect(expandCommand('/整理 心衰治疗', docs)).toBe('请整理：心衰治疗');
    expect(expandCommand('/周报', docs)).toBe('生成周报');
    expect(expandCommand('/周报 加把劲', docs)).toBe('生成周报\n\n加把劲');
    expect(expandCommand('/不存在', docs)).toBeNull();
    expect(expandCommand('普通消息', docs)).toBeNull();
  });

  it('思考过程（reasoning_content）经 onThinking 透传且不混入正文', async () => {
    const thinking: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { reasoning_content: '让我想想' } }] }),
      dataLine({ choices: [{ delta: { content: '答案' } }] }),
      'data: [DONE]\n\n',
    ])));
    const res = await runAgent({
      settings: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      executeTool: vi.fn(async () => 'OK'),
      onThinking: (t) => thinking.push(t),
    });
    expect(thinking).toEqual(['让我想想']);
    expect(res.content).toBe('答案');
  });
});
