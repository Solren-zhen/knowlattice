/**
 * pi agent 接入层（@earendil-works/pi-agent-core + @earendil-works/pi-ai）：
 * - Agent 类负责工具调用循环：状态与事件流、串行工具执行、轮数守护
 * - 传输用 pi-ai 的 openai-completions 实现（官方 openai SDK，动态 import 分包）
 * - 对视图层暴露与 aiAgent.runAgent 相同的回调契约：换引擎不改面板
 * - 中转站兼容：固定保守 compat（system 角色、不发送 store / reasoning_effort、
 *   max_tokens 字段名），适配 Ollama / vLLM / 各类中转
 * - pi 相关运行时全部走动态 import：主包零增量，首次对话时才加载
 */
import {
  estimateTokens, isAbortError,
  type AgentSettings, type RunAgentOptions, type RunAgentResult, type WireMessage,
} from './aiAgent';
import { TOOL_RESULT_TOTAL_LIMIT, capToolResult } from './aiBudget';

type AssistantWire = Extract<WireMessage, { role: 'assistant' }>;
type AgentTool = import('@earendil-works/pi-agent-core').AgentTool;
type AgentMessage = import('@earendil-works/pi-agent-core').AgentMessage;
type StreamFn = import('@earendil-works/pi-agent-core').StreamFn;
type AssistantMessage = import('@earendil-works/pi-ai').AssistantMessage;
type AssistantMessageEvent = import('@earendil-works/pi-ai').AssistantMessageEvent;
type AssistantMessageEventStream = import('@earendil-works/pi-ai').AssistantMessageEventStream;
type Model = import('@earendil-works/pi-ai').Model<'openai-completions'>;
type ToolCall = import('@earendil-works/pi-ai').ToolCall;
type TSchema = import('@earendil-works/pi-ai').TSchema;
/** pi transcript 里的工具结果消息与其文本块（从 AgentMessage 派生，不额外引入包依赖） */
type PiToolResult = Extract<AgentMessage, { role: 'toolResult' }>;
type PiTextBlock = Extract<PiToolResult['content'][number], { type: 'text' }>;

const PROVIDER_ID = 'knowlattice-relay';

/**
 * 连接阶段失败最多重试 2 次（429/5xx/网络错误）；
 * 已开始收流后不再重试（重放会重复内容）。
 */
const RETRY_DELAYS_MS = [1_000, 3_000];

/** 可重试的瞬时错误特征：传输层 + 限流/过载/超时；401/403/404 等确定性问题不重试 */
const TRANSIENT_RE = /failed to fetch|load failed|networkerror|network error|err_connection|err_network|err_internet|connection refused|connection reset|net::|\b429\b|\b5\d{2}\b|rate limit|too many requests|overloaded|timeout|socket hang up/i;

/** pi 引擎包（动态 import）加载失败：面板据此回退内置引擎 */
export class PiUnavailableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('pi 引擎加载失败');
    this.name = 'PiUnavailableError';
    this.cause = cause;
  }
}

function isTransientError(text: unknown): boolean {
  return typeof text === 'string' && TRANSIENT_RE.test(text);
}

/** 可中断的退避延时；signal 已中止时立即抛 AbortError */
async function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** 中转站 / 本地服务的保守兼容位（Ollama、vLLM 同款），见 pi-ai README「OpenAI Compatibility Settings」 */
const RELAY_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsFinishReason: false,
  maxTokensField: 'max_tokens',
} as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST };

/** 由用户设置构造 pi 模型对象（Models 是可序列化的普通数据） */
export function relayModel(settings: AgentSettings): Model {
  return {
    id: settings.model,
    name: settings.model,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { ...ZERO_COST },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { ...RELAY_COMPAT },
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** tool_call_id → 工具名（WireMessage 的 tool 消息不带名字，回放 toolResult 需要） */
function toolNames(messages: WireMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  }
  return names;
}

/**
 * WireMessage[] → pi AgentMessage[]（回放历史用）。
 * 工具声明挂在最前面的 system 消息上（toolsAdded）：pi 的循环每轮会把
 * 状态里的工具与 transcript 声明的工具做 diff，不挂上去就会额外插一条
 * 「工具变更」system 消息，既费 token 也让 wire 断言变得嘈杂。
 */
export function toPiMessages(messages: WireMessage[], tools?: AgentTool[]): AgentMessage[] {
  const names = toolNames(messages);
  const list: AgentMessage[] = messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: m.content, timestamp: Date.now() };
    if (m.role === 'user') {
      // 用户消息保持字符串：openai-completions 会原样发送，content 保持字符串
      return { role: 'user', content: m.content, timestamp: Date.now() };
    }
    if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? []) {
        content.push({
          type: 'toolCall', id: c.id, name: c.function.name,
          arguments: safeParse(c.function.arguments) as ToolCall['arguments'],
        });
      }
      return {
        role: 'assistant', content, api: 'openai-completions', provider: PROVIDER_ID,
        model: '', usage: { ...ZERO_USAGE, cost: { ...ZERO_COST } },
        stopReason: m.tool_calls?.length ? 'toolUse' : 'stop', timestamp: Date.now(),
      };
    }
    return {
      role: 'toolResult', toolCallId: m.tool_call_id, toolName: names.get(m.tool_call_id) ?? 'unknown',
      content: [{ type: 'text', text: m.content }], isError: false, timestamp: Date.now(),
    };
  });
  if (tools?.length) {
    const head = list[0];
    if (head?.role === 'system') head.toolsAdded = tools;
    else list.unshift({ role: 'system', content: '', toolsAdded: tools, timestamp: Date.now() });
  }
  return list;
}

/**
 * 累计预算边界那一条至少要留这么长，否则直接换成占位说明（留几百字没意义）；
 * 与 aiBudget 内部的 MIN_KEEP 同口径。
 */
const PI_TRIM_MIN_KEEP = 600;

function isPiTextBlock(b: unknown): b is PiTextBlock {
  return !!b && typeof b === 'object'
    && (b as PiTextBlock).type === 'text' && typeof (b as PiTextBlock).text === 'string';
}

/**
 * pi 的整轮上下文预算：与内置引擎 aiBudget.trimToolResults 同一口径。
 * 从最新往回累加工具结果的文本长度，超预算的更早结果换成占位说明（模型可重新调用工具取回）。
 *
 * 两道闸：单条上限在工具结果回填 transcript 前生效（见 runPiAgent 的工具包装），
 * 累计上限在每次请求模型前生效（runPiAgent 把它接在 transformContext 上）。
 *
 * 纯函数：不修改入参；畸形消息（role 不认识 / content 不是数组 / 块不是文本）一律跳过，不抛异常。
 */
export function trimPiToolResults(
  messages: AgentMessage[],
  totalLimit = TOOL_RESULT_TOTAL_LIMIT,
): AgentMessage[] {
  let used = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as Partial<PiToolResult> | undefined;
    if (!m || typeof m !== 'object' || m.role !== 'toolResult' || !Array.isArray(m.content)) continue;
    const blocks = m.content;
    let size = 0;
    for (const b of blocks) if (isPiTextBlock(b)) size += b.text.length;
    if (used + size <= totalLimit) {
      used += size;
      continue;
    }
    const room = totalLimit - used;
    const text = room >= PI_TRIM_MIN_KEEP
      ? capToolResult(blocks.filter(isPiTextBlock).map((b) => b.text).join('\n'), room)
      : `【较早的工具结果已省略：原 ${size} 字，超出本轮上下文预算。需要时请重新调用工具取回。】`;
    // 多个文本块合并成一条；图片等非文本块原样保留
    let placed = false;
    const next: PiToolResult['content'] = [];
    for (const b of blocks) {
      if (!isPiTextBlock(b)) { next.push(b); continue; }
      if (!placed) { next.push({ type: 'text', text }); placed = true; }
    }
    used = totalLimit;
    out[i] = { ...(out[i] as PiToolResult), content: next };
  }
  return out;
}

/** pi 助手消息 → 面板渲染用的 wire 助手消息 */
function fromPiAssistant(m: AssistantMessage): AssistantWire {
  let content = '';
  const tool_calls: AssistantWire['tool_calls'] = [];
  for (const block of m.content) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'toolCall') {
      tool_calls.push({
        id: block.id, type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      });
    }
  }
  return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) };
}

/**
 * 把「窥探出的首个事件」塞回流的前面：pi 消费流有两个口（for await 迭代 + result()），
 * 包装必须两头都保真，否则 agent-loop 拿不到最终消息。
 */
function streamWithReplayedFirst(
  stream: AssistantMessageEventStream,
  first: IteratorResult<AssistantMessageEvent>,
): AssistantMessageEventStream {
  const it = stream[Symbol.asyncIterator]();
  let firstSent = false;
  const wrapped = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (!firstSent) { firstSent = true; return Promise.resolve(first); }
          return it.next();
        },
        return: (v?: unknown) => it.return?.(v as never) ?? Promise.resolve({ done: true as const, value: undefined }),
      };
    },
    result: () => stream.result(),
  };
  return wrapped as AssistantMessageEventStream;
}

/**
 * 连接阶段重试包装：建流抛出、或首个事件就是「可重试错误」时退避重试；
 * 一旦流开始产出内容（start/正文/思考），后续错误一律原样透传——中途重放会重复内容。
 * 重试只发生在当前这次模型调用上，此前轮次的工具结果已在 transcript 里，不受影响。
 */
async function streamWithRetry(
  streamFn: StreamFn,
  model: Model,
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  signal: AbortSignal,
  delays: readonly number[],
): Promise<AssistantMessageEventStream> {
  for (let attempt = 0; ; attempt++) {
    let stream: AssistantMessageEventStream;
    try {
      stream = await streamFn(model, context, options);
    } catch (e) {
      if (isAbortError(e) || attempt >= delays.length) throw e;
      await retryDelay(delays[attempt], signal);
      continue;
    }
    const it = stream[Symbol.asyncIterator]();
    let first: IteratorResult<AssistantMessageEvent>;
    try {
      first = await it.next();
    } catch (e) {
      if (isAbortError(e) || attempt >= delays.length) throw e;
      await retryDelay(delays[attempt], signal);
      continue;
    }
    const ev = first.done ? undefined : first.value;
    if (
      !first.done && ev?.type === 'error' && ev.reason === 'error'
      && isTransientError(ev.error?.errorMessage) && attempt < delays.length
    ) {
      await retryDelay(delays[attempt], signal);
      continue;
    }
    if (first.done) return stream;
    return streamWithReplayedFirst(stream, first);
  }
}

export interface PiAgentDeps {
  /** 测试注入假流；默认动态加载 pi-ai 的 openai-completions（官方 openai SDK 单独分包） */
  streamFn?: StreamFn;
  /** 连接阶段重试的退避间隔（ms），测试可传 [0, 0] 收窄 */
  retryDelays?: readonly number[];
}

/**
 * 与 aiAgent.runAgent 等价的 pi 引擎实现：
 * 每次 send 构造一个 pi Agent（无状态），continue/prompt 驱动循环，
 * 事件流映射到 onDelta / onThinking / onAssistantMessage / onUsage 回调。
 */
export async function runPiAgent(o: RunAgentOptions, deps: PiAgentDeps = {}): Promise<RunAgentResult> {
  type PiCore = typeof import('@earendil-works/pi-agent-core');
  type PiAi = typeof import('@earendil-works/pi-ai');
  let core: PiCore;
  let piAi: PiAi;
  try {
    [core, piAi] = await Promise.all([
      import('@earendil-works/pi-agent-core'),
      import('@earendil-works/pi-ai'),
    ]);
  } catch (e) {
    throw new PiUnavailableError(e);
  }
  const { Agent } = core;
  const { Type } = piAi;

  const model = relayModel(o.settings);
  const maxSteps = o.maxSteps ?? 16;
  const signal = o.signal ?? new AbortController().signal;

  const baseStreamFn: StreamFn = deps.streamFn ?? ((m, ctx, opts) =>
    import('@earendil-works/pi-ai/api/openai-completions').then((api) =>
      api.streamSimple(m as Model, ctx, {
        ...opts,
        // 空 Key 补哨兵：pi-ai 缺 key 会直接抛「No API key for provider」，
        // 而本项目支持无需 Key 的本地/中转端点（Ollama、vLLM，设置面板写的就是
        // 「本地服务可留空」）。真正需要鉴权的服务会回 401——可读、可行动，
        // 不被引擎前置拦截。内置引擎 runAgent 本就不带 Authorization 头，语义一致。
        apiKey: o.settings.apiKey.trim() || 'unused',
        signal: opts?.signal ?? signal,
      }),
    ));
  const delays = deps.retryDelays ?? RETRY_DELAYS_MS;
  const streamFn: StreamFn = (m, ctx, opts) =>
    streamWithRetry(baseStreamFn, m as Model, ctx, opts, signal, delays);

  const piTools: AgentTool[] = o.tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: Type.Unsafe(t.parameters as TSchema),
    execute: async (_toolCallId, params, toolSignal) => {
      const text = await o.executeTool(t.name, JSON.stringify(params ?? {}), toolSignal ?? signal);
      // 单条上限（与内置引擎同口径）：长笔记 / 多段教材原文在回填 transcript 前先截断，
      // 免得一次工具调用就把上下文撑爆；累计上限由 transformContext 在每次请求前兜底。
      return { content: [{ type: 'text', text: capToolResult(text) }], details: {} };
    },
  }));

  let toolRounds = 0;
  let capHit = false;
  let runError: string | null = null;
  let runAborted = false;
  let finalText = '';
  const promptParts: string[] = [];
  const completionParts: string[] = [];
  for (const m of o.messages) {
    promptParts.push(
      m.role === 'assistant'
        ? (m.content ?? '') + (m.tool_calls ?? []).map((c) => c.function.arguments).join('')
        : m.content,
    );
  }

  const all = toPiMessages(o.messages, piTools);
  const tail = all[all.length - 1];
  const tailIsUser = tail?.role === 'user';
  const agent = new Agent({
    initialState: { model, tools: piTools, messages: tailIsUser ? all.slice(0, -1) : all },
    streamFn,
    toolExecution: 'sequential',
    // 累计上限（与内置引擎同口径）：每次请求模型前把更早的工具结果换成占位说明。
    // pi 契约要求该钩子不得抛出，故整段 try/catch，任何异常都原样返回 messages。
    transformContext: async (messages) => {
      try {
        return trimPiToolResults(messages);
      } catch {
        return messages;
      }
    },
    beforeToolCall: async () => {
      if (toolRounds < maxSteps) return undefined;
      capHit = true;
      return { block: true, reason: `已达单次任务的工具调用轮数上限（${maxSteps}）`, terminate: true };
    },
  });

  const onOuterAbort = () => agent.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') o.onDelta?.(e.delta);
        else if (e.type === 'thinking_delta') o.onThinking?.(e.delta);
        break;
      }
      case 'message_end': {
        const m = event.message;
        if (m.role !== 'assistant') break;
        if (m.stopReason === 'error') runError ??= m.errorMessage || '模型返回错误';
        if (m.stopReason === 'aborted') runAborted = true;
        if (m.stopReason === 'stop' || m.stopReason === 'length') {
          finalText = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        }
        for (const block of m.content) {
          const text = block.type === 'text'
            ? block.text
            : block.type === 'toolCall' ? JSON.stringify(block.arguments ?? {}) : block.thinking;
          completionParts.push(text);
          promptParts.push(text);
        }
        o.onAssistantMessage?.(fromPiAssistant(m));
        if (m.usage && (m.usage.input > 0 || m.usage.output > 0)) {
          o.onUsage?.({ promptTokens: m.usage.input, completionTokens: m.usage.output, estimated: false });
        } else {
          // 服务商没报 usage（如 Ollama）：按消息与产出估个大概，界面标注 ≈
          o.onUsage?.({
            promptTokens: estimateTokens(promptParts.join('\n')),
            completionTokens: estimateTokens(completionParts.join('\n')),
            estimated: true,
          });
        }
        break;
      }
      case 'turn_end':
        if (event.message.role === 'assistant' && event.message.stopReason === 'toolUse') toolRounds++;
        break;
      case 'tool_execution_end': {
        const texts = ('result' in event ? event.result?.content : undefined) ?? [];
        for (const block of texts) {
          if (block.type === 'text') promptParts.push(block.text);
        }
        break;
      }
      default:
        break;
    }
  });

  try {
    // 尾部 user 消息以字符串内容直接 prompt：content 为字符串
    if (tailIsUser && tail) await agent.prompt(tail);
    else await agent.continue();
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onOuterAbort);
  }

  if (signal.aborted || runAborted) {
    // 面板以 AbortError 识别「用户停止」：pi 的中止是正常落定，这里统一抛出
    throw new DOMException('Aborted', 'AbortError');
  }
  if (capHit) {
    throw new Error(`已连续调用工具 ${maxSteps} 轮仍未完成（达到轮数上限），已停止。请把任务拆小一点再试。`);
  }
  if (runError) throw new Error(runError);
  return { content: finalText };
}

export { isAbortError };
