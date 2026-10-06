/**
 * AI 笔记助手（对标 Obsidian 的 Claudian 插件）：
 * - 侧栏多会话对话，agent 可用工具检索笔记（列目录 / 搜索 / 读取）
 * - 修改以 diff 卡片呈现：「应用」后才经 vault.save 落盘（自动进历史版本）；
 *   应用前若发现笔记已被用户改过，先弹覆盖确认再动手；「自动应用」开关可让
 *   定点替换（patch）跳过确认；「自主」模式下全部写入免确认（漂移仍要确认）
 * - Claudian 式交互：@路径 引用笔记（附内容进上下文）、/斜杠命令（AI命令/ 目录
 *   下的笔记，$ARGUMENTS 传参）、AGENT.md 自定义指南（对应 CLAUDE.md）、只读模式、
 *   运行中消息排队、推理模型思考过程展示
 * - 模型走 OpenAI 兼容协议，地址 / Key / 模型名由用户配置（小米 MiMo / DeepSeek /
 *   智谱 / Kimi / OpenRouter / Ollama 均可），配置与会话只存本机 localStorage
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentNetHint, buildHistoryMessages, buildNoteSystemPrompt, detectMention, expandCommand, extractMentionedNotes, formatNoteList,
  isAbortError, listCommands, MEDBOOK_TOOLS, NOTE_AGENT_TOOLS, runAgent, searchNotes, truncateForModel,
  type AgentSettings, type MentionHit, type RunAgentOptions, type TokenUsage, type WireMessage,
} from '../core/aiAgent';
import {
  formatMedBooks, formatMedHits, medBookRecords, medBookRemove, medBooksList, medBooksSearch,
  type MedBookHit, type MedBookMeta,
} from '../core/medBooks';
import { PiUnavailableError, runPiAgent } from '../core/piAgent';
import { collapseDiff, diffLines } from '../core/aiDiff';
import { LEARNING_TOOLS, quizProgressReport, reviewDueReport, studySummaryReport, weakChaptersReport } from '../core/aiLearning';
import { loadBanks } from '../core/qbank';
import { initializeStats } from '../core/qbankStats';
import { cardHints } from '../core/srsCards';
import { renderMarkdown } from '../core/markdown';
import { CITE_LABEL, CITE_MARK, lookupQuote, verifyCitations } from '../core/citeVerify';
import { safeVaultPath } from '../core/vault';
import { fuzzyFindAnchor, type AnchorHit } from '../core/aiPatch';
import { toast } from '../core/feedback';
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
  /** 编辑器「问 AI」选段（Workspace 桥接）：面板打开时消费一次并清空 */
  quote?: QuoteSelection | null;
  /** 引用卡消费完毕（Workspace 据此清桥接状态） */
  onQuoteConsumed?: () => void;
}

/** 常见 OpenAI 兼容入口；模型名以服务商控制台为准，可改 */
const PRESETS = [
  { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: '', hint: '每日有免费 token 额度；模型名以 mimo.mi.com 文档/控制台为准' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', hint: '' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: '' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2', hint: '' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hint: '可访问 Claude 等海外模型，模型名填 provider/model' },
  { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: '', hint: '无需 Key；需以 OLLAMA_ORIGINS=* 启动以放行跨域' },
  { name: '自定义中转', baseUrl: '', model: '', hint: '填中转站给的接口地址，通常以 /v1 结尾；粘贴后先点「测试连接」' },
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

/** 编辑器右键「问 AI」带进来的选段：发送时附进消息上下文，气泡里展示引用卡 */
export type QuoteSelection = { text: string; path: string | null };

/** 流式正文也吃 markdown 排版：防抖 250ms 渲染（markdown-it 懒加载，首条消息后常驻内存） */
function useDeferredMarkdown(text: string): string {
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (!text) { setHtml(''); return; }
    let alive = true;
    const timer = setTimeout(() => {
      renderMarkdown(text)
        .then((h) => { if (alive) setHtml(h); })
        .catch(() => { /* 渲染失败保持纯文本展示 */ });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [text]);
  return html;
}

/** 引用核验徽标：把回答里 “…”〔…〕 形式的引用逐条与库内原文比对，展示四档结论。
 *  没给出原文的标记也照实列出来——否则用户会以为所有引用都核验过了。 */
function CitationCheck({ text, docs }: { text: string; docs: Map<string, string> }) {
  const results = useMemo(() => verifyCitations(text, docs), [text, docs]);
  if (!results.length) return null;
  return (
    <div className="agent-cites">
      {results.map((c, i) => (c.quote ? (
        <span
          key={i}
          className={`agent-cite agent-cite-${c.status}${c.ambiguous ? ' agent-cite-multi' : ''}`}
          title={`${CITE_LABEL[c.status]}${c.sourcePath ? `：${c.sourcePath}` : ''}\n“${c.quote}”`
            + (c.ambiguous ? `\n库内 ${c.hits} 篇笔记都含此句，出处不唯一` : '')}
        >
          {CITE_MARK[c.status]} {c.quote.length > 18 ? `${c.quote.slice(0, 18)}…` : c.quote}
          {c.page ? ` P${c.page}` : ''}
          {c.ambiguous ? ` · ${c.hits} 处` : ''}
        </span>
      ) : (
        <span key={i} className="agent-cite agent-cite-nocite" title={`${c.raw}\n没有给出原文，无法逐字核验`}>
          未给出原文
        </span>
      )))}
    </div>
  );
}

/** 提案 diff：只在 old/next 变化时重算。
 *  流式输出每个 token 都会让整个列表重渲，inline 计算会把每张待确认卡片的 diff 重跑一遍。 */
const ProposalDiff = memo(function ProposalDiff({ old, next }: { old: string; next: string }) {
  const rows = useMemo(() => collapseDiff(diffLines(old, next), 2), [old, next]);
  return (
    <pre className="agent-diff">
      {rows.map((row, idx) => (row.type === 'gap'
        ? <div key={idx} className="agent-diff-gap">⋯ 还有 {row.count} 行未变 ⋯</div>
        : (
          <div key={idx} className={`agent-diff-${row.type}`}>
            {row.type === 'add' ? '+ ' : row.type === 'del' ? '− ' : '  '}{row.text}
          </div>
        )
      ))}
    </pre>
  );
});

type ChatItem =
  | {
      kind: 'msg'; id: number; role: 'user' | 'assistant'; text: string; quote?: QuoteSelection;
      /** 用户中途停止（或流中途出错）时留下的未写完回答 */
      partial?: boolean;
    }
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

/** autonomous：自主模式——所有写入提案免确认直接落盘（漂移确认保留） */
interface AgentPrefs { readonly: boolean; autoApply: boolean; autonomous: boolean }

interface AgentSession {
  id: string;
  title: string;
  updatedAt: number;
  usage: SessionUsage;
  items: ChatItem[];
}

const ZERO_USAGE: SessionUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
const DEFAULT_PREFS: AgentPrefs = { readonly: false, autoApply: false, autonomous: false };
/** 停顿看门狗阈值：这么久没有任何流事件就认为连接卡死（模型思考会走 thinking 增量；等用户确认提案的不算） */
const STALL_IDLE_MS = 120_000;

/** 全部工具＝笔记工具＋学习状态工具；只读模式只留检索与学习状态（写入类都以 propose_ 开头） */
const ALL_AGENT_TOOLS = [...NOTE_AGENT_TOOLS, ...MEDBOOK_TOOLS, ...LEARNING_TOOLS];
const READONLY_TOOLS = ALL_AGENT_TOOLS.filter((t) => !t.name.startsWith('propose_'));

/** 属性键行：`- 键: `，与 srsCards.cardHints 同口径（键 ≤12 字，无空格冒号） */
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

/** 把属性键骨架插进指定小节标题之后；返回错误文案（string）或新正文的行数组 */
function insertCardHints(old: string, heading: string, keys: string[]): string[] | string {
  const lines = old.split('\n');
  const target = lines.findIndex((l) => HEADING_LINE.exec(l)?.[2] === heading);
  if (target < 0) return `错误：找不到小节标题「${heading}」。先 read_note，标题要与文中一字不差（不含 # 号）。`;
  const level = HEADING_LINE.exec(lines[target])![1].length;
  let end = lines.length;
  for (let i = target + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const existing = new Set(cardHints(lines.slice(target + 1, end).join('\n')));
  const add = keys.filter((k) => !existing.has(k));
  if (!add.length) return `错误：这些提示键在小节里都已存在（${keys.join('、')}），不用重复添加。`;
  const insert = add.map((k) => `- ${k}: `);
  if (lines[target + 1] !== undefined && lines[target + 1].trim() !== '') insert.push('');
  lines.splice(target + 1, 0, ...insert);
  return lines;
}

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
    return { readonly: p.readonly === true, autoApply: p.autoApply === true, autonomous: p.autonomous === true };
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
    return {
      baseUrl: s.baseUrl,
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
      model: s.model,
    };
  } catch {
    return null;
  }
}

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export default function AiAgentPanel({
  onClose, docs, onSave, onOpenPath, currentPath, resolveLink, quote, onQuoteConsumed,
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
  const streamHtml = useDeferredMarkdown(streamText);
  const [thinkingText, setThinkingText] = useState('');
  /** 只读 / 自动应用偏好 */
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  /** 运行中排队的后续消息（Claudian 式：不打断，跑完自动接续） */
  const [queued, setQueued] = useState<string[]>([]);
  /** @ 引用 / 斜杠命令补全 */
  const [mention, setMention] = useState<MentionHit | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  /** 编辑器「问 AI」带进来的待发送选段：null = 无。发送后清空 */
  const [pendingQuote, setPendingQuote] = useState<QuoteSelection | null>(null);
  /** 选段的同步副本：sendText 发出后 setState 要等下一轮渲染才生效，
   *  排队续跑是在同一个 sendText 闭包里递归调用的，读 state 会把选段重复注入到续跑的那条消息上 */
  const pendingQuoteRef = useRef<QuoteSelection | null>(null);
  /** 已流出的正文（含未落定部分）：停止/出错时据此保住半截回答 */
  const streamRef = useRef('');

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const items = active.items;

  const docsRef = useRef(docs);
  useEffect(() => { docsRef.current = docs; }, [docs]);
  /** 教材检索命中的原文：ref 供同一轮工具调用即时查证，state 供引用核验徽标重渲染 */
  const bookEvidenceRef = useRef<Map<string, string>>(new Map());
  const [bookEvidence, setBookEvidence] = useState<Map<string, string>>(new Map());
  const citationDocs = useMemo(() => {
    if (!bookEvidence.size) return docs;
    const merged = new Map(docs);
    for (const [k, v] of bookEvidence) merged.set(k, v);
    return merged;
  }, [docs, bookEvidence]);
  /** 笔记库 + 已检索到的教材原文，合并给引文核验（笔记键在前，教材可覆盖同名键） */
  const evidenceForVerify = (): Map<string, string> => {
    if (!bookEvidenceRef.current.size) return docsRef.current;
    const merged = new Map(docsRef.current);
    for (const [k, v] of bookEvidenceRef.current) merged.set(k, v);
    return merged;
  };
  /** 活跃会话条目的最新快照：排队续跑等异步路径里读历史用（闭包里的 items 是旧的）。
   *  push 同步维护它——排队续跑在 React 提交 effect 之前就递归 sendText，只靠 useEffect 会漏掉上一轮末尾的问答 */
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
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
  /** 视口是否贴着底部（用户上翻回看时为 false，此时不自动跟随） */
  const pinnedRef = useRef(true);
  /** 本轮最后一次「有事件」的时刻（增量/思考/工具开始）：停顿看门狗据此判断连接卡死 */
  const lastEventRef = useRef(0);
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
  // 新消息/流式输出时滚到底部；用户上翻查看时不打扰（pinnedRef 由 onScroll 维护：
  // 只在本来就贴底时跟随，否则流式 token 会把正在回看的视口一直拽回底部）
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, streamText, thinkingText, queued.length]);
  // 消费编辑器「问 AI」带进来的选段：进入待发送区，等用户补一句话再发
  useEffect(() => {
    if (quote && quote.text.trim()) {
      pendingQuoteRef.current = quote;
      setPendingQuote(quote);
      onQuoteConsumed?.();
    }
  }, [quote, onQuoteConsumed]);

  const updateActive = (patch: (s: AgentSession) => AgentSession) =>
    setSessions((cur) => cur.map((s) => (s.id === activeId ? patch(s) : s)));

  const push = (item: ChatItem) => {
    itemsRef.current = [...itemsRef.current, item];
    updateActive((s) => ({ ...s, updatedAt: Date.now(), items: [...s.items, item] }));
  };

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
      // 中止也要把裁决函数从表里摘掉：条目 id 单调递增不复用，留着就是永久泄漏
      const onAbort = () => {
        pendingRef.current.delete(itemId);
        resolve('rejected');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pendingRef.current.set(itemId, (d) => {
        signal.removeEventListener('abort', onAbort);
        pendingRef.current.delete(itemId);
        resolve(d);
      });
    });

  /** 累积教材检索命中的原文，供引用核验比对；超预算时逐出最旧的教材（不整库清零，
   *  否则旧消息里已核验过的引用徽标会在重渲染时追溯变成「未找到出处」） */
  const recordBookEvidence = (hits: MedBookHit[]) => {
    const next = new Map(bookEvidenceRef.current);
    for (const h of hits) {
      const key = `${h.book}.md`;
      const prevText = next.get(key) ?? '';
      if (!prevText.includes(h.text)) next.set(key, `${prevText}\n\n${h.text}`.trim());
    }
    const totalChars = (m: Map<string, string>) => [...m.values()].reduce((n, t) => n + t.length, 0);
    const currentBooks = new Set(hits.map((h) => `${h.book}.md`));
    while (next.size > 1) {
      if (next.size <= 40 && totalChars(next) <= 400_000) break;
      const oldest = next.keys().next().value!;
      if (currentBooks.has(oldest)) break; // 当轮命中的书保底，宁可暂时超预算
      next.delete(oldest);
    }
    bookEvidenceRef.current = next;
    setBookEvidence(next);
  };

  /** 工具执行器：只读工具直接返回结果；写入工具先出 diff 卡片等确认 */
  const executeTool = async (name: string, argsJson: string, signal: AbortSignal): Promise<string> => {
    lastEventRef.current = Date.now();
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

    if (name === 'verify_quote') {
      const quote = String(args.quote ?? '').trim();
      if (!quote) return '错误：缺少 quote（要核验的引文）。';
      const sources = evidenceForVerify();
      const want = String(args.path ?? '').trim();
      // 路径容错：工具结果里的 chunk_id 不带 .md 后缀，模型可能给「书名」而非「书名.md」
      let resolved = want;
      if (want && !sources.has(want)) {
        resolved = [`${want}.md`, want.replace(/\.md$/, '')].find((c) => sources.has(c)) ?? want;
      }
      if (want && !sources.has(resolved)) {
        return `错误：找不到来源「${want}」。可先用 list_notes / search_notes 或 search_medical_books 确认出处。`;
      }
      const r = lookupQuote(quote, sources, resolved || undefined);
      const result = `${CITE_MARK[r.status]} ${CITE_LABEL[r.status]}`
        + `${r.sourcePath ? `（来源：${r.sourcePath}）` : ''}\n引文：“${quote}”`;
      push({ kind: 'tool', id: idRef.current++, name, summary: `核验引文（${CITE_LABEL[r.status]}）`, detail: result });
      return result;
    }

    if (name === 'list_medical_books' || name === 'search_medical_books') {
      try {
        if (name === 'list_medical_books') {
          const result = formatMedBooks(await medBooksList());
          push({ kind: 'tool', id: idRef.current++, name, summary: '医学教材清单', detail: result });
          return result;
        }
        const query = String(args.query ?? '').trim();
        if (!query) return '错误：缺少 query（检索词）。';
        const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 20);
        const book = typeof args.book === 'string' ? args.book : undefined;
        const hits = await medBooksSearch(query, limit, book);
        if (hits.length) recordBookEvidence(hits);
        const result = formatMedHits(hits);
        push({
          kind: 'tool', id: idRef.current++, name,
          summary: `教材检索「${query}」（${hits.length} 条命中）`, detail: result,
        });
        return result;
      } catch (e) {
        if (isAbortError(e)) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        push({ kind: 'tool', id: idRef.current++, name, summary: '教材检索失败', detail: msg });
        return msg;
      }
    }

    if (name === 'get_review_due') {
      const result = reviewDueReport([...docsRef.current.keys()], docsRef.current);
      push({ kind: 'tool', id: idRef.current++, name, summary: '查看今日复习队列', detail: result });
      return result;
    }
    if (name === 'get_study_summary') {
      const result = studySummaryReport([...docsRef.current.keys()], docsRef.current);
      push({ kind: 'tool', id: idRef.current++, name, summary: '查看学习概况', detail: result });
      return result;
    }
    if (name === 'get_weak_chapters') {
      const result = weakChaptersReport();
      push({ kind: 'tool', id: idRef.current++, name, summary: '查看错题本薄弱章节', detail: result });
      return result;
    }
    if (name === 'get_quiz_progress') {
      try {
        const [banks, stats] = await Promise.all([loadBanks(), initializeStats()]);
        const result = quizProgressReport(banks, stats);
        push({ kind: 'tool', id: idRef.current++, name, summary: '查看题库练习情况', detail: result });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `错误：读取题库练习记录失败（${msg}）。可稍后重试。`;
      }
    }

    if (name === 'propose_note_edit' || name === 'propose_note_patch' || name === 'propose_note_create' || name === 'propose_card_hints') {
      const path = safeVaultPath(String(args.path ?? ''));
      if (!path) return '错误：路径不合法（需要库内相对路径，如 解剖/心脏.md）。';
      const isNew = name === 'propose_note_create';
      const old = docsRef.current.get(path);
      if (isNew && old !== undefined) return `错误：「${path}」已存在，请改用 propose_note_edit / propose_note_patch 修改它。`;
      if (!isNew && old === undefined) return `错误：「${path}」不存在，请先用 list_notes 或 search_notes 确认路径。`;

      // patch：锚文本唯一性校验后算出新正文；hints：小节定位后插属性键骨架；edit/create 直接用模型给的整篇
      let next: string;
      if (name === 'propose_card_hints') {
        const heading = String(args.heading ?? '').trim();
        const keys = [...new Set((Array.isArray(args.keys) ? args.keys : []).map((k) => String(k).trim()).filter(Boolean))];
        if (!heading) return '错误：缺少 heading（小节标题）。先 read_note，再原样复制标题（不含 # 号）。';
        if (!keys.length) return '错误：keys 为空。至少给一个属性键，如「定义」。';
        const bad = keys.find((k) => /[:\s]/.test(k) || k.length > 12);
        if (bad) return `错误：属性键「${bad}」不合法——不能含空格或冒号，且不超过 12 个字（参考：定义、首选检查、鉴别要点）。`;
        const nextLines = insertCardHints(old!, heading, keys);
        if (typeof nextLines === 'string') return nextLines;
        next = nextLines.join('\n');
      } else if (name === 'propose_note_patch') {
        const findText = typeof args.find_text === 'string' ? args.find_text : '';
        const replaceText = typeof args.replace_text === 'string' ? args.replace_text : '';
        if (!findText) return '错误：find_text 为空。请先 read_note，再从返回结果里原样复制一段唯一文本。';
        const occurrences = old!.split(findText).length - 1;
        if (occurrences > 1) return `错误：find_text 出现了 ${occurrences} 次，不唯一。请扩大上下文（多带几行）让它唯一。`;
        let hit: AnchorHit | null = null;
        if (occurrences === 1) {
          hit = { start: old!.indexOf(findText), end: old!.indexOf(findText) + findText.length };
        } else {
          // 逐字 0 命中：宽容匹配（空白/全半角标点/引号/省略号/CRLF 差异）。
          // 只在恰好唯一命中时放行；匹配失败仍报错让模型重新复制。
          hit = fuzzyFindAnchor(old!, findText);
          if (!hit) return '错误：find_text 在笔记中没有找到（已尝试忽略空白与标点差异）。请先 read_note，从返回结果里原样复制（含空格与标点）。';
        }
        next = old!.slice(0, hit.start) + replaceText + old!.slice(hit.end);
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

      // 「自动应用」只对 patch 生效；「自主模式」下所有写入都免确认。
      // 漂移（笔记被用户改过）永远要人工确认，任何模式下都不悄悄覆盖。
      const autoOk = prefsRef.current.autonomous
        || (prefsRef.current.autoApply && !isNew && name === 'propose_note_patch');
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
          ? '用户放弃了这次修改（笔记已被用户改动过）。不要基于旧内容重新提案；先重新 read_note 拿最新原文，再按用户的新要求提案。'
          : '用户拒绝了这次修改。同一提案不要再次提交（内容相同或近似都算重复）；先问用户想怎么调整，得到新方向后再重新提案。';
      }
      try {
        await onSave(path, next);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patchProposal(itemId, { status: 'failed', error: msg });
        return `写入失败：${msg}`;
      }
      // 同步推进本地快照：vault.save 内部会换 docs 引用，但面板的 docsRef 只靠 passive effect
      // 同步（晚于微任务）。同一轮里模型常连续提多处 patch，第二处若读旧正文，
      // 会把第一处刚写进去的改动算没、再整篇覆盖回去（静默丢改动）。
      docsRef.current = new Map(docsRef.current).set(path, next);
      patchProposal(itemId, { status: 'applied', autoApplied: autoOk && !drifted });
      if (autoOk && !drifted) {
        // 自动应用/自主模式静默落盘：必须让用户看见「笔记已经变了」。
        toast(isNew ? `已自动创建笔记「${path}」` : `已自动应用对「${path}」的修改`, 'ok', 4200);
      }
      return isNew
        ? `已在「${path}」创建笔记。`
        : `已把修改写入「${path}」。`;
    }

    return `错误：未知工具 ${name}。`;
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // 队列里排的是「本轮跑完自动接续」的消息。按停止＝不要继续跑了：
    // 留着会被下一次运行的 finally 取走，在用户没要求的时候静默补发；
    // 直接丢掉又会吞掉用户敲的字，所以退回输入框让他自己决定发不发。
    if (queueRef.current.length) {
      const back = queueRef.current.join('\n');
      queueRef.current = [];
      setQueued([]);
      setInput((cur) => (cur.trim() ? `${cur}\n${back}` : back));
    }
  };

  const createSession = () => {
    const s = freshSession();
    setSessions((cur) => [...cur, s]);
    setActiveId(s.id);
  };

  const deleteSession = () => {
    // 会话一旦删掉就找不回来（对话记录不随笔记进历史版本），有内容时先问一句
    if (active.items.length
      && !window.confirm(`删除会话「${active.title}」？这段对话记录会一起删除，无法恢复。`)) return;
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
    // 选段只属于本轮：同步清掉 ref，排队续跑（同一闭包递归调用）才不会把同一段选段再注入一次
    const quoteForTurn = pendingQuoteRef.current;
    pendingQuoteRef.current = null;
    setPendingQuote(null);
    // 历史快照先取（不含本轮消息）；当前 user 消息随后的追加只影响 UI 与下一轮
    const history = buildHistoryMessages(
      itemsRef.current
        .filter((i): i is Extract<ChatItem, { kind: 'msg' }> => i.kind === 'msg')
        .map((i) => ({ role: i.role, text: i.text }))
    );
    const userItem: ChatItem = { kind: 'msg', id: idRef.current++, role: 'user', text, quote: quoteForTurn ?? undefined };
    itemsRef.current = [...itemsRef.current, userItem];
    updateActive((s) => ({
      ...s,
      // 首条用户消息做会话标题
      title: s.items.some((i) => i.kind === 'msg' && i.role === 'user') ? s.title : text.slice(0, 24),
      updatedAt: Date.now(),
      items: [...s.items, userItem],
    }));
    runningRef.current = true;
    setRunning(true);
    streamRef.current = '';
    setStreamText('');
    setThinkingText('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let wasAborted = false;
    let thinkAccum = '';
    // 停顿看门狗：连接卡死时流不会给出任何事件（这不是「模型在思考」，思考会走 thinking 增量），
    // 面板会一直停在「停止」按钮上等下去。任何事件都会刷新 lastEventRef。
    // 例外：等用户在提案卡上点「应用/拒绝」时没有流事件是正常的——读 diff、想清楚都可能超过
    // 阈值，绝不能当成连接卡死杀掉整个任务；有 pendingRef 待裁决时就一直续命等下去。
    let stalled = false;
    lastEventRef.current = Date.now();
    const watchdog = window.setInterval(() => {
      if (pendingRef.current.size > 0) { lastEventRef.current = Date.now(); return; }
      if (Date.now() - lastEventRef.current > STALL_IDLE_MS) { stalled = true; ctrl.abort(); }
    }, 5_000);

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
    // 编辑器「问 AI」选段：作为最高优先引用附上，模型自动知道针对这段话回答
    if (quoteForTurn) {
      const from = quoteForTurn.path ? `（来自：${quoteForTurn.path}）` : '';
      wireContent = `${wireContent}\n\n---\n【用户选中的原文】${from}\n${truncateForModel(quoteForTurn.text, MENTION_CONTENT_LIMIT)}`
        + '\n（用户的问题针对上面这段选中的原文，请围绕它回答。）';
    }

    const agentMd = docsRef.current.get(AGENT_MD);
    const sys = buildNoteSystemPrompt(currentPath, agentMd ? truncateForModel(agentMd, 4_000) : null)
      + (prefsRef.current.readonly
        ? '\n只读模式：本次会话没有提供任何写入工具，只做阅读、检索与讨论。'
        : prefsRef.current.autonomous
          ? '\n自主模式：写入操作免确认直接生效（自动存历史版本，可回溯）。仍必须先 read_note 拿最新原文再动手；'
            + '发现笔记被用户改过会停下询问；改动保持最小，删除或整篇重写要格外谨慎。'
          : '');
    const wire: WireMessage[] = [
      { role: 'system', content: sys },
      ...history,
      { role: 'user', content: wireContent },
    ];

    const agentOpts: RunAgentOptions = {
      settings: settingsRef.current,
      messages: wire,
      tools: prefsRef.current.readonly ? READONLY_TOOLS : ALL_AGENT_TOOLS,
      executeTool,
      signal: ctrl.signal,
      onDelta: (t) => { lastEventRef.current = Date.now(); streamRef.current += t; setStreamText(streamRef.current); },
      onThinking: (t) => {
        lastEventRef.current = Date.now();
        thinkAccum += t;
        setThinkingText((s) => s + t);
      },
      onAssistantMessage: (msg) => {
        lastEventRef.current = Date.now();
        if (thinkAccum) {
          push({ kind: 'thinking', id: idRef.current++, text: thinkAccum });
          thinkAccum = '';
          setThinkingText('');
        }
        if (msg.content) {
          push({ kind: 'msg', id: idRef.current++, role: 'assistant', text: msg.content });
        }
        streamRef.current = '';
        setStreamText('');
      },
      onUsage: applyUsage,
    };

    try {
      try {
        await runPiAgent(agentOpts);
      } catch (e) {
        // pi 引擎包加载失败（而非模型/网络错误）时回退内置引擎，助手不至于不可用
        if (!(e instanceof PiUnavailableError)) throw e;
        await runAgent(agentOpts);
      }
    } catch (e) {
      if (isAbortError(e)) wasAborted = true;
      push({
        kind: 'error', id: idRef.current++,
        text: stalled
          ? `连接超过 ${Math.round(STALL_IDLE_MS / 1000)} 秒没有任何响应，已自动中止。可重试，或换一个服务商/模型。`
          : isAbortError(e) ? '已停止。' : agentNetHint(e),
      });
    } finally {
      window.clearInterval(watchdog);
      runningRef.current = false;
      setRunning(false);
      // 已流出但没落定的正文不要丢：停止/流中途出错时落成一条「未写完」的消息
      // （正常收尾时 onAssistantMessage 已经把正文推成正式消息并清空了 ref）
      if (streamRef.current.trim()) {
        push({ kind: 'msg', id: idRef.current++, role: 'assistant', text: streamRef.current, partial: true });
      }
      streamRef.current = '';
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
        <div className="agent-brand">
          <span className="agent-brand-dot" aria-hidden="true" />
          <span className="agent-brand-name">AI 笔记</span>
        </div>
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

      <div
        className="agent-log"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={running}
        aria-label="AI 笔记对话"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!items.length && !running && (
          <div className="agent-empty">
            <p className="agent-empty-title">让 AI 陪你把知识学扎实。</p>
            <p className="muted">
              出题自测、费曼追问、串联双链、整理笔记——写入类操作都会先给你<strong>对比预览</strong>，点「应用」才落盘。
            </p>
            <div className="agent-suggestions">
              {(currentPath
                ? [
                    { insert: `/出题 ${currentPath}`, label: '出题自测', desc: '3-5 道题，先答后评' },
                    { insert: `/费曼 ${currentPath}`, label: '费曼检验', desc: '你讲我挑错，讲透为止' },
                    { insert: `/追问 ${currentPath}`, label: '追问检验', desc: '为什么/怎么解释，答完才纠偏' },
                    { insert: `/串联 ${currentPath}`, label: '串联双链', desc: '找出该连未连的笔记' },
                  ]
                : [
                    { insert: '/出题 ', label: '出题自测', desc: '围绕任意主题出题' },
                    { insert: '/费曼 ', label: '费曼检验', desc: '用自己的话讲一遍' },
                    { insert: '/追问 ', label: '追问检验', desc: '先答追问，再看标准说法' },
                    { insert: '/错题归因 ', label: '错题归因', desc: '按错因分派补救动作' },
                    { insert: '今天我该先复习什么？', label: '今日计划', desc: '按到期卡给建议' },
                  ]
              ).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="agent-starter"
                  onClick={() => {
                    setInput(s.insert);
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="agent-starter-label">{s.label}</span>
                  <span className="agent-starter-desc" aria-hidden="true">{s.desc}</span>
                </button>
              ))}
            </div>
            <p className="muted">
              输入 <code>@</code> 引用一篇笔记 · 输入 <code>/</code> 用命令（内置学习模板，<code>{CMD_DIR}</code> 下同名笔记可覆盖）·
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
                {item.partial && <p className="agent-partial">（已停止，以上为未写完的回答）</p>}
                <CitationCheck text={item.text} docs={citationDocs} />
              </div>
            ) : (
              <div key={item.id} className="agent-msg user">
                {item.quote && (
                  <div className="agent-quote-in-msg">
                    <span className="agent-quote-chip-path">
                      {item.quote.path ? `来自 ${item.quote.path}` : '来自当前选区'}
                    </span>
                    <div className="agent-quote-in-msg-text">{item.quote.text}</div>
                </div>
                )}
                {item.text}
              </div>
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
                <summary>思考过程</summary>
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
                  <ProposalDiff old={item.old} next={item.next} />
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
            <summary>思考中…</summary>
            <div className="agent-thinking-body">{thinkingText}</div>
          </details>
        )}
        {running && streamText && (streamHtml ? (
          <div className="agent-msg assistant streaming markdown-body" dangerouslySetInnerHTML={{ __html: streamHtml }} />
        ) : (
          <div className="agent-msg assistant streaming">{streamText}</div>
        ))}
        {queued.map((q, i) => (
          <div key={`queued-${i}`} className="agent-queued">
            <span className="agent-queued-text">{q}</span>
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
        {pendingQuote && (
          <div className="agent-quote-chip" role="status" aria-label="已附加选段">
            <span className="agent-quote-chip-icon" aria-hidden="true">✦</span>
            <span className="agent-quote-chip-body">
              <span className="agent-quote-chip-path">
                {pendingQuote.path ? `来自 ${pendingQuote.path}` : '来自当前选区'}
              </span>
              <span className="agent-quote-chip-text">{truncateForModel(pendingQuote.text, 120)}</span>
            </span>
            <button
              type="button"
              className="agent-quote-chip-x"
              aria-label="移除引用"
              onClick={() => setPendingQuote(null)}
            >×</button>
          </div>
        )}
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
          aria-label="对 AI 笔记说点什么"
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
          只读
        </button>
        <button
          className={`pref-chip ${prefs.autoApply ? 'on' : ''}`}
          onClick={() => setPrefs((p) => ({ ...p, autoApply: !p.autoApply }))}
          aria-pressed={prefs.autoApply}
          title="自动应用定点修改（patch），diff 仍会显示；整篇重写与新建仍需确认，笔记被改过时仍会先询问"
        >
          自动应用
        </button>
        <button
          className={`pref-chip ${prefs.autonomous ? 'on' : ''}`}
          onClick={() => {
            if (prefs.autonomous) { setPrefs((p) => ({ ...p, autonomous: false })); return; }
            if (window.confirm('开启自主模式后，AI 的新建与修改将免确认直接写入（自动进历史版本，可回溯）。笔记被你改过时仍会先询问。确定开启吗？')) {
              setPrefs((p) => ({ ...p, autonomous: true }));
            }
          }}
          aria-pressed={prefs.autonomous}
          title="自主模式：所有写入提案免确认直接落盘（历史版本可回溯；笔记被改过时仍会先询问）"
        >
          自主
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
        修改笔记默认需你确认后才会写入（「自主」模式下免确认），并自动存入历史版本。会话与配置只保存在本机浏览器；消息内容会发送给你配置的模型服务商，请勿包含患者信息等敏感数据。
      </p>
    </div>
  );
}

function toolIcon(name: string): string {
  if (name === 'list_notes') return '目录';
  if (name === 'search_notes') return '搜索';
  if (name === 'read_note') return '读取';
  if (name === 'get_review_due') return '复习';
  if (name === 'get_study_summary') return '概况';
  if (name === 'get_weak_chapters') return '错题';
  if (name === 'get_quiz_progress') return '题库';
  if (name === 'list_medical_books' || name === 'search_medical_books') return '教材';
  if (name === 'verify_quote') return '核验';
  if (name === 'propose_card_hints') return '提示键';
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

  // 医学教材库：本机索引的管理（导入 / 清单 / 删除）
  const [medBooks, setMedBooks] = useState<MedBookMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const medFileRef = useRef<HTMLInputElement>(null);

  const refreshMedBooks = async () => setMedBooks(await medBookRecords());
  useEffect(() => {
    let alive = true;
    void medBookRecords().then((rows) => { if (alive) setMedBooks(rows); });
    return () => { alive = false; };
  }, []);

  /** 导入教材 PDF：convert/pdf.js 体量大，动态引入；逐个解析并入库，扫描件会失败但不断批 */
  const importMedBooks = async (files: File[]) => {
    if (!files.length || importing) return;
    setImporting(true);
    setImportMsg('');
    try {
      const { importMedPdfFiles } = await import('../core/medImport');
      const res = await importMedPdfFiles(files, (p) => setImportMsg(`${p.label}（${p.done}/${p.total}）`));
      const parts = [`已导入 ${res.imported.length} 本`];
      if (res.overwritten.length) {
        parts.push(`覆盖同名 ${res.overwritten.length} 本：${res.overwritten.join('、')}`);
      }
      if (res.failed.length) {
        parts.push(`${res.failed.length} 本失败：${res.failed.map((f) => f.name).join('、')}`);
      }
      setImportMsg(parts.join('；'));
      await refreshMedBooks();
    } catch (e) {
      setImportMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const deleteMedBook = async (name: string) => {
    if (!window.confirm(`删除教材「${name}」的本地索引？删除后需重新导入 PDF 才能恢复。`)) return;
    await medBookRemove(name);
    await refreshMedBooks();
  };

  const valid = /^https?:\/\//.test(baseUrl.trim()) && !!model.trim();

  /** 连通性测试：真实发一条短请求；成功后顺手拉 /models 做模型名候选。
   *  中转站友好：404 且地址没带 /vN 版本段时自动补 /v1 重试一次并回填输入框。 */
  const test = async () => {
    const orig = baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(orig) || !model.trim()) {
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
    const body = JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false });
    try {
      let base = orig;
      let res = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers, body });
      if (res.status === 404 && !/\/v\d+[a-z]*$/i.test(base)) {
        base = `${orig}/v1`;
        res = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers, body });
        if (res.ok) setBaseUrl(base);
      }
      if (res.ok) {
        try {
          const mres = await fetch(`${base}/models`, { signal: ctrl.signal, headers });
          if (mres.ok) {
            const data = await mres.json() as { data?: Array<{ id?: string }> };
            setModels((data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 100));
          }
        } catch { /* /models 可选，失败不影响连接结果 */ }
        setResult({ ok: true, text: base === orig ? '连接成功' : `连接成功（地址已自动补全为 ${base}）` });
      } else {
        const t = await res.text().catch(() => '');
        const hint = res.status === 404 ? '。404：确认地址是否要以 /v1 结尾，或查看中转站的接口路径说明' : '';
        setResult({ ok: false, text: `${res.status}：${t.slice(0, 160) || res.statusText}${hint}` });
      }
    } catch (e) {
      setResult({ ok: false, text: isAbortError(e) ? '连接超时' : agentNetHint(e) });
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
              if (p.baseUrl) setBaseUrl(p.baseUrl);
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
      <div className="agent-field">
        <span>医学教材库（本机索引）</span>
        <div className="agent-medbooks-actions">
          <button
            className="btn-small"
            disabled={importing}
            onClick={() => medFileRef.current?.click()}
          >
            {importing ? '导入中…' : '导入教材 PDF'}
          </button>
          <span className="muted">{medBooks.length ? `已导入 ${medBooks.length} 本` : '尚未导入'}</span>
          <input
            ref={medFileRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void importMedBooks(files);
            }}
          />
        </div>
        {medBooks.length > 0 && (
          <ul className="agent-medbooks-list">
            {medBooks.map((b) => (
              <li key={b.name}>
                <span className="agent-medbooks-name" title={`${b.chars.toLocaleString()} 字`}>{b.name}</span>
                <span className="muted">{b.pages} 页</span>
                <button
                  className="agent-medbooks-del"
                  title="删除这本教材索引"
                  onClick={() => void deleteMedBook(b.name)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="agent-settings-hint muted">
        导入的教材只存在本机（浏览器 IndexedDB），助手用 list_medical_books / search_medical_books 检索。
        页码按 PDF 物理页计（从封面第 1 页数起），可能与原书印刷页码相差前言/目录的页数。
        扫描版 PDF（无文字层）无法导入，需先 OCR。
      </p>
      {importMsg && <p className="agent-settings-hint muted">{importMsg}</p>}
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
