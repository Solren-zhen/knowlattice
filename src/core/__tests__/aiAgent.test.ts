import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentNetHint,
  buildHistoryMessages, buildNoteSystemPrompt, detectMention, expandCommand, extractMentionedNotes, formatNoteList,
  listCommands, queryFragments, runAgent, searchNotes, truncateForModel,
  type RunAgentOptions, type WireMessage,
} from '../aiAgent';
import { BUILTIN_AI_COMMANDS } from '../aiCommands';

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

  it('服务商不回 tool_call id 时生成回退 id，tool 消息与之对应', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sseResponse([
        // 注意：delta 里没有 id 字段
        dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_note', arguments: '{"path":"a.md"}' } }] } }] }),
      ]))
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        (fetchMock as unknown as { secondBody?: unknown }).secondBody = JSON.parse(String(init?.body));
        return sseResponse([dataLine({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]\n\n']);
      });
    vi.stubGlobal('fetch', fetchMock);
    await runAgent({ ...baseOpts(), tools: [{ name: 'read_note', description: 'd', parameters: {} }] });
    const second = (fetchMock as unknown as { secondBody?: { messages: WireMessage[] } }).secondBody!;
    const asst = second.messages[1] as Extract<WireMessage, { role: 'assistant' }>;
    const callId = asst.tool_calls?.[0]?.id;
    expect(callId).toBeTruthy();
    expect((second.messages[2] as Extract<WireMessage, { role: 'tool' }>).tool_call_id).toBe(callId);
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

  it('searchNotes 支持空格分隔的多关键词（需同时命中）', () => {
    expect(searchNotes(docs, '心脏 泵血')).toContain('解剖/心脏.md');
    // 两个词分属两篇笔记：没有一篇同时命中
    expect(searchNotes(docs, '心脏 强心苷')).toContain('没有');
  });

  it('searchNotes 中文长词按相邻两字滑窗部分召回，覆盖率不足不召回', () => {
    expect(queryFragments('洋地黄中毒')).toEqual(['洋地', '地黄', '黄中', '中毒']);
    // 5 字 → 4 片段需 ≥2 命中：「洋地黄类药」命中 洋地/地黄 → 召回（旧逻辑整体匹配为零命中）
    expect(searchNotes(docs, '洋地黄类药')).toContain('药理/洋地黄.md');
    // 「泵血洋地黄」：心脏.md 只命中 泵血 1 片段 < 2 → 不召回
    expect(searchNotes(docs, '泵血洋地黄')).not.toContain('解剖/心脏.md');
  });

  it('queryFragments 短词与混合段落', () => {
    expect(queryFragments('房颤')).toEqual(['房颤']);
    expect(queryFragments('hcm')).toEqual(['hcm']);
    expect(queryFragments('心a')).toEqual(['心', 'a']);
  });

  it('searchNotes 接入等价词表：搜「心梗」能召回「心肌梗死」，搜「房颤」不受影响', () => {
    const med = new Map([
      ['解剖/心脏.md', '# 心脏\n心肌收缩泵血。'],
      ['解剖/心肌梗死.md', '# 心肌梗死\n心肌缺血坏死，心梗。'],
    ]);
    expect(searchNotes(med, '心梗')).toContain('解剖/心肌梗死.md');
    expect(searchNotes(med, '房颤')).toContain('没有');
  });

  it('searchNotes 长笔记定位到小节并带出页码', () => {
    const content = `<!--kb:P3-->\n## 第二节 检查\n${'检查内容。'.repeat(900)}`;
    const med = new Map([['教材/内科学.md', content]]);
    const out = searchNotes(med, '检查内容');
    expect(out).toContain('教材/内科学.md §第二节 检查 (P3)');
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

  it('系统提示含导师化准则：先反问、双链、收敛考点、不确定要声明', () => {
    const prompt = buildNoteSystemPrompt(null);
    expect(prompt).toContain('学习陪练');
    expect(prompt).toContain('反问');
    expect(prompt).toContain('[[双链]]');
    expect(prompt).toContain('出题自测');
    expect(prompt).toContain('不确定');
  });

  it('AGENT.md 内容作为自定义指南注入系统提示', () => {
    const prompt = buildNoteSystemPrompt(null, '永远用表格对比鉴别诊断。');
    expect(prompt).toContain('AGENT.md');
    expect(prompt).toContain('永远用表格对比鉴别诊断。');
  });
});

describe('agentNetHint', () => {
  it('openai SDK 的 Connection error. 也要给出跨域/不可达指引', () => {
    // pi 引擎走官方 openai SDK，网络失败时只抛这句（core/error.js 的 APIConnectionError）
    const out = agentNetHint(new Error('Connection error.'));
    expect(out).toContain('请求没能发出去');
    expect(out).toContain('Connection error.');
  });

  it('undici 的 fetch failed 与浏览器措辞同样归类为传输失败', () => {
    expect(agentNetHint(new Error('fetch failed'))).toContain('请求没能发出去');
    expect(agentNetHint(new Error('TypeError: Failed to fetch'))).toContain('请求没能发出去');
    expect(agentNetHint(new Error('net::ERR_CONNECTION_REFUSED'))).toContain('请求没能发出去');
  });

  it('业务错误原样透传，不被误判成网络问题', () => {
    expect(agentNetHint(new Error('接口返回 401：invalid api key'))).toBe('接口返回 401：invalid api key');
    expect(agentNetHint(new Error('No API key for provider: knowlattice-relay'))).toBe('No API key for provider: knowlattice-relay');
  });

  it('用户主动中止不提示网络排查', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(agentNetHint(abort)).toBe('The operation was aborted.');
  });
});

describe('buildHistoryMessages', () => {
  const u = (text: string) => ({ role: 'user' as const, text });
  const a = (text: string) => ({ role: 'assistant' as const, text });

  it('按时间顺序映射为 wire 消息；空历史返回空数组', () => {
    expect(buildHistoryMessages([u('你好'), a('你好！'), u('继续')])).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '继续' },
    ]);
    expect(buildHistoryMessages([])).toEqual([]);
  });

  it('超出预算从最旧开始丢，至少保留最新一条', () => {
    const turns = [u('a'.repeat(100)), a('b'.repeat(100)), u('c'.repeat(100))];
    expect(buildHistoryMessages(turns, 150)).toEqual([
      { role: 'user', content: 'c'.repeat(100) },
    ]);
  });

  it('单条超长按 msgCap 截断并标注', () => {
    const out = buildHistoryMessages([u('x'.repeat(50))], 10_000, 10) as Array<{ content: string }>;
    expect(out).toHaveLength(1);
    expect(out[0].content.startsWith('x'.repeat(10))).toBe(true);
    expect(out[0].content).toContain('已截断');
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

  it('listCommands 合并库内命令与内置模板，库内同名不重复', () => {
    const cmds = listCommands(docs);
    expect(cmds).toContain('整理');
    expect(cmds).toContain('周报');
    for (const name of Object.keys(BUILTIN_AI_COMMANDS)) expect(cmds).toContain(name);
    expect(cmds.filter((c) => c === '整理')).toHaveLength(1);
    expect(cmds).toHaveLength(new Set(cmds).size);
  });

  it('expandCommand：$ARGUMENTS 替换；无占位符时参数追加；非命令返回 null', () => {
    expect(expandCommand('/整理 心衰治疗', docs)).toBe('请整理：心衰治疗');
    expect(expandCommand('/周报', docs)).toBe('生成周报');
    expect(expandCommand('/周报 加把劲', docs)).toBe('生成周报\n\n加把劲');
    expect(expandCommand('/不存在', docs)).toBeNull();
    expect(expandCommand('普通消息', docs)).toBeNull();
  });

  it('expandCommand：库内没有的命令用内置模板，参数追加在模板后', () => {
    const out = expandCommand('/出题 房颤的心电图诊断', docs)!;
    expect(out).toContain('自测题');
    expect(out.endsWith('房颤的心电图诊断')).toBe(true);
    // 库内同名命令覆盖内置模板
    const override = new Map([...docs, ['AI命令/出题.md', '我的自定义出题模板']]);
    expect(expandCommand('/出题 心脏', override)).toContain('我的自定义出题模板');
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
