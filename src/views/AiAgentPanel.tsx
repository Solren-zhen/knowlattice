/**
 * AI 笔记助手（对标 Obsidian 的 Claudian 插件）：
 * - 侧栏多会话对话，agent 可用工具检索笔记（列目录 / 搜索 / 读取）
 * - 修改以 diff 卡片呈现：「应用」后才经 vault.save 落盘（自动进历史版本）；
 *   应用前若发现笔记已被用户改过，先弹覆盖确认再动手；「自动应用」开关可让
 *   定点替换（patch）跳过确认——整篇重写与新建永远要确认
 * - Claudian 式交互：@路径 引用笔记（附内容进上下文）、/斜杠命令（AI命令/ 目录
 *   下的笔记，$ARGUMENTS 传参）、AGENT.md 自定义指南（对应 CLAUDE.md）、只读模式、
 *   运行中消息排队、推理模型思考过程展示
 * - 模型走 OpenAI 兼容协议，地址 / Key / 模型名由用户配置（小米 MiMo / DeepSeek /
 *   智谱 / Kimi / OpenRouter / Ollama 均可），配置与会话只存本机 localStorage
 */
import { useEffect, useRef, useState } from 'react';
import {
  buildNoteSystemPrompt, detectMention, expandCommand, extractMentionedNotes, formatNoteList,
  isAbortError, listCommands, NOTE_AGENT_TOOLS, runAgent, searchNotes, truncateForModel,
  type AgentSettings, type MentionHit, type TokenUsage, type WireMessage,
} from '../core/aiAgent';
import { collapseDiff, diffLines, type CollapsedRow } from '../core/aiDiff';
import { safeVaultPath } from '../core/vault';
import { useEsc, escThenClose } from './useEsc';
import { IconClose, IconTrash } from './icons';
import Preview from './Preview';

interface Props {
  onClose: () => void;
  /** 全库笔记（path → Markdown），随 vault 更新换引用 */
  docs: Map<string, string>;
  /** 写入笔记（含新建）：走 vault.save，自动记历史版本 */
  onSave: (path: string, content: string) => Promise<void>;
  /** 应用修改 / 点双链后可一键打开对应笔记 */
  onOpenPath?: (path: string) => void;
  /** 当前打开的笔记路径：注入 system prompt，让「当前这篇」这类说法可用 */
  currentPath?: string | null;
  /** 双链名 → vault 路径：助手消息里的 [[链接]] 据此渲染与跳转 */
  resolveLink?: (name: string) => string | null;
}

/** 常见 OpenAI 兼容入口；模型名以服务商控制台为准，可改 */
const PRESETS = [
  { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: '', hint: '每日有免费 token 额度；模型名以 mimo.mi.com 文档/控制台为准' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', hint: '' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: '' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2', hint: '' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hint: '可访问 Claude 等海外模型，模型名填 provider/model' },
  { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: '', hint: '无需 Key；需以 OLLAMA_ORIGINS=* 启动以放行跨域' },
];

const SETTINGS_KEY = 'knowlattice-ai-agent-settings';
const SESSIONS_KEY = 'knowlattice-ai-agent-sessions';
const PREFS_KEY = 'knowlattice-ai-agent-prefs';
/** 旧版单线程对话的存储键：首次加载时迁移进会话列表 */
const OLD_CHAT_KEY = 'knowlattice-ai-agent-chat';
const SESSIONS_LIMIT = 20;
/** 持久化总体积上限：超了从最旧会话开始丢（当前会话保底不动） */
const SESSIONS_STORE_LIMIT = 600_000;
const PERSIST_CONTENT_LIMIT = 4_000;
/** 斜杠命令与 AGENT.md 的约定位置 */
const CMD_DIR = 'AI命令/';
const AGENT_MD = 'AGENT.md';
/** 引用笔记附进上下文时的单篇截断 */
const MENTION_CONTENT_LIMIT = 8_000;

type Decision = 'applied' | 'rejected';

type ChatItem =
  | { kind: 'msg'; id: number; role: 'user' | 'assistant'; text: string }
  /** 已完成的只读工具：一行摘要 + 可展开的原始结果 */
  | { kind: 'tool'; id: number; name: string; summary: string; detail: string }
  /** 推理模型的思考过程（折叠展示，不回传给模型） */
  | { kind: 'thinking'; id: number; text: string }
  /** 写入提案：diff + 应用 / 拒绝；drifted = 笔记在提案后被用户改过，应用需二次确认 */
  | {
      kind: 'proposal'; id: number; path: string; old: string; next: string;
      isNew: boolean;
      status: 'pending' | 'applied' | 'rejected' | 'stale' | 'failed';
      /** 自动应用（「自动应用」开关 + patch 且未漂移） */
      autoApplied?: boolean;
      drifted?: boolean;
      /** status = failed 时的写入错误信息 */
      error?: string;
    }
  | { kind: 'error'; id: number; text: string };

interface SessionUsage { promptTokens: number; completionTokens: number; estimated: boolean }

interface AgentPrefs { readonly: boolean; autoApply: boolean }

interface AgentSession {
  id: string;
  title: string;
  updatedAt: number;
  usage: SessionUsage;
  items: ChatItem[];
}

const ZERO_USAGE: SessionUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
const DEFAULT_PREFS: AgentPrefs = { readonly: false, autoApply: false };

/** 只读模式下只保留检索类工具 */
const READONLY_TOOLS = NOTE_AGENT_TOOLS.filter((t) => !t.name.startsWith('propose_'));

function freshSession(): AgentSession {
  return {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: '新对话',
    updatedAt: Date.now(),
    usage: { ...ZERO_USAGE },
    items: [],
  };
}

/** 上次会话遗留的待确认提案无法兑现（审批 promise 不持久化），标记过期 */
function markStale(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.kind === 'proposal' && i.status === 'pending' ? { ...i, status: 'stale' as const } : i));
}

function firstUserTitle(items: ChatItem[]): string | null {
  const first = items.find((i): i is Extract<ChatItem, { kind: 'msg' }> => i.kind === 'msg' && i.role === 'user');
  return first ? first.text.slice(0, 24) : null;
}

function loadSessions(): AgentSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentSession[];
      if (Array.isArray(parsed) && parsed.length
        && parsed.every((s) => s && typeof s.id === 'string' && Array.isArray(s.items))) {
        return parsed.map((s) => ({ ...s, usage: s.usage ?? { ...ZERO_USAGE }, items: markStale(s.items) }));
      }
    }
  } catch { /* 损坏则走迁移/新建 */ }
  try {
    const old = localStorage.getItem(OLD_CHAT_KEY);
    if (old) {
      const items = JSON.parse(old) as ChatItem[];
      if (Array.isArray(items) && items.length) {
        return [{
          id: 's-migrated',
          title: firstUserTitle(items) ?? '旧对话',
          updatedAt: Date.now(),
          usage: { ...ZERO_USAGE },
          items: markStale(items),
        }];
      }
    }
  } catch { /* ignore */ }
  return [];
}

function persistSessions(sessions: AgentSession[], activeId: string) {
  // 提案卡里的全文截断后保存（持久化只为回看，diff 渲染容忍截断）
  const slim = sessions.map((s) => ({
    ...s,
    items: s.items.map((i) => (i.kind === 'proposal'
      ? { ...i, old: i.old.slice(0, PERSIST_CONTENT_LIMIT), next: i.next.slice(0, PERSIST_CONTENT_LIMIT) }
      : i)),
  }));
  let list = slim;
  const oldestOther = () => [...list]
    .filter((s) => s.id !== activeId)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0];
  while (list.length > SESSIONS_LIMIT) {
    const victim = oldestOther();
    if (!victim) break;
    list = list.filter((s) => s.id !== victim.id);
  }
  let json = JSON.stringify(list);
  while (json.length > SESSIONS_STORE_LIMIT) {
    const victim = oldestOther();
    if (!victim) break;
    list = list.filter((s) => s.id !== victim.id);
    json = JSON.stringify(list);
  }
  try {
    localStorage.setItem(SESSIONS_KEY, json);
  } catch {
    /* 存储满等异常不致命：会话只是不再持久化 */
  }
}

function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<AgentPrefs>;
    return { readonly: p.readonly === true, autoApply: p.autoApply === true };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadSettings(): AgentSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AgentSettings;
    if (typeof s.baseUrl !== 'string' || !/^https?:\/\//.test(s.baseUrl)) return null;
    if (typeof s.model !== 'string' || !s.model.trim()) return null;
    return { baseUrl: s.baseUrl, apiKey: typeof s.apiKey === 'string' ? s.apiKey : '', model: s.model };
  } catch {
    return null;
  }
}

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export default function AiAgentPanel({
  onClose, docs, onSave, onOpenPath, currentPath, resolveLink,
}: Props) {
  useEsc(escThenClose(onClose));
  const [settings, setSettings] = useState<AgentSettings | null>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(() => !loadSettings());
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    const loaded = loadSessions();
    return loaded.length ? loaded : [freshSession()];
  });
  const [activeId, setActiveId] = useState<string>(() => sessions[0].id);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  /** 进行中那一轮助手回复的流式正文 / 思考过程 */
  const [streamText, setStreamText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  /** 只读 / 自动应用偏好 */
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  /** 运行中排队的后续消息（Claudian 式：不打断，跑完自动接续） */
  const [queued, setQueued] = useState<string[]>([]);
  /** @ 引用 / 斜杠命令补全 */
  const [mention, setMention] = useState<MentionHit | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const items = active.items;

  const docsRef = useRef(docs);
  useEffect(() => { docsRef.current = docs; }, [docs]);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  const runningRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // 条目 id 从恢复的对话续接：重开面板后从 1 重数会与旧条目撞车，
  // patchProposal 按 id 匹配就会误改上一轮的提案卡
  const idRef = useRef(1);
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId);
    idRef.current = Math.max(0, ...(s?.items ?? []).map((i) => i.id)) + 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  /** 待确认提案的裁决函数：提案条目 id → resolve */
  const pendingRef = useRef(new Map<number, (d: Decision) => void>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    persistSessions(sessions, activeId);
  }, [sessions, activeId]);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* 忽略 */ }
  }, [prefs]);
  // 新消息/流式输出时滚到底部（用户上翻查看时不打扰：只贴底就顺滑跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, streamText, thinkingText, queued.length]);

  const updateActive = (patch: (s: AgentSession) => AgentSession) =>
    setSessions((cur) => cur.map((s) => (s.id === activeId ? patch(s) : s)));

  const push = (item: ChatItem) =>
    updateActive((s) => ({ ...s, updatedAt: Date.now(), items: [...s.items, item] }));

  const patchProposal = (id: number, patch: Partial<Extract<ChatItem, { kind: 'proposal' }>>) =>
    updateActive((s) => ({
      ...s,
      items: s.items.map((i) => (i.kind === 'proposal' && i.id === id ? { ...i, ...patch } : i)),
    }));

  const applyUsage = (u: TokenUsage) =>
    updateActive((s) => ({
      ...s,
      usage: {
        promptTokens: s.usage.promptTokens + u.promptTokens,
        completionTokens: s.usage.completionTokens + u.completionTokens,
        estimated: s.usage.estimated || u.estimated,
      },
    }));

  /** 等用户在 diff 卡片上点「应用 / 拒绝」；中止信号会把等待裁决为拒绝 */
  const awaitDecision = (itemId: number, signal: AbortSignal): Promise<Decision> =>
    new Promise<Decision>((resolve) => {
      const onAbort = () => resolve('rejected');
      signal.addEventListener('abort', onAbort, { once: true });
      pendingRef.current.set(itemId, (d) => {
        signal.removeEventListener('abort', onAbort);
        pendingRef.current.delete(itemId);
        resolve(d);
      });
    });

  /** 工具执行器：只读工具直接返回结果；写入工具先出 diff 卡片等确认 */
  const executeTool = async (name: string, argsJson: string, signal: AbortSignal): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return '错误：工具参数不是合法 JSON。';
    }

    if (name === 'list_notes') {
      const result = formatNoteList(docsRef.current);
      push({ kind: 'tool', id: idRef.current++, name, summary: '浏览目录', detail: result });
      return result;
    }
    if (name === 'search_notes') {
      const query = String(args.query ?? '');
      const result = searchNotes(docsRef.current, query);
      push({ kind: 'tool', id: idRef.current++, name, summary: `搜索「${query}」`, detail: result });
      return result;
    }
    if (name === 'read_note') {
      const path = String(args.path ?? '');
      const content = docsRef.current.get(path);
      if (content === undefined) return `错误：找不到笔记「${path}」。可先用 list_notes 或 search_notes 确认路径。`;
      const result = truncateForModel(content);
      push({ kind: 'tool', id: idRef.current++, name, summary: `读取 ${path}`, detail: result });
      return result;
    }

    if (name === 'propose_note_edit' || name === 'propose_note_patch' || name === 'propose_note_create') {
      const path = safeVaultPath(String(args.path ?? ''));
      if (!path) return '错误：路径不合法（需要库内相对路径，如 解剖/心脏.md）。';
      const isNew = name === 'propose_note_create';
      const old = docsRef.current.get(path);
      if (isNew && old !== undefined) return `错误：「${path}」已存在，请改用 propose_note_edit / propose_note_patch 修改它。`;
      if (!isNew && old === undefined) return `错误：「${path}」不存在，请先用 list_notes 或 search_notes 确认路径。`;

      // patch：锚文本唯一性校验后算出新正文；edit/create 直接用模型给的整篇
      let next: string;
      if (name === 'propose_note_patch') {
        const findText = typeof args.find_text === 'string' ? args.find_text : '';
        const replaceText = typeof args.replace_text === 'string' ? args.replace_text : '';
        if (!findText) return '错误：find_text 为空。请先 read_note，再从返回结果里原样复制一段唯一文本。';
        const occurrences = old!.split(findText).length - 1;
        if (occurrences === 0) return '错误：find_text 在笔记中没有找到。请先 read_note，从返回结果里原样复制（含空格与标点）。';
        if (occurrences > 1) return `错误：find_text 出现了 ${occurrences} 次，不唯一。请扩大上下文（多带几行）让它唯一。`;
        next = old!.replace(findText, replaceText);
      } else {
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content.trim()) return '错误：正文为空。';
        next = content;
      }

      const itemId = idRef.current++;
      push({
        kind: 'proposal', id: itemId, path, old: old ?? '', next,
        isNew, status: 'pending',
      });

      // 「自动应用」只对 patch 生效；整篇重写与新建永远要人工确认
      const autoOk = prefsRef.current.autoApply && !isNew && name === 'propose_note_patch';
      let decision: Decision;
      let drifted = false;
      if (autoOk) {
        decision = 'applied';
      } else {
        decision = await awaitDecision(itemId, signal);
      }

      // 应用前核对：笔记在提案期间被用户改过（新建则是路径被占了）→ 显式确认覆盖。
      // 自动应用模式下同样要停下来问，绝不悄悄覆盖用户的手改。
      if (decision === 'applied' && (docsRef.current.get(path) ?? null) !== (old ?? null)) {
        drifted = true;
        patchProposal(itemId, { status: 'pending', drifted: true });
        decision = await awaitDecision(itemId, signal);
      }

      if (decision === 'rejected') {
        patchProposal(itemId, { status: 'rejected' });
        return drifted
          ? '用户放弃了这次修改（笔记已被用户改动过）。如需继续，请先重新 read_note 拿最新内容。'
          : '用户拒绝了这次修改。请询问用户想怎么调整，不要原样重复提交。';
      }
      try {
        await onSave(path, next);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patchProposal(itemId, { status: 'failed', error: msg });
        return `写入失败：${msg}`;
      }
      patchProposal(itemId, { status: 'applied', autoApplied: autoOk && !drifted });
      return isNew
        ? `已在「${path}」创建笔记。`
        : `已把修改写入「${path}」。`;
    }

    return `错误：未知工具 ${name}。`;
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const createSession = () => {
    const s = freshSession();
    setSessions((cur) => [...cur, s]);
    setActiveId(s.id);
  };

  const deleteSession = () => {
    const rest = sessions.filter((s) => s.id !== activeId);
    if (!rest.length) {
      const f = freshSession();
      setSessions([f]);
      setActiveId(f.id);
      return;
    }
    setSessions(rest);
    setActiveId(rest[rest.length - 1].id);
  };

  /** 真正发起一轮对话（排队续跑也走这里） */
  const sendText = async (text: string) => {
    if (!text || runningRef.current) return;
    if (!settingsRef.current) { setSettingsOpen(true); return; }
    const userItem: ChatItem = { kind: 'msg', id: idRef.current++, role: 'user', text };
    updateActive((s) => ({
      ...s,
      // 首条用户消息做会话标题
      title: s.items.some((i) => i.kind === 'msg' && i.role === 'user') ? s.title : text.slice(0, 24),
      updatedAt: Date.now(),
      items: [...s.items, userItem],
    }));
    runningRef.current = true;
    setRunning(true);
    setStreamText('');
    setThinkingText('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let wasAborted = false;
    let thinkAccum = '';

    // @ 引用：把被引用笔记的全文附进消息（模型无需再 read_note）
    const mentioned = extractMentionedNotes(text, [...docsRef.current.keys()].filter((p) => p.endsWith('.md')));
    // / 命令：整条消息是「/命令名 参数」时展开为命令笔记内容
    const expanded = expandCommand(text, docsRef.current);
    let wireContent = expanded ?? text;
    if (!expanded && mentioned.length) {
      const blocks = mentioned
        .map((p) => `@${p}：\n${truncateForModel(docsRef.current.get(p) ?? '', MENTION_CONTENT_LIMIT)}`)
        .join('\n\n');
      wireContent = `${text}\n\n---\n【用户引用的笔记】\n${blocks}`;
    }

    const agentMd = docsRef.current.get(AGENT_MD);
    const sys = buildNoteSystemPrompt(currentPath, agentMd ? truncateForModel(agentMd, 4_000) : null)
      + (prefsRef.current.readonly ? '\n只读模式：本次会话没有提供任何写入工具，只做阅读、检索与讨论。' : '');
    const wire: WireMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: wireContent },
    ];

    try {
      await runAgent({
        settings: settingsRef.current,
        messages: wire,
        tools: prefsRef.current.readonly ? READONLY_TOOLS : NOTE_AGENT_TOOLS,
        executeTool,
        signal: ctrl.signal,
        onDelta: (t) => setStreamText((s) => s + t),
        onThinking: (t) => {
          thinkAccum += t;
          setThinkingText((s) => s + t);
        },
        onAssistantMessage: (msg) => {
          if (thinkAccum) {
            push({ kind: 'thinking', id: idRef.current++, text: thinkAccum });
            thinkAccum = '';
            setThinkingText('');
          }
          if (msg.content) {
            push({ kind: 'msg', id: idRef.current++, role: 'assistant', text: msg.content });
          }
          setStreamText('');
        },
        onUsage: applyUsage,
      });
    } catch (e) {
      if (isAbortError(e)) wasAborted = true;
      push({
        kind: 'error', id: idRef.current++,
        text: isAbortError(e) ? '已停止。' : e instanceof Error ? e.message : String(e),
      });
    } finally {
      runningRef.current = false;
      setRunning(false);
      setStreamText('');
      setThinkingText('');
      if (abortRef.current === ctrl) abortRef.current = null;
      // 队列续跑（用户主动停止时不自动接续，留给用户决定）
      const next = wasAborted ? undefined : queueRef.current.shift();
      if (next !== undefined) {
        setQueued([...queueRef.current]);
        void sendText(next);
      }
    }
  };

  const submit = () => {
    const text = input.trim();
    console.log('[DBG] submit called, text=', JSON.stringify(text), 'running=', runningRef.current, 'settings=', !!settingsRef.current, 'settingsOpen=', settingsOpen);
    if (!text) return;
    if (!settingsRef.current || settingsOpen) { setSettingsOpen(true); return; }
    setInput('');
    setMention(null);
    if (runningRef.current) {
      queueRef.current.push(text);
      setQueued([...queueRef.current]);
      return;
    }
    void sendText(text);
  };

  /* --------------------------------------------------- 补全（@ 引用 / 命令） */

  const mentionMatches = mention
    ? (mention.kind === 'note'
        ? [...docs.keys()].filter((p) => p.endsWith('.md') && p.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8)
        : listCommands(docs).filter((c) => c.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8))
    : [];

  const selectMention = (hit: string) => {
    if (!mention) return;
    if (mention.kind === 'note') {
      const before = input.slice(0, mention.start);
      const after = input.slice(caretRef.current);
      setInput(`${before}@${hit} ${after}`);
    } else {
      const content = docs.get(`${CMD_DIR}${hit}.md`) ?? '';
      // 带占位符的命令保留 $ARGUMENTS 让用户填参；没有的补两个换行直接可发
      setInput(content.includes('$ARGUMENTS') ? content : `${content.trim()}\n\n`);
    }
    setMention(null);
    textareaRef.current?.focus();
  };

  const syncMention = (value: string, caret: number) => {
    caretRef.current = caret;
    const hit = detectMention(value, caret);
    setMention(hit);
    setMentionIdx(0);
  };

  /* ------------------------------------------------------------- 渲染 */

  const renderDiffRows = (old: string, next: string) => {
    const rows: CollapsedRow[] = collapseDiff(diffLines(old, next), 2);
    return rows.map((row, idx) => {
      if (row.type === 'gap') return <div key={idx} className="agent-diff-gap">⋯ 还有 {row.count} 行未变 ⋯</div>;
      return (
        <div key={idx} className={`agent-diff-${row.type}`}>
          {row.type === 'add' ? '+ ' : row.type === 'del' ? '− ' : '  '}{row.text}
        </div>
      );
    });
  };

  /** 助手消息里的 [[双链]]：能解析就跳转对应笔记 */
  const openWikiLink = (name: string) => {
    const p = resolveLink?.(name);
    if (p) { onClose(); onOpenPath?.(p); }
  };

  const settingsValid = !!settings;
  const usage = active.usage;
  const usageText = usage.promptTokens + usage.completionTokens > 0
    ? `tokens ↑${fmtTokens(usage.promptTokens)} ↓${fmtTokens(usage.completionTokens)}${usage.estimated ? ' ≈' : ''}`
    : '';

  return (
    <div className="agent-panel">
      <div className="ai-header agent-header">
        <select
          className="agent-session-select"
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          disabled={running}
          aria-label="切换会话"
        >
          {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button className="btn-small" onClick={createSession} disabled={running}>新对话</button>
        <button
          className="btn-icon"
          onClick={deleteSession}
          disabled={running || sessions.length <= 1}
          aria-label="删除当前会话"
          title="删除当前会话"
        >
          <IconTrash />
        </button>
        <button
          className="btn-small"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
        >
          设置
        </button>
        <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
      </div>

      {settingsOpen && (
        <SettingsForm
          initial={settings}
          onSaved={(s) => {
            setSettings(s);
            setSettingsOpen(false);
          }}
          onCancel={() => setSettingsOpen(false)}
        />
      )}

      <div className="agent-log" ref={scrollRef} role="log" aria-live="polite" aria-label="AI 笔记助手对话">
        {!items.length && !running && (
          <div className="agent-empty">
            <p><strong>让 AI 帮你整理笔记。</strong></p>
            <p className="muted">
              它能浏览目录、全文搜索、读取笔记，然后提出修改——
              修改会以<strong>对比预览</strong>呈现，点「应用」才会写入，并自动存入历史版本。
            </p>
            <p className="muted">
              输入 <code>@</code> 引用一篇笔记 · 输入 <code>/</code> 用命令（<code>{CMD_DIR}</code> 目录下的笔记）·
              建一篇 <code>{AGENT_MD}</code> 写下长期要求
              {currentPath && <>· 当前打开：<code>{currentPath}</code></>}
            </p>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === 'msg') {
            return item.role === 'assistant' ? (
              <div key={item.id} className="agent-msg assistant">
                <Preview content={item.text} resolve={resolveLink} onOpenLink={openWikiLink} />
              </div>
            ) : (
              <div key={item.id} className="agent-msg user">{item.text}</div>
            );
          }
          if (item.kind === 'tool') {
            return (
              <details key={item.id} className="agent-tool">
                <summary>{toolIcon(item.name)} {item.summary}</summary>
                <pre className="agent-tool-detail">{item.detail}</pre>
              </details>
            );
          }
          if (item.kind === 'thinking') {
            return (
              <details key={item.id} className="agent-thinking">
                <summary>💭 思考过程</summary>
                <div className="agent-thinking-body">{item.text}</div>
              </details>
            );
          }
          if (item.kind === 'error') {
            return <div key={item.id} className="agent-error">{item.text}</div>;
          }
          return (
            <div key={item.id} className="agent-proposal">
              <div className="agent-proposal-head">
                {item.isNew ? '新建笔记' : '修改笔记'}：<code>{item.path}</code>
              </div>
              {item.status === 'pending' ? (
                <>
                  {item.drifted && (
                    <div className="agent-drift">
                      笔记在提案后被你改动过。应用会以提案内容覆盖当前笔记（历史版本可回溯）。
                    </div>
                  )}
                  <pre className="agent-diff">{renderDiffRows(item.old, item.next)}</pre>
                  <div className="agent-proposal-actions">
                    <button
                      className="btn-primary"
                      onClick={() => pendingRef.current.get(item.id)?.('applied')}
                    >
                      {item.drifted ? '仍要覆盖' : item.isNew ? '创建笔记' : '应用修改'}
                    </button>
                    <button
                      className="btn-small"
                      onClick={() => pendingRef.current.get(item.id)?.('rejected')}
                    >
                      {item.drifted ? '放弃' : '拒绝'}
                    </button>
                  </div>
                </>
              ) : (
                <div className={`agent-proposal-state agent-proposal-${item.status}`}>
                  {item.status === 'applied' && (item.autoApplied ? '✓ 已自动应用（历史版本可回溯）' : '✓ 已应用，可在历史版本中回溯')}
                  {item.status === 'rejected' && '已拒绝'}
                  {item.status === 'stale' && '（上次会话的提案，未应用）'}
                  {item.status === 'failed' && `✗ 写入失败：${item.error ?? '未知错误'}`}
                  {item.status === 'applied' && !item.autoApplied && onOpenPath && (
                    <button className="btn-small" onClick={() => { onClose(); onOpenPath(item.path); }}>
                      打开笔记
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {running && thinkingText && (
          <details className="agent-thinking" open>
            <summary>💭 思考中…</summary>
            <div className="agent-thinking-body">{thinkingText}</div>
          </details>
        )}
        {running && streamText && <div className="agent-msg assistant streaming">{streamText}</div>}
        {queued.map((q, i) => (
          <div key={`queued-${i}`} className="agent-queued">
            <span className="agent-queued-text">⏳ {q}</span>
            <button
              className="btn-small"
              aria-label="取消排队消息"
              onClick={() => {
                queueRef.current.splice(i, 1);
                setQueued([...queueRef.current]);
              }}
            >
              取消
            </button>
          </div>
        ))}
      </div>

      <div className="agent-input">
        {mention && mentionMatches.length > 0 && (
          <div className="agent-mention" role="listbox" aria-label="补全候选">
            {mentionMatches.map((m, i) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={i === mentionIdx}
                className={`agent-mention-item ${i === mentionIdx ? 'on' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); selectMention(m); }}
              >
                {mention.kind === 'note' ? `@ ${m}` : `/ ${m}`}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            syncMention(v, e.target.selectionStart ?? 0);
          }}
          onKeyUp={(e) => { caretRef.current = e.currentTarget.selectionStart ?? 0; }}
          onClick={(e) => { caretRef.current = e.currentTarget.selectionStart ?? 0; }}
          onKeyDown={(e) => {
            if (mention && mentionMatches.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionMatches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectMention(mentionMatches[mentionIdx]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation(); // 只关菜单，不关面板
                setMention(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={settingsValid ? '让 AI 帮你查找或整理笔记…（@ 引用笔记，/ 用命令）' : '先在「设置」里配置模型服务…'}
          rows={3}
          aria-label="对 AI 笔记助手说点什么"
        />
        {running ? (
          <button className="btn-small agent-stop" onClick={stop}>停止</button>
        ) : (
          <button className="btn-primary agent-send" onClick={submit} disabled={!input.trim() || !settingsValid}>
            发送
          </button>
        )}
      </div>
      <div className="agent-prefs">
        <button
          className={`pref-chip ${prefs.readonly ? 'on' : ''}`}
          onClick={() => setPrefs((p) => ({ ...p, readonly: !p.readonly }))}
          aria-pressed={prefs.readonly}
          title="只读模式：不提供写入工具，只做阅读、检索与讨论"
        >
          🔒 只读
        </button>
        <button
          className={`pref-chip ${prefs.autoApply ? 'on' : ''}`}
          onClick={() => setPrefs((p) => ({ ...p, autoApply: !p.autoApply }))}
          aria-pressed={prefs.autoApply}
          title="自动应用定点修改（patch），diff 仍会显示；整篇重写与新建仍需确认，笔记被改过时仍会先询问"
        >
          ⚡ 自动应用
        </button>
        {usageText && (
          <span
            className="agent-usage"
            title={usage.estimated ? '服务商未返回用量，按字符数估算' : '本次会话累计 token 用量（输入/输出）'}
          >
            {usageText}
          </span>
        )}
      </div>
      <p className="ai-hint muted">
        修改笔记需你确认后才会写入，并自动存入历史版本。会话与配置只保存在本机浏览器；消息内容会发送给你配置的模型服务商，请勿包含患者信息等敏感数据。
      </p>
    </div>
  );
}

function toolIcon(name: string): string {
  if (name === 'list_notes') return '目录';
  if (name === 'search_notes') return '搜索';
  if (name === 'read_note') return '读取';
  return '工具';
}

/* ------------------------------------------------------------ 设置表单 */

function SettingsForm({ initial, onSaved, onCancel }: {
  initial: AgentSettings | null;
  onSaved: (s: AgentSettings) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [hint, setHint] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const valid = /^https?:\/\//.test(baseUrl.trim()) && !!model.trim();

  /** 连通性测试：真实发一条 1-token 请求；成功后顺手拉 /models 做模型名候选 */
  const test = async () => {
    const base = baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base) || !model.trim()) {
      setResult({ ok: false, text: '先填好接口地址与模型名' });
      return;
    }
    setTesting(true);
    setResult(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    };
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      });
      if (res.ok) {
        try {
          const mres = await fetch(`${base}/models`, { signal: ctrl.signal, headers });
          if (mres.ok) {
            const data = await mres.json() as { data?: Array<{ id?: string }> };
            setModels((data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 100));
          }
        } catch { /* /models 可选，失败不影响连接结果 */ }
        setResult({ ok: true, text: '连接成功' });
      } else {
        const t = await res.text().catch(() => '');
        setResult({ ok: false, text: `${res.status}：${t.slice(0, 160) || res.statusText}` });
      }
    } catch (e) {
      setResult({ ok: false, text: isAbortError(e) ? '连接超时' : e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
      setTesting(false);
    }
  };

  return (
    <div className="agent-settings">
      <div className="agent-settings-presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className={`type-chip ${baseUrl === p.baseUrl ? 'on' : ''}`}
            onClick={() => {
              setBaseUrl(p.baseUrl);
              if (p.model) setModel(p.model);
              setHint(p.hint);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <label className="agent-field">
        <span>接口地址（OpenAI 兼容）</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.xiaomimimo.com/v1"
          spellCheck={false}
        />
      </label>
      <label className="agent-field">
        <span>API Key{baseUrl.includes('localhost') ? '（本地服务可留空）' : ''}</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
      </label>
      <label className="agent-field">
        <span>模型名{models.length ? `（${models.length} 个候选，输入时下拉）` : ''}</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="如 deepseek-chat / glm-4.6 / kimi-k2"
          spellCheck={false}
          list="agent-model-candidates"
        />
        <datalist id="agent-model-candidates">
          {models.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      {hint && <p className="agent-settings-hint muted">{hint}</p>}
      <div className="agent-settings-actions">
        <button className="btn-small" onClick={() => void test()} disabled={testing || !valid}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          className="btn-primary"
          disabled={!valid}
          onClick={() => {
            const s: AgentSettings = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() };
            try {
              localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
            } catch { /* 忽略 */ }
            onSaved(s);
          }}
        >
          保存
        </button>
        {initial && <button className="btn-small" onClick={onCancel}>取消</button>}
      </div>
      {result && <p className={`agent-test-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</p>}
    </div>
  );
}
