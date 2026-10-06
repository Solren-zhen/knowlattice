// @vitest-environment jsdom
/** AI 笔记助手审批流的 DOM 回归：应用 / 拒绝 / 漂移确认 / 重开面板 id 续接 / 过期提案。 */
import '@earendil-works/pi-agent-core';
import '@earendil-works/pi-ai/api/openai-completions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiAgentPanel from '../AiAgentPanel';
import type { WireMessage } from '../../core/aiAgent';
import { clearMistake, importMistakes } from '../../core/mistakes';
import { recordCalibration } from '../../core/qbankCalib';

/** 面板在 pi 引擎包加载失败时回退内置引擎。默认走真实 pi 路径，
 *  需要覆盖「内置引擎」时才把开关打开（两者对半截回答的处理不同）。 */
const piSwitch = vi.hoisted(() => ({ fail: false }));
vi.mock('../../core/piAgent', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/piAgent')>();
  return {
    ...real,
    runPiAgent: async (opts: Parameters<typeof real.runPiAgent>[0]) => {
      if (piSwitch.fail) throw new real.PiUnavailableError(new Error('test: pi 包加载失败'));
      return real.runPiAgent(opts);
    },
  };
});

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

/** 可控 SSE 流：测试自己决定何时吐 delta、何时断（流式跟随/半截回答/看门狗都用它） */
function heldStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let markReady!: () => void;
  const ready = new Promise<void>((res) => { markReady = res; });
  const make = async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        markReady();
        signal?.addEventListener('abort', () => {
          try { c.error(new DOMException('Aborted', 'AbortError')); } catch { /* 已关闭 */ }
        });
      },
    });
    return new Response(stream, { status: 200 });
  };
  return {
    make,
    ready,
    push: (text: string) => ctrl.enqueue(new TextEncoder().encode(dataLine({ choices: [{ delta: { content: text } }] }))),
    fail: (e: unknown) => ctrl.error(e),
  };
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
  const send = screen.queryByRole('button', { name: '发送' });
  if (send) {
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    return;
  }
  // 运行中按钮显示“停止”，回车仍会把输入追加到队列。
  const ta = screen.getByLabelText('对 AI 笔记说点什么');
  fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', shiftKey: false });
}

async function sendMessage(text: string) {
  const ta = screen.getByLabelText('对 AI 笔记说点什么') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  await clickSend();
  await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeTruthy(), { timeout: 3000 }).catch(() => {});
}

beforeEach(() => {
  localStorage.clear();
  seedSettings();
  piSwitch.fail = false;
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

  it('看门狗豁免：等用户确认提案超过阈值也不被当成连接卡死中止', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = stubFetch([
        async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '心肌收缩泵血，维持循环。')),
        async () => sseResponse(finalChunks('改好了。')),
      ]);
      const { onSave } = renderPanel();

      await sendMessage('把泵血那句补充一下');
      await screen.findByText(/修改笔记/, { selector: '.agent-proposal-head' });

      // 提案卡一直挂着没人点，时间推过看门狗阈值（120s）：任务必须还活着，卡片仍待裁决
      await vi.advanceTimersByTimeAsync(150_000);
      expect(screen.queryByText(/没有任何响应/)).toBeNull();
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '应用修改' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByText('改好了。')).toBeTruthy());
      void fetchMock;
    } finally {
      vi.useRealTimers();
    }
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

describe('AI patch 宽容匹配与写入可见化', () => {
  it('宽容匹配：find_text 带半角/全角标点差异（逐字 0 命中）仍能唯一定位并应用', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血,维持循环', '心肌舒张充盈，维持循环')),
      async () => sseResponse(finalChunks('改好了。')),
    ]);
    // 原文是全角逗号；模型给了半角逗号（逐字找不到）
    const docs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血，维持循环。\n']]);
    const onSave = vi.fn(async (p: string, c: string) => { docs.set(p, c); });
    render(<AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />);

    await sendMessage('把泵血那句改成舒张');
    await screen.findByText(/修改笔记/, { selector: '.agent-proposal-head' });
    fireEvent.click(await screen.findByRole('button', { name: '应用修改' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('解剖/心脏.md', '# 心脏\n心肌舒张充盈，维持循环。\n');
    void fetchMock;
  });

  it('宽容匹配失败：真找不到时模型收到报错，不弹卡', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心室里有一段不存在的原文', 'x')),
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
        const tool = body.messages.find((m) => m.role === 'tool');
        expect(tool?.content).toContain('没有找到（已尝试忽略空白与标点差异）');
        return sseResponse(finalChunks('我再找找。'));
      },
    ]);
    const { onSave } = renderPanel();

    await sendMessage('改一句不存在的');
    await waitFor(() => expect(screen.getByText('我再找找。')).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '应用修改' })).toBeNull();
    void fetchMock;
  });

  it('自动应用落盘时弹 toast，用户能看见笔记已被修改', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '自动应用的内容')),
      async () => sseResponse(finalChunks('第二轮结束。')),
    ]);
    const docs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n']]);
    const onSave = vi.fn(async (p: string, c: string) => { docs.set(p, c); });
    render(<AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '自动应用' }));
    await sendMessage('改一下');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const toastEl = document.querySelector('.mv-toast');
      expect(toastEl).toBeTruthy();
      expect(toastEl!.textContent).toContain('已自动应用对「解剖/心脏.md」的修改');
    });
    void fetchMock;
  });

  it('拒绝文案硬化：模型收到「同一提案不要再次提交」约束', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '被改写的内容')),
      async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
        const tool = body.messages.find((m) => m.role === 'tool');
        expect(tool?.content).toContain('同一提案不要再次提交（内容相同或近似都算重复）');
        return sseResponse(finalChunks('好的。'));
      },
    ]);
    const { onSave } = renderPanel();

    await sendMessage('随便改改');
    await screen.findByText(/修改笔记/, { selector: '.agent-proposal-head' });
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(screen.getByText('好的。')).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    void fetchMock;
  });
});

describe('Claudian 式交互', () => {
  /** 输入文本（带光标位置，触发 @ / 斜杠补全） */
  function typeInput(text: string) {
    const ta = screen.getByLabelText('对 AI 笔记说点什么') as HTMLTextAreaElement;
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
    expect((screen.getByLabelText('对 AI 笔记说点什么') as HTMLTextAreaElement).value).toBe('@解剖/心脏.md ');
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

    fireEvent.click(screen.getByRole('button', { name: '只读' }));
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

    fireEvent.click(screen.getByRole('button', { name: '自动应用' }));
    await sendMessage('改一下');
    // 没有点「应用修改」：提案直接被写入
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('✓ 已自动应用（历史版本可回溯）')).toBeTruthy();
    void fetchMock;
  });

  it('自主模式：新建笔记免确认直接写入，卡片标记已自动应用', async () => {
    localStorage.setItem('knowlattice-ai-agent-prefs', JSON.stringify({ readonly: false, autoApply: false, autonomous: true }));
    const fetchMock = stubFetch([
      async () => sseResponse([dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'n1', function: { name: 'propose_note_create', arguments: '{"path":"解剖/心包.md","content":"# 心包\\n浆膜包裹心脏。"}' } }] } }] })]),
      async () => sseResponse(finalChunks('新建完成。')),
    ]);
    const onSave = vi.fn(async () => {});
    render(<AiAgentPanel docs={BASE_DOCS} onSave={onSave} onClose={vi.fn()} />);

    await sendMessage('新建一篇心包笔记');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('解剖/心包.md', '# 心包\n浆膜包裹心脏。');
    expect(await screen.findByText('✓ 已自动应用（历史版本可回溯）')).toBeTruthy();
    void fetchMock;
  });

  it('提示键：propose_card_hints 出 diff 卡，应用后属性键插进小节标题后', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse([
        dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'h1', function: { name: 'propose_card_hints', arguments: '{"path":"解剖/心脏.md","heading":"泵血","keys":["定义","首选检查"]}' } }] } }] }),
      ]),
      async () => sseResponse(finalChunks('提示键补好了，复习卡正面会用到它们。')),
    ]);
    const docs = new Map([['解剖/心脏.md', '# 心脏\n## 泵血\n心肌收缩泵血。\n']]);
    const onSave = vi.fn(async () => {});
    render(<AiAgentPanel docs={docs} onSave={onSave} onClose={vi.fn()} />);

    await sendMessage('给泵血小节补提示键');
    fireEvent.click(await screen.findByRole('button', { name: '应用修改' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      '解剖/心脏.md',
      '# 心脏\n## 泵血\n- 定义: \n- 首选检查: \n\n心肌收缩泵血。\n',
    );
    await waitFor(() => expect(screen.getByText('提示键补好了，复习卡正面会用到它们。')).toBeTruthy());
    void fetchMock;
  });

  it('多轮历史：第二轮请求携带上一轮问答', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const fetchMock = stubFetch([
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('第一条回答。'));
      },
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('第二条回答。'));
      },
    ]);
    renderPanel();
    await sendMessage('第一条');
    await waitFor(() => expect(screen.getByText('第一条回答。')).toBeTruthy());
    await sendMessage('第二条');
    await waitFor(() => expect(screen.getByText('第二条回答。')).toBeTruthy());

    expect(bodies).toHaveLength(2);
    expect(bodies[0].messages).toHaveLength(2); // system + 当前消息
    expect(bodies[1].messages).toHaveLength(4); // system + 上一轮问答 + 当前消息
    expect(bodies[1].messages[1]).toEqual({ role: 'user', content: '第一条' });
    expect(bodies[1].messages[2]).toEqual({ role: 'assistant', content: '第一条回答。' });
    expect(bodies[1].messages[3]).toEqual({ role: 'user', content: '第二条' });
    void fetchMock;
  });

  it('空状态建议 chip：点击填入输入框并聚焦', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '费曼检验' }));
    const ta = screen.getByLabelText('对 AI 笔记说点什么') as HTMLTextAreaElement;
    expect(ta.value).toBe('/费曼 ');
    expect(document.activeElement).toBe(ta);
  });

  it('「问 AI」选段引用：chip 出现、随消息附进上下文、发送后清空、可手动移除', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const fetchMock = stubFetch([
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('围绕选段回答。'));
      },
    ]);
    const onQuoteConsumed = vi.fn();
    const view = render(
      <AiAgentPanel
        docs={BASE_DOCS}
        onSave={vi.fn(async () => {})}
        onClose={vi.fn()}
        quote={{ text: '心肌收缩泵血。', path: '解剖/心脏.md' }}
        onQuoteConsumed={onQuoteConsumed}
      />
    );

    // 引用 chip 出现（来源 + 选段预览），并已通知 Workspace 清桥接状态
    expect(await screen.findByRole('status', { name: '已附加选段' })).toBeTruthy();
    expect(screen.getByText('来自 解剖/心脏.md')).toBeTruthy();
    expect(onQuoteConsumed).toHaveBeenCalled();

    // 发送：wire 消息带选段原文与来源路径
    await sendMessage('这段话什么意思？');
    const userWire = bodies[0].messages.find((m) => m.role === 'user');
    expect(userWire?.content).toContain('【用户选中的原文】');
    expect(userWire?.content).toContain('（来自：解剖/心脏.md）');
    expect(userWire?.content).toContain('心肌收缩泵血。');
    expect(userWire?.content).toContain('（用户的问题针对上面这段选中的原文');

    // 发送后 chip 消失，发出的用户气泡带引用块
    await waitFor(() => expect(screen.getByText('围绕选段回答。')).toBeTruthy());
    expect(screen.queryByRole('status', { name: '已附加选段' })).toBeNull();
    expect(screen.getAllByText('心肌收缩泵血。').length).toBeGreaterThan(0);
    expect(view.container.querySelector('.agent-quote-in-msg')).toBeTruthy();

    // 手动移除：再注入一条 quote，点 × 后 chip 消失且不再发送
    view.rerender(
      <AiAgentPanel
        docs={BASE_DOCS}
        onSave={vi.fn(async () => {})}
        onClose={vi.fn()}
        quote={{ text: '第二段选区', path: null }}
        onQuoteConsumed={onQuoteConsumed}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '移除引用' }));
    expect(screen.queryByRole('status', { name: '已附加选段' })).toBeNull();
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
    expect(await screen.findByText('第二条', { selector: '.agent-queued-text' })).toBeTruthy();

    resolveFirst(sseResponse(finalChunks('第一条完成。')));
    await waitFor(() => expect(screen.getByText('第二条完成。')).toBeTruthy());
    expect(screen.getByText('第一条完成。')).toBeTruthy();
    expect(document.querySelector('.agent-queued')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    void fetchMock;
  });

  it('排队续跑的历史快照：接续轮携带上一轮末尾的问答（itemsRef 同步维护）', async () => {
    let resolveFirst!: (r: Response) => void;
    const first = new Promise<Response>((res) => { resolveFirst = res; });
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const fetchMock = stubFetch([
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return first;
      },
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('第二条完成。'));
      },
    ]);
    renderPanel();

    await sendMessage('第一条');
    await sendMessage('第二条');
    expect(await screen.findByText('第二条', { selector: '.agent-queued-text' })).toBeTruthy();

    resolveFirst(sseResponse(finalChunks('第一条完成。')));
    await waitFor(() => expect(screen.getByText('第二条完成。')).toBeTruthy());

    // 第二轮请求必须带上第一轮的问答（排队接续发生在 effect 同步快照之前）
    const second = bodies[1];
    expect(second.messages.map((m) => [m.role, m.content])).toContainEqual(['user', '第一条']);
    expect(second.messages.map((m) => [m.role, m.content])).toContainEqual(['assistant', '第一条完成。']);
    void fetchMock;
  });

  it('点停止：排队消息退回输入框，本轮结束后不再自动补发', async () => {
    let resolveFirst!: (r: Response) => void;
    const first = new Promise<Response>((res) => { resolveFirst = res; });
    const fetchMock = stubFetch([async () => first]);
    renderPanel();

    await sendMessage('第一条');
    await sendMessage('第二条');
    expect(await screen.findByText('第二条', { selector: '.agent-queued-text' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    // 队列清空，且消息没有丢：退回输入框等用户自己决定
    expect(document.querySelector('.agent-queued')).toBeNull();
    expect((screen.getByLabelText('对 AI 笔记说点什么') as HTMLTextAreaElement).value).toBe('第二条');

    resolveFirst(sseResponse(finalChunks('第一条完成。')));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    // 停止就是不要继续跑：不会在下一轮静默补发第二条
    expect(fetchMock).toHaveBeenCalledTimes(1);
    void fetchMock;
  });
});

describe('流式输出与视口', () => {
  it('用户上翻回看时，流式输出不会把视口拽回底部；贴回底部后恢复跟随', async () => {
    const held = heldStream();
    const fetchMock = stubFetch([held.make]);
    const { view } = renderPanel();
    await sendMessage('讲讲心脏');
    await held.ready;

    const log = view.container.querySelector('.agent-log') as HTMLDivElement;
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true });

    // 上翻到顶部回看：不跟随
    log.scrollTop = 0;
    fireEvent.scroll(log);
    held.push('第一段');
    await screen.findByText(/第一段/);
    expect(log.scrollTop).toBe(0);

    // 贴回底部：恢复跟随
    log.scrollTop = 900;
    fireEvent.scroll(log);
    held.push('第二段');
    await waitFor(() => expect(log.scrollTop).toBe(1000));

    held.fail(new DOMException('Aborted', 'AbortError'));
    void fetchMock;
  });

  it('中途停止：已流出的正文不丢，落成一条标注未写完的消息', async () => {
    // 内置引擎（pi 包不可用时的回退）在中断时不会自己把半截回答落成消息，靠面板兜住
    piSwitch.fail = true;
    const held = heldStream();
    const fetchMock = stubFetch([held.make]);
    renderPanel();
    await sendMessage('讲讲心脏');
    await held.ready;

    held.push('心脏是肌性器官');
    await screen.findByText(/心脏是肌性器官/);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    expect(await screen.findByText('（已停止，以上为未写完的回答）')).toBeTruthy();
    // 正文走 Preview（markdown-it 懒加载），渲染完成才算保住
    await waitFor(() => expect(screen.getAllByText(/心脏是肌性器官/).length).toBeGreaterThan(0));
    void fetchMock;
  });
});

describe('同一轮多处写入', () => {
  it('自主模式下同一轮连续两处 patch：第二处基于第一处写入后的正文，不会把第一处覆盖掉', async () => {
    localStorage.setItem('knowlattice-ai-agent-prefs', JSON.stringify({ readonly: false, autoApply: false, autonomous: true }));
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('p1', '心肌收缩泵血。', '心肌收缩泵血，维持循环。')),
      async () => sseResponse(patchCallChunks('p2', '瓣膜防止倒流。', '瓣膜防止血液倒流。')),
      async () => sseResponse(finalChunks('两处都改好了。')),
    ]);
    const saved: Array<[string, string]> = [];
    const docs = new Map([['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n瓣膜防止倒流。\n']]);
    renderPanel({ docs, onSave: async (p, c) => { saved.push([p, c]); } });

    await sendMessage('这两句都补一下');
    await waitFor(() => expect(saved).toHaveLength(2));
    // 第二处必须建立在第一处已落盘的正文上（docsRef 同步推进），否则第一处被静默覆盖
    expect(saved[0][1]).toBe('# 心脏\n心肌收缩泵血，维持循环。\n瓣膜防止倒流。\n');
    expect(saved[1][1]).toBe('# 心脏\n心肌收缩泵血，维持循环。\n瓣膜防止血液倒流。\n');
    void fetchMock;
  });
});

describe('上下文预算 / 引用核验 / 面板细节', () => {
  it('内置引擎：单条工具结果超限被截断，累计超预算的更早结果被省略', async () => {
    piSwitch.fail = true; // 走内置引擎（pi 路径的同一套预算由 core/aiBudget 提供）
    const big = `# 心脏\n${'心'.repeat(20_000)}`;
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const calls = [1, 2, 3, 4, 5, 6].map((n) => ({
      index: n - 1, id: `r${n}`, function: { name: 'read_note', arguments: '{"path":"解剖/心脏.md"}' },
    }));
    const fetchMock = stubFetch([
      async () => sseResponse([dataLine({ choices: [{ delta: { tool_calls: calls } }] })]),
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('读完了。'));
      },
    ]);
    renderPanel({ docs: new Map([['解剖/心脏.md', big]]) });

    await sendMessage('把这六段都读一遍');
    await waitFor(() => expect(bodies).toHaveLength(1));

    const tools = bodies[0].messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(6);
    // 单条：read_note 的 12000 字上限之上再裁到 8000，并写明截断
    expect(tools[5].content!.length).toBeLessThanOrEqual(8_000);
    expect(tools[5].content).toContain('已截断');
    // 累计：6 × 8000 超预算，最旧的换成占位说明
    expect(tools[0].content).toContain('已省略');
    void fetchMock;
  });

  it('引用核验：给出原文的标记逐字核验，没给原文的标记如实标为无法核验', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(finalChunks('据“心肌收缩泵血。”〔《心脏》 P1〕可知。另见〔《内科学》 P20〕。')),
    ]);
    renderPanel();

    await sendMessage('讲讲心脏');
    await waitFor(() => expect(document.querySelectorAll('.agent-cite')).toHaveLength(2));
    expect(document.querySelector('.agent-cite-exact')?.textContent).toContain('心肌收缩泵血。');
    expect(document.querySelector('.agent-cite-nocite')?.textContent).toContain('未给出原文');
    void fetchMock;
  });

  it('同一书名命中多篇时标「多处」，不假装唯一溯源', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(finalChunks('据“心肌收缩泵血。”〔《心脏》 P1〕可知。')),
    ]);
    renderPanel({
      docs: new Map([
        ['心脏.md', '# 心脏\n心肌收缩泵血。\n'],
        ['解剖/心脏.md', '# 心脏\n心肌收缩泵血。\n'],
      ]),
    });

    await sendMessage('讲讲心脏');
    const chip = await waitFor(() => {
      const el = document.querySelector('.agent-cite-multi');
      if (!el) throw new Error('还没有「多处命中」的徽标');
      return el;
    });
    expect(chip.textContent).toContain('· 2 处');
    expect(chip.getAttribute('title')).toContain('出处不唯一');
    void fetchMock;
  });

  it('学习状态工具：模型拿到的是带错因分布与把握度校准的真实报告', async () => {
    piSwitch.fail = true; // 内置引擎：工具结果直接进 messages，便于断言模型可见载荷
    importMistakes({
      '解剖/心脏.md': {
        path: '解剖/心脏.md', chapter: '生理学', title: '心脏', count: 2, lastFailedAt: Date.now(), reason: 'confusion',
      },
    });
    recordCalibration(4, true);
    recordCalibration(4, false);
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const toolCalls = [
      { index: 0, id: 'r1', function: { name: 'get_weak_chapters', arguments: '{}' } },
      { index: 1, id: 'r2', function: { name: 'get_study_summary', arguments: '{}' } },
    ];
    const fetchMock = stubFetch([
      async () => sseResponse([dataLine({ choices: [{ delta: { tool_calls: toolCalls } }] })]),
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(finalChunks('看完了。'));
      },
    ]);
    renderPanel();

    await sendMessage('我错在哪、状态如何');
    await waitFor(() => expect(bodies).toHaveLength(1));

    const tools = bodies[0].messages.filter((m) => m.role === 'tool');
    const weak = tools.find((m) => m.content?.includes('错因分布'));
    const summary = tools.find((m) => m.content?.includes('把握度校准'));
    expect(weak?.content).toContain('错因分布（已标注 1 条）：知识没记住 0、概念混淆 1');
    expect(summary?.content).toContain('平均自信 80%、实际答对 50%');
    clearMistake('解剖/心脏.md');
    localStorage.removeItem('knowlattice-qcalib');
    void fetchMock;
  });

  it('流式期间 agent-log 标为 busy，结束后恢复', async () => {
    const held = heldStream();
    const fetchMock = stubFetch([held.make]);
    const { view } = renderPanel();
    await sendMessage('讲讲心脏');
    await held.ready;

    const busy = () => view.container.querySelector('.agent-log')!.getAttribute('aria-busy');
    expect(busy()).toBe('true');
    held.fail(new DOMException('Aborted', 'AbortError'));
    await waitFor(() => expect(busy()).toBe('false'));
    void fetchMock;
  });

  it('删除会话：有内容时先确认，取消则保留', async () => {
    const fetchMock = stubFetch([async () => sseResponse(finalChunks('第一条回答。'))]);
    renderPanel();
    await sendMessage('你好');
    await waitFor(() => expect(screen.getByText('第一条回答。')).toBeTruthy());

    // 需要有第二个会话，删除按钮才可用；切回有内容的那个
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    const firstId = (JSON.parse(localStorage.getItem(SESSIONS_KEY)!) as Array<{ id: string }>)[0].id;
    fireEvent.change(screen.getByLabelText('切换会话'), { target: { value: firstId } });

    const ids = () => (JSON.parse(localStorage.getItem(SESSIONS_KEY)!) as Array<{ id: string }>).map((s) => s.id);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '删除当前会话' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(ids()).toContain(firstId);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '删除当前会话' }));
    expect(ids()).not.toContain(firstId);
    confirmSpy.mockRestore();
    void fetchMock;
  });

  it('提案卡片渲染 diff 行（删除行与新增行）', async () => {
    const fetchMock = stubFetch([
      async () => sseResponse(patchCallChunks('c1', '心肌收缩泵血。', '心肌收缩泵血，维持循环。')),
      async () => sseResponse(finalChunks('改好了。')),
    ]);
    renderPanel();

    await sendMessage('改一下');
    await screen.findByText(/修改笔记/, { selector: '.agent-proposal-head' });
    const box = document.querySelector('.agent-diff')!;
    expect(box.querySelector('.agent-diff-add')?.textContent).toContain('心肌收缩泵血，维持循环。');
    expect(box.querySelector('.agent-diff-del')?.textContent).toContain('心肌收缩泵血。');
    void fetchMock;
  });

  it('停顿看门狗：流长时间没有任何事件时自动中止并给出可行动的提示', async () => {
    // shouldAdvanceTime：假时钟跟着真实时间走，RTL 的 waitFor 才不会卡住
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const held = heldStream();
      const fetchMock = stubFetch([held.make]);
      renderPanel();
      await sendMessage('讲讲心脏');
      await held.ready;

      // 面板阈值 120s（STALL_IDLE_MS）；推到 126s 让看门狗中止
      await vi.advanceTimersByTimeAsync(126_000);
      expect(await screen.findByText(/没有任何响应/)).toBeTruthy();
      void fetchMock;
    } finally {
      vi.useRealTimers();
    }
  });
});
