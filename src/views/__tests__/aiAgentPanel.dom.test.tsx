// @vitest-environment jsdom
/** AI 笔记助手审批流的 DOM 回归：应用 / 拒绝 / 漂移确认 / 重开面板 id 续接 / 过期提案。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiAgentPanel from '../AiAgentPanel';
import type { WireMessage } from '../../core/aiAgent';

const SETTINGS_KEY = 'knowlattice-ai-agent-settings';
const SESSIONS_KEY = 'knowlattice-ai-agent-sessions';

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

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** 一轮 propose_note_patch 工具调用的流式响应（参数分两片） */
const patchCallChunks = (id: string, find: string, replace: string) => [
  dataLine({ choices: [{ delta: { content: '我来做定点修改。' } }] }),
  dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'propose_note_patch', arguments: `{"path":"解剖/心脏.md","find_text":"${find}","replace_text":"${replace}` } }] } }] }),
  dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] }),
];

/** 二轮最终回答 */
const finalChunks = (text: string) => [dataLine({ choices: [{ delta: { content: text } }] }), 'data: [DONE]\n\n'];

type FetchScript = Array<(url: string, init?: RequestInit) => Promise<Response>>;

function stubFetch(script: FetchScript): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  script.forEach((impl) => mock.mockImplementationOnce(impl));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const BASE_DOCS = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n']]);

function seedSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    baseUrl: 'http://mock.local/v1', apiKey: 'sk-test', model: 'mock',
  }));
}

function renderPanel(over: { docs?: Map<string, string>; onSave?: (p: string, c: string) => Promise<void> } = {}) {
  const onSave = over.onSave ?? vi.fn(async () => {});
  const view = render(
    <AiAgentPanel
      docs={over.docs ?? BASE_DOCS}
      onSave={onSave}
      onClose={vi.fn()}
    />
  );
  return { onSave, view };
}

/** 等发送按钮可用再点：fireEvent.change 后 React 提交与点击之间没有真实用户那样的时间差 */
async function clickSend() {
  await waitFor(() => {
    const btn = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
  await clickSend();
}

async function sendMessage(text: string) {
  const ta = screen.getByLabelText('对 AI 笔记助手说点什么') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  await clickSend();
  await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeTruthy(), { timeout: 3000 }).catch(() => {});
}

beforeEach(() => {
  localStorage.clear();
  seedSettings();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AI 笔记助手审批流', () => {
  it('应用：diff 卡出现 → 点应用 → onSave 调用、卡片转已应用、模型收到写入结果', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '心肌收缩泵血，维持循环。')),
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
        const tool = body.messages.find((m) => m.role === 'tool');
        expect(tool?.content).toContain('已把修改写入');
        return sseResponse(finalChunks('改好了。'));
      },
    ]);
    const { onSave } = renderPanel();

    await sendMessage('把泵血那句补充一下');
    await screen.findByText(/修改笔记/, { selector: ".agent-proposal-head" });
    fireEvent.click(await screen.findByRole('button', { name: '应用修改' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('解剖/心脏.md', '# 心脏\n心肌收缩泵血，维持循环。\n');
    await waitFor(() => expect(screen.getByText('改好了。')).toBeTruthy());
    expect(screen.getByText(/已应用，可在历史版本中回溯/)).toBeTruthy();
    // 会话已持久化
    expect(JSON.parse(localStorage.getItem(SESSIONS_KEY)!)[0].items).toHaveLength(4);
    void fetchMock;
  });

  it('拒绝：onSave 不被调用，模型收到拒绝提示', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '被改写的内容')),
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
        const tool = body.messages.find((m) => m.role === 'tool');
        expect(tool?.content).toContain('用户拒绝了这次修改');
        return sseResponse(finalChunks('好的，那先不动。'));
      },
    ]);
    const { onSave } = renderPanel();

    await sendMessage('随便改改');
    await screen.findByText(/修改笔记/, { selector: ".agent-proposal-head" });
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => expect(screen.getByText('好的，那先不动。')).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('已拒绝')).toBeTruthy();
    void fetchMock;
  });

  it('漂移确认：提案期间笔记被改 → 应用先出覆盖警告 → 仍要覆盖才写入', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '替换后的句子')),
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
        const tool = body.messages.find((m) => m.role === 'tool');
        expect(tool?.content).toContain('已把修改写入');
        return sseResponse(finalChunks('覆盖完成。'));
      },
    ]);
    const changedDocs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。用户手改的一行。\n']]);
    const { onSave, view } = renderPanel();

    await sendMessage('改一下');
    await screen.findByText(/修改笔记/, { selector: ".agent-proposal-head" });
    // 模拟用户此时在编辑器里改了笔记（换引用触发 useEffect 更新 docsRef）
    view.rerender(
      <AiAgentPanel docs={changedDocs} onSave={onSave} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }));

    // 第一次应用被拦截：出现覆盖警告，而不是直接写入
    expect(await screen.findByText(/笔记在提案后被你改动过/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '仍要覆盖' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/已应用，可在历史版本中回溯/)).toBeTruthy();
    void fetchMock;
  });

  it('重开面板 id 续接：第二轮拒绝不会误改第一轮已应用的卡片', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '第一轮的修改')),
      async () => sseResponse(finalChunks('第一轮完成。')),
      async () => sseResponse(patchCallChunks('c2', '第一轮的修改', '第二轮的修改')),
      async () => sseResponse(finalChunks('第二轮结束。')),
    ]);
    // onSave 真正写回 docs（同一 Map 实例），第二轮的锚文本才找得到
    const docs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n']]);
    const onSave = vi.fn(async (p: string, c: string) => { docs.set(p, c); });

    render(<AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />);
    await sendMessage('第一轮');
    fireEvent.click(await screen.findByRole('button', { name: '应用修改' }));
    await waitFor(() => expect(screen.getByText(/已应用，可在历史版本中回溯/)).toBeTruthy());
    cleanup();

    // 重开：从 localStorage 恢复会话，再跑一轮拒绝
    render(<AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />);
    await sendMessage('第二轮');
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(screen.getByText('第二轮结束。')).toBeTruthy());

    const states = screen.getAllByText((_, el) => el?.classList.contains('agent-proposal-state') ?? false);
    expect(states).toHaveLength(2);
    expect(states[0].textContent).toContain('已应用');
    expect(states[1].textContent).toContain('已拒绝');
    expect(onSave).toHaveBeenCalledTimes(1);
    void fetchMock;
  });

  it('遗留的 pending 提案恢复后标记过期，不再显示审批按钮', async () => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([{
      id: 's1', title: '旧会话', updatedAt: Date.now(),
      usage: { promptTokens: 0, completionTokens: 0, estimated: false },
      items: [
        { kind: 'msg', id: 1, role: 'user', text: '之前的消息' },
        { kind: 'msg', id: 2, role: 'assistant', text: '之前的回复' },
        { kind: 'proposal', id: 3, path: '解剖/心脏.md', old: 'a', next: 'b', isNew: false, status: 'pending' },
      ],
    }]));

    renderPanel();
    expect(await screen.findByText('（上次会话的提案，未应用）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '应用修改' })).toBeNull();
  });
});

describe('Claudian 式交互', () => {
  /** 输入文本（带光标位置，触发 @ / 斜杠补全） */
  function typeInput(text: string) {
    const ta = screen.getByLabelText('对 AI 笔记助手说点什么') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
    return ta;
  }

  /** 读取第一轮请求体（断言 wire 消息用） */
  async function firstBody(mock: { mock: { calls: unknown[][] } }) {
    const init = mock.mock.calls[0][1] as RequestInit;
    return JSON.parse(String(init.body)) as { messages: Array<{ role: string; content?: string }>; tools?: Array<{ function: { name: string } }> };
  }

  it('@ 引用：下拉选择后发送，笔记全文附进消息', async () => {
    const fetchMock = stubFetch([async () => sseResponse(finalChunks('好的，看到了。'))]);
    renderPanel();

    typeInput('@心');
    fireEvent.mouseDown(await screen.findByRole('option', { name: '@ 解剖/心脏.md' }));
    expect((screen.getByLabelText('对 AI 笔记助手说点什么') as HTMLTextAreaElement).value).toBe('@解剖/心脏.md ');
    await clickSend();

    await waitFor(() => expect(screen.getByText('好的，看到了。')).toBeTruthy());
    const body = await firstBody(fetchMock);
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('@解剖/心脏.md');
    expect(userMsg?.content).toContain('【用户引用的笔记】');
    expect(userMsg?.content).toContain('# 心脏');
  });

  it('斜杠命令：带参数发送时展开命令笔记（$ARGUMENTS 替换）', async () => {
    const fetchMock = stubFetch([async () => sseResponse(finalChunks('整理好了。'))]);
    renderPanel({ docs: new Map([
      ...BASE_DOCS,
      ['AI命令/整理.md', '请整理：$ARGUMENTS'],
    ]) });

    // /整 触发补全；带参数后 Enter 直接发送（发送时展开），不走模板选择
    typeInput('/整');
    expect(await screen.findByRole('option', { name: '/ 整理' })).toBeTruthy();
    typeInput('/整理 心衰治疗');
    await clickSend();

    await waitFor(() => expect(screen.getByText('整理好了。')).toBeTruthy());
    const body = await firstBody(fetchMock);
    expect(body.messages.find((m) => m.role === 'user')?.content).toBe('请整理：心衰治疗');
  });

  it('只读模式：请求不带写入工具，系统提示注明只读', async () => {
    const fetchMock = stubFetch([async () => sseResponse(finalChunks('只读回答。'))]);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '🔒 只读' }));
    await sendMessage('帮我看看');
    await waitFor(() => expect(screen.getByText('只读回答。')).toBeTruthy());

    const body = await firstBody(fetchMock);
    const names = (body.tools ?? []).map((t) => t.function.name);
    expect(names).toContain('read_note');
    expect(names.some((n) => n.startsWith('propose_'))).toBe(false);
    expect(body.messages[0].content).toContain('只读模式');
  });

  it('自动应用：patch 跳过确认直接写入，卡片标记已自动应用', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '自动应用的内容')),
      async () => sseResponse(finalChunks('第二轮结束。')),
    ]);
    const docs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n']]);
    const onSave = vi.fn(async (p: string, c: string) => { docs.set(p, c); });
    render(
      <AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: '⚡ 自动应用' }));
    await sendMessage('改一下');
    // 没有点「应用修改」：提案直接被写入
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('✓ 已自动应用（历史版本可回溯）')).toBeTruthy();
    void fetchMock;
  });

  it('运行中发送的消息排队，上一轮结束后自动接续', async () => {
    let resolveFirst!: (r: Response) => void;
    const first = new Promise<Response>((res) => { resolveFirst = res; });
    const fetchMock = stubFetch([
      async () => first,
      async () => sseResponse(finalChunks('第二条完成。')),
    ]);
    renderPanel();

    await sendMessage('第一条');
    await sendMessage('第二条');
    expect(await screen.findByText(/⏳ 第二条/)).toBeTruthy();

    resolveFirst(sseResponse(finalChunks('第一条完成。')));
    await waitFor(() => expect(screen.getByText('第二条完成。')).toBeTruthy());
    expect(screen.getByText('第一条完成。')).toBeTruthy();
    expect(screen.queryByText(/⏳ 第二条/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    void fetchMock;
  });
});
