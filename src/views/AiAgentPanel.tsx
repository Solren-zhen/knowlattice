/**
 * AI 笔记助手（对标 Obsidian 的 Claudian 插件）：
 * - 侧栏多会话对话，agent 可用工具检索笔记（列目录 / 搜索 / 读取）
 * - 两档模式：read（默认，写入先出 diff 等用户点「应用」）与 yolo（写入免确认）。
 *   应用前若发现笔记已被用户改过，先弹覆盖确认再动手，yolo 下同样要确认。
 *   旧的中间档「自动应用」（只有 patch 免确认）已删——它和 yolo 的差别只是
 *   「整篇重写仍要确认」，三档并存时用户得先想清楚自己在哪一档，收益不抵心智成本。
 * - Claudian 式交互：@路径 引用笔记（附内容进上下文）、/斜杠命令（AI命令/ 目录
 *   下的笔记，$ARGUMENTS 传参）、AGENT.md 自定义指南（对应 CLAUDE.md）、
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
  formatMedBooks, formatMedHits, medBookFullText, medBookPage, medBookRecords, medBookRemove, medBooksList, medBooksSearch,
  type MedBookHit, type MedBookMeta,
} from '../core/medBooks';
import { PiUnavailableError, runPiAgent } from '../core/piAgent';
import { collapseDiff, diffLines } from '../core/aiDiff';
import { LEARNING_TOOLS, quizProgressReport, reviewDueReport, reviewPlanPrompt, studySummaryReport, weakChaptersReport } from '../core/aiLearning';
import { appendStudyLogEntry, studyLogEntryFromArgs, studyLogPath } from '../core/aiStudyLog';
import { loadBanks } from '../core/qbank';
import { initializeStats } from '../core/qbankStats';
import { cardHints } from '../core/srsCards';
import { renderMarkdown } from '../core/markdown';
import { CITE_LABEL, CITE_MARK, lookupQuote, verifyCitations, verifyQuote } from '../core/citeVerify';
import { parseSynonymLines, setUserSynonymGroups, USER_SYNONYMS_KEY } from '../core/medSynonyms';
import { setMedBookPageOffset } from '../storage/medStore';
import { safeVaultPath } from '../core/vault';
import { fuzzyFindAnchor, type AnchorHit } from '../core/aiPatch';
import { toast } from '../core/feedback';
import { bumpRecallHits, lookupRecall, saveRecall, type RecallEntry } from '../core/localRecall';
import { useEsc, escThenClose } from './useEsc';
import { IconClose, IconLattice, IconTrash } from './icons';
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

/** 从别处「问 AI」带进来的上下文：发送时附进消息上下文，气泡里展示引用卡。
 *  - 编辑器右键选段：只有 text + path
 *  - 复习卡 / 错题本 / 题库：额外带 ask（预填一句话，用户可改再发）
 *  ask 只预填、不自动发送 —— 与「先预览后写入」同一条原则：AI 动手前先让用户过一眼。 */
export type QuoteSelection = {
  text: string;
  path: string | null;
  /** 预填到输入框的建议问法（输入框已有内容时不覆盖） */
  ask?: string;
};

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
      /** yolo 静默落盘（未漂移） */
      autoApplied?: boolean;
      drifted?: boolean;
      /** status = failed 时的写入错误信息 */
      error?: string;
    }
  | { kind: 'error'; id: number; text: string };

interface SessionUsage { promptTokens: number; completionTokens: number; estimated: boolean }

/** 只有一个开关：yolo=true 时所有写入提案免确认直接落盘（漂移确认保留）；
 *  缺省即 read——写入先出 diff 卡片等用户点「应用」。两档工具集相同，
 *  差别只在落盘要不要等确认，所以一个布尔就够；用枚举会多一层无用的互斥判断。 */
interface AgentPrefs { yolo: boolean }

interface AgentSession {
  id: string;
  title: string;
  updatedAt: number;
  usage: SessionUsage;
  items: ChatItem[];
  /** 陪练模式：会话级开关。开着的会话在系统提示里加陪练契约（先测后讲、一次一题） */
  coach?: boolean;
}

const ZERO_USAGE: SessionUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
const DEFAULT_PREFS: AgentPrefs = { yolo: false };
/** 停顿看门狗阈值：这么久没有任何流事件就认为连接卡死（模型思考会走 thinking 增量） */
const STALL_IDLE_MS = 120_000;

/** 全部工具＝笔记工具＋学习状态工具。两档模式都给同一套工具：
 *  差别只在「写入要不要等用户点应用」，而不是「能不能写」——read 档若拿掉写入工具，
 *  diff 预览＋人工确认这条主写入路径就整个消失了，那是砍功能，不是简化界面。 */
const ALL_AGENT_TOOLS = [...NOTE_AGENT_TOOLS, ...MEDBOOK_TOOLS, ...LEARNING_TOOLS];

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
    // 旧版本存的是 { readonly, autoApply, autonomous } 三档。只把 autonomous 迁到 yolo：
    // 老的 autoApply（仅 patch 免确认、整篇重写仍问）语义已不存在，把它当 yolo 会悄悄
    // 放宽权限，宁可退回默认的 read 让用户自己重开一次。
    const p = JSON.parse(raw) as Partial<AgentPrefs> & { autonomous?: boolean };
    return { yolo: p.yolo === true || p.autonomous === true };
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

/** 相对时间（会话列表用）：分钟内「刚刚」，当天按小时，其余按天 */
function fmtAgo(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

export default function AiAgentPanel({
  onClose, docs, onSave, onOpenPath, currentPath, resolveLink, quote, onQuoteConsumed,
}: Props) {
  /** 会话切换弹层开着时 Esc 只关弹层，不把整块面板带走（ref 供栈顶闭包读最新值） */
  const switcherOpenRef = useRef(false);
  useEsc((e) => {
    if (switcherOpenRef.current) {
      switcherOpenRef.current = false;
      setSwitcherOpen(false);
      return;
    }
    escThenClose(onClose)(e);
  });
  const [settings, setSettings] = useState<AgentSettings | null>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(() => !loadSettings());
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    const loaded = loadSessions();
    return loaded.length ? loaded : [freshSession()];
  });
  const [activeId, setActiveId] = useState<string>(() => sessions[0].id);
  const [input, setInput] = useState('');
  /** 当前输入在本地速查里命中的历史答案（命中才提示，未命中原样发送） */
  const [recallHit, setRecallHit] = useState<RecallEntry | null>(null);
  const [running, setRunning] = useState(false);
  /** 进行中那一轮助手回复的流式正文 / 思考过程 */
  const [streamText, setStreamText] = useState('');
  const streamHtml = useDeferredMarkdown(streamText);
  const [thinkingText, setThinkingText] = useState('');
  /** read / yolo 偏好 */
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
  /** 会话切换弹层 / 重命名行 */
  const [switcherOpen, setSwitcherOpenState] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  /** 视口是否贴底（state 只驱动「回到底部」按钮的显隐，跟随逻辑仍在 pinnedRef） */
  const [atBottom, setAtBottom] = useState(true);

  const setSwitcherOpen = (v: boolean) => {
    switcherOpenRef.current = v;
    setSwitcherOpenState(v);
  };

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
  /** 活跃会话的陪练开关（排队续跑等异步路径里读最新值） */
  const coachRef = useRef(false);
  useEffect(() => { coachRef.current = !!active?.coach; });
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
  // 消费别处「问 AI」带进来的上下文：进入待发送区，等用户补一句话再发
  useEffect(() => {
    if (quote && quote.text.trim()) {
      pendingQuoteRef.current = quote;
      setPendingQuote(quote);
      // 带 ask 的入口（复习卡 / 错题本 / 题库）顺手把问法预填好：一次点击就能发。
      // 直接覆盖而不是「只在空时填」：每次点「问 AI」都是一次显式动作，
      // 留着上一次的预填会让输入框和新引用对不上（那是更糟的误导）。 */
      if (quote.ask) setInput(quote.ask);
      onQuoteConsumed?.();
    }
  }, [quote, onQuoteConsumed]);
  // 输入框随内容自适应高度（约 1~8 行）：单行提问时输入区更轻，长贴文也不至于把对话区挤没
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
  }, [input]);

  const updateActive = (patch: (s: AgentSession) => AgentSession) =>
    setSessions((cur) => cur.map((s) => (s.id === activeId ? patch(s) : s)));

  const push = (item: ChatItem) => {
    itemsRef.current = [...itemsRef.current, item];
    updateActive((s) => ({ ...s, updatedAt: Date.now(), items: [...s.items, item] }));
  };

  /**
   * 输入内容变化时看一眼本地速查（localStorage 一次读，内部有原始字符串缓存）。
   * 命中只**提示**、不自动复用：缓存会过期，静默返回旧答案会让用户以为模型又答了一遍。
   * 速查本身任何异常都不影响发送 —— 出错就当没命中。
   */
  useEffect(() => {
    let hit: RecallEntry | null = null;
    try {
      hit = lookupRecall(input);
    } catch {
      hit = null;
    }
    setRecallHit(hit);
  }, [input]);

  /** 复用本地已有答案：不调模型，直接把历史答案落成一条助手消息（并记一次复用） */
  const reuseRecall = () => {
    const hit = recallHit;
    if (!hit) return;
    setRecallHit(null);
    // 标记在正文最前面，用 Markdown 引用块让用户一眼看出这条不是刚生成的
    push({
      kind: 'msg',
      id: idRef.current++,
      role: 'assistant',
      text: `> 复用本地已有答案（未重新生成）\n\n${hit.a}`,
    });
    try {
      bumpRecallHits(hit.q);
    } catch { /* 计数写不进去不影响这次复用 */ }
    setInput('');
    setMention(null);
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
      push({ kind: 'tool', id: idRef.current++, name, summary: '全部笔记', detail: result });
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
      push({ kind: 'tool', id: idRef.current++, name, summary: path, detail: result });
      return result;
    }

    if (name === 'read_med_book_page') {
      const wantBook = String(args.book ?? '').trim();
      const page = Math.floor(Number(args.page) || 0);
      if (!wantBook || !page) return '错误：需要 book（书名关键字）与 page（页码，与检索结果一致）。';
      try {
        const p = await medBookPage(wantBook, page);
        if (!p) {
          const msg = `错误：找不到《${wantBook}》的第 ${page} 页。可先用 list_medical_books 确认书名，或用 search_medical_books 确认页码。`;
          push({ kind: 'tool', id: idRef.current++, name, summary: '读取教材页失败', detail: msg });
          return msg;
        }
        // 整页原文一并进引用核验证据池：跨段引文也能核到
        recordBookEvidence([{
          book: p.book, page: p.printed, endPage: 0, section: '', text: p.text,
          chunkId: `${p.book}#page${p.pdfPage}`, score: 0,
        }]);
        const result = `《${p.book}》 P${p.printed}（PDF 第 ${p.pdfPage} 页）\n${truncateForModel(p.text)}`;
        push({ kind: 'tool', id: idRef.current++, name, summary: `${p.book} P${p.printed}`, detail: result });
        return result;
      } catch (e) {
        if (isAbortError(e)) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        push({ kind: 'tool', id: idRef.current++, name, summary: '读取教材页失败', detail: msg });
        return msg;
      }
    }

    if (name === 'verify_quote') {
      const quote = String(args.quote ?? '').trim();
      if (!quote) return '错误：缺少 quote（要核验的引文）。';
      // 教材来源：按书名（+页码）从教材库取原文核验——整页/整本出自 medStore，
      // 不受检索结果截断与会话证据缓存的限制，跨段引文也不会误判
      const wantBook = String(args.book ?? '').trim();
      const wantPage = Math.floor(Number(args.page) || 0);
      if (wantBook) {
        const src = wantPage
          ? await medBookPage(wantBook, wantPage)
          : await medBookFullText(wantBook).then((b) => b && { book: b.book, printed: 0, pdfPage: 0, text: b.text });
        if (!src) {
          const msg = `错误：找不到来源教材${wantPage ? `「${wantBook}」第 ${wantPage} 页` : `「${wantBook}」`}。`
            + '可先用 list_medical_books / search_medical_books 确认书名与页码。';
          push({ kind: 'tool', id: idRef.current++, name, summary: '核验引文失败', detail: msg });
          return msg;
        }
        const where = wantPage ? `《${src.book}》 P${src.printed}` : `《${src.book}》全书`;
        const st = verifyQuote(quote, src.text);
        const result = `${CITE_MARK[st]} ${CITE_LABEL[st]}（来源：${where}）\n引文：“${quote}”`;
        push({ kind: 'tool', id: idRef.current++, name, summary: `核验引文（${CITE_LABEL[st]}）`, detail: result });
        return result;
      }
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
          push({ kind: 'tool', id: idRef.current++, name, summary: '已导入教材', detail: result });
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
      push({ kind: 'tool', id: idRef.current++, name, summary: '今日复习队列', detail: result });
      return result;
    }
    if (name === 'get_study_summary') {
      const result = studySummaryReport([...docsRef.current.keys()], docsRef.current);
      push({ kind: 'tool', id: idRef.current++, name, summary: '打卡与复习卡概况', detail: result });
      return result;
    }
    if (name === 'get_weak_chapters') {
      const result = weakChaptersReport();
      push({ kind: 'tool', id: idRef.current++, name, summary: '薄弱章节与错因', detail: result });
      return result;
    }
    if (name === 'get_quiz_progress') {
      try {
        const [banks, stats] = await Promise.all([loadBanks(), initializeStats()]);
        const result = quizProgressReport(banks, stats);
        push({ kind: 'tool', id: idRef.current++, name, summary: '题库进度', detail: result });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `错误：读取题库练习记录失败（${msg}）。可稍后重试。`;
      }
    }

    if (name === 'propose_note_edit' || name === 'propose_note_patch' || name === 'propose_note_create' || name === 'propose_card_hints' || name === 'propose_study_log') {
      // 学习日志的路径与内容由代码定位/组装（今天哪篇、追加成什么样），模型只给条目字段
      const isLog = name === 'propose_study_log';
      const path = isLog ? studyLogPath(new Date()) : safeVaultPath(String(args.path ?? ''));
      if (!path) return '错误：路径不合法（需要库内相对路径，如 解剖/心脏.md）。';
      const old = docsRef.current.get(path);
      const isNew = isLog ? old === undefined : name === 'propose_note_create';
      if (!isLog) {
        if (isNew && old !== undefined) return `错误：「${path}」已存在，请改用 propose_note_edit / propose_note_patch 修改它。`;
        if (!isNew && old === undefined) return `错误：「${path}」不存在，请先用 list_notes 或 search_notes 确认路径。`;
      }

      // patch：锚文本唯一性校验后算出新正文；hints：小节定位后插属性键骨架；log：追加小节；edit/create 直接用模型给的整篇
      let next: string;
      if (isLog) {
        const entry = studyLogEntryFromArgs(args);
        if (typeof entry === 'string') return entry;
        next = appendStudyLogEntry(old, entry, new Date());
      } else if (name === 'propose_card_hints') {
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

      // yolo：所有写入都免确认。漂移（笔记被用户改过）永远要人工确认，
      // 任何模式下都不悄悄覆盖用户的手改。
      const autoOk = prefsRef.current.yolo;
      let decision: Decision;
      let drifted = false;
      if (autoOk) {
        decision = 'applied';
      } else {
        decision = await awaitDecision(itemId, signal);
      }

      // 应用前核对：笔记在提案期间被用户改过（新建则是路径被占了）→ 显式确认覆盖。
      // yolo 下同样要停下来问，绝不悄悄覆盖用户的手改。
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
        // yolo 静默落盘：必须让用户看见「笔记已经变了」。
        toast(isNew ? `已自动创建笔记「${path}」` : `已自动应用对「${path}」的修改`, 'ok', 4200);
      }
      if (isLog) return `已把这次学习写入学习日志「${path}」。`;
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

  /** 删除任意会话（会话列表里逐条删）；删光时补一个新会话 */
  const removeSession = (id: string) => {
    const victim = sessions.find((s) => s.id === id);
    if (!victim) return;
    if (victim.items.length
      && !window.confirm(`删除会话「${victim.title}」？这段对话记录会一起删除，无法恢复。`)) return;
    const rest = sessions.filter((s) => s.id !== id);
    if (!rest.length) {
      const f = freshSession();
      setSessions([f]);
      setActiveId(f.id);
      return;
    }
    setSessions(rest);
    if (id === activeId) setActiveId(rest[rest.length - 1].id);
  };

  const renameSession = (id: string, title: string) => {
    setRenamingId(null);
    const t = title.trim();
    if (!t) return;
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title: t.slice(0, 40) } : s)));
  };

  /** 陪练模式开关（会话级）：开着的会话系统提示里加学习契约，界面亮陪练条 */
  const toggleCoach = () => {
    const next = !active.coach;
    coachRef.current = next;
    updateActive((s) => ({ ...s, coach: next }));
  };

  /** 结束陪练：让模型把薄弱点写进学习日志再收尾，然后自动退出陪练模式 */
  const endCoach = () => {
    if (runningRef.current) return;
    coachRef.current = false;
    updateActive((s) => ({ ...s, coach: false }));
    void sendText('结束本次陪练：先总结这次暴露的薄弱点（带 [[双链]]），再用 propose_study_log 写进今天的学习日志，最后用一句话收尾。');
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
      // 发送 /陪练 即进入陪练模式（会话级，界面亮起陪练条；发 /陪练 之外的消息不退出）
      coach: text.trimStart().startsWith('/陪练') ? true : s.coach,
    }));
    if (text.trimStart().startsWith('/陪练')) coachRef.current = true;
    runningRef.current = true;
    setRunning(true);
    streamRef.current = '';
    setStreamText('');
    setThinkingText('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let wasAborted = false;
    let thinkAccum = '';
    // 本轮助手正文累计（工具轮之间的过渡语也算进来，避免把最后一句「已写入…」当成答案存进速查）
    let answerAccum = '';
    // 停顿看门狗：连接卡死时流不会给出任何事件（这不是「模型在思考」，思考会走 thinking 增量），
    // 面板会一直停在「停止」按钮上等下去。任何事件都会刷新 lastEventRef。
    let stalled = false;
    lastEventRef.current = Date.now();
    const watchdog = window.setInterval(() => {
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
    const sys = buildNoteSystemPrompt(currentPath, agentMd ? truncateForModel(agentMd, 4_000) : null, coachRef.current)
      + (prefsRef.current.yolo
        ? '\nyolo 模式：写入操作免确认直接生效（自动存历史版本，可回溯）。仍必须先 read_note 拿最新原文再动手；'
          + '发现笔记被用户改过会停下询问；改动保持最小，删除或整篇重写要格外谨慎。'
        : '\nread 模式：写入一律先出 diff 卡片等用户点「应用」，不要假设已经写入；提案被拒就换方向，别重复提交。');
    const wire: WireMessage[] = [
      { role: 'system', content: sys },
      ...history,
      { role: 'user', content: wireContent },
    ];

    const agentOpts: RunAgentOptions = {
      settings: settingsRef.current,
      messages: wire,
      tools: ALL_AGENT_TOOLS,
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
          answerAccum = answerAccum ? `${answerAccum}\n\n${msg.content}` : msg.content;
          push({ kind: 'msg', id: idRef.current++, role: 'assistant', text: msg.content });
          // 本地速查：存下这一问一答，下次同样的输入可直接复用、不调模型。
          // 问题用用户原始输入（含 /命令 原文），与输入框里 lookupRecall 用的键同源；写失败不影响回复。
          try {
            saveRecall(text, answerAccum);
          } catch { /* 速查写不进去只影响下次能否复用，不能影响这一轮 */ }
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
    <div className={`agent-panel${pendingQuote ? ' has-quote' : ''}`}>
      <div className="ai-header agent-header">
        <div className="agent-brand">
          <span className="agent-brand-mark" aria-hidden="true"><IconLattice size={15} /></span>
          <span className="agent-brand-name">AI 笔记</span>
        </div>
        <button
          type="button"
          className="agent-switcher-btn"
          onClick={() => setSwitcherOpen(!switcherOpen)}
          disabled={running}
          aria-expanded={switcherOpen}
          aria-haspopup="dialog"
          title="切换会话"
        >
          <span className="agent-switcher-title">{active.title}</span>
          <span className="agent-switcher-caret" aria-hidden="true">▾</span>
        </button>
        {switcherOpen && (
          <>
            <div className="agent-switcher-overlay" onClick={() => setSwitcherOpen(false)} />
            <div className="agent-switcher" role="dialog" aria-label="会话列表">
              <div className="agent-switcher-list">
                {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
                  <div key={s.id} className={`agent-session-row ${s.id === activeId ? 'on' : ''}`}>
                    {renamingId === s.id ? (
                      <input
                        className="agent-session-rename"
                        value={renameText}
                        autoFocus
                        maxLength={40}
                        onChange={(e) => setRenameText(e.target.value)}
                        onBlur={() => renameSession(s.id, renameText)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameSession(s.id, renameText);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        aria-label="重命名会话"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="agent-session-main"
                          onClick={() => { setActiveId(s.id); setSwitcherOpen(false); }}
                        >
                          <span className="agent-session-title">{s.title}</span>
                          <span className="agent-session-meta">
                            {s.coach ? '陪练 · ' : ''}{s.items.filter((i) => i.kind === 'msg').length} 条 · {fmtAgo(s.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="agent-session-act"
                          title="重命名"
                          onClick={() => { setRenamingId(s.id); setRenameText(s.title); }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="agent-session-act danger"
                          title="删除会话"
                          disabled={sessions.length <= 1}
                          onClick={() => removeSession(s.id)}
                        >
                          <IconTrash />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="agent-switcher-new"
                onClick={() => { createSession(); setSwitcherOpen(false); }}
              >
                ＋ 新对话
              </button>
            </div>
          </>
        )}
        <button
          className="btn-small"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
        >
          设置
        </button>
        <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
      </div>

      {active.coach && (
        <div className="agent-coach" role="status">
          <span className="agent-coach-dot" aria-hidden="true" />
          <span className="agent-coach-text">
            <strong>陪练中</strong>一次一题 · 答错先给提示 · 讲完必验证
          </span>
          <button type="button" className="agent-coach-end" onClick={endCoach} disabled={running}>
            结束并写日志
          </button>
        </div>
      )}

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

      <div className="agent-body">
        <div
          className={`agent-log${!items.length && !running ? ' is-empty' : ''}`}
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-busy={running}
          aria-label="AI 笔记对话"
          onScroll={(e) => {
            const el = e.currentTarget;
            const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            pinnedRef.current = pinned;
            setAtBottom(pinned);
          }}
        >
        {!items.length && !running && (
          <div className="agent-empty">
            <p className="agent-empty-title">让 AI 陪你把知识学扎实。</p>
            {/* 出处一行：从主页面 hero 移到这里——「谁在做这件事」只在第一次打开
                这个面板时值得占位，进过一轮对话后它就只是噪音。 */}
            <p className="agent-empty-tagline">基于 pi agent 打造的学习助手</p>
            <div className="agent-suggestions">
              {(currentPath
                ? [
                    { insert: `/陪练 ${currentPath}`, label: '陪练模式',
                      tip: '先测后讲：一次只问一题，答错先给提示再揭示\n告一段落时把薄弱点写进今天的学习日志' },
                    { insert: `/出题 ${currentPath}`, label: '出题自测',
                      tip: '出 3-5 道题（问答 / 情景 / 鉴别）\n先只给题目，作答后逐题点评' },
                    { insert: `/费曼 ${currentPath}`, label: '费曼检验',
                      tip: '你先用自己的话讲一遍\nAI 扮演较真的同学挑错、逐条追问' },
                    { insert: `/追问 ${currentPath}`, label: '追问检验',
                      tip: '先给 3-5 个「为什么 / 怎么区分」的追问，不给答案\n作答后指出错漏并补标准说法' },
                    { insert: `/串联 ${currentPath}`, label: '串联双链',
                      tip: '在库里找相关笔记，列出该互链的笔记与理由\n确认后逐篇补 [[双链]]' },
                  ]
                : [
                    { insert: '/陪练 ', label: '陪练模式',
                      tip: '先测后讲：一次只问一题，答错先给提示再揭示\n告一段落时把薄弱点写进今天的学习日志' },
                    { insert: '/出题 ', label: '出题自测',
                      tip: '出 3-5 道题（问答 / 情景 / 鉴别）\n先只给题目，作答后逐题点评' },
                    { insert: '/费曼 ', label: '费曼检验',
                      tip: '你先用自己的话讲一遍\nAI 扮演较真的同学挑错、逐条追问' },
                    { insert: '/错题归因 ', label: '错题归因',
                      tip: '先看错题本的错因分布与薄弱章节\n把错题归到四类错因，再按错因分派补救' },
                    {
                      // 调度由代码算好直接注入（Pion 式分工）：状态就摆在输入框里，教练只管教学
                      insert: reviewPlanPrompt([...docsRef.current.keys()], docsRef.current),
                      label: '今日计划',
                      tip: '把到期复习卡与薄弱章节直接交给 AI\n由它挑 1-2 篇先复习，并对第一篇出题',
                    },
                  ]
              ).map((s) => (
                /* 一行 = 入口 + 常驻气泡。气泡文字不放进 <button>：按钮的可访问名必须
                   保持只有 label（读屏与测试都按「费曼检验」这样的短名字找它）。 */
                <div className="agent-entry" key={s.label}>
                  <button
                    type="button"
                    className="agent-starter"
                    onClick={() => {
                      setInput(s.insert);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="agent-starter-label">{s.label}</span>
                  </button>
                  <span className="agent-bubble">{s.tip}</span>
                </div>
              ))}
            </div>
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
                <summary><span className="agent-tool-tag">{toolIcon(item.name)}</span>{item.summary}</summary>
                <pre className="agent-tool-detail">{item.detail}</pre>
              </details>
            );
          }
          if (item.kind === 'thinking') {
            return (
              <details key={item.id} className="agent-thinking">
                <summary><span className="agent-tool-tag">思考</span>推理过程</summary>
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
        {running && !streamText && !thinkingText && (
          <div className="agent-typing" aria-label="正在准备回复"><span /><span /><span /></div>
        )}
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
        {!atBottom && (
          <button
            type="button"
            className="agent-jump"
            aria-label="回到底部"
            onClick={() => {
              pinnedRef.current = true;
              setAtBottom(true);
              const el = scrollRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}
          >
            ↓
          </button>
        )}
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
        {recallHit && (
          <div className="agent-recall" role="status">
            <span className="agent-recall-text">
              这台设备上已有这条问题的答案（{new Date(recallHit.at).toLocaleDateString()} 存下
              {recallHit.hits > 0 ? ` · 已复用 ${recallHit.hits} 次` : ''}）——复用可省一次调用，但内容可能已过时，需要重新生成时点右侧。
            </span>
            <button className="btn-small" onClick={reuseRecall}>复用上次答案</button>
            <button className="btn-small" onClick={() => setRecallHit(null)}>重新生成</button>
          </div>
        )}
        <div className="agent-composer">
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
            placeholder={settingsValid ? '问点什么…（@ 引用笔记，/ 用命令）' : '先在「设置」里配置模型服务…'}
            rows={1}
            aria-label="对 AI 笔记说点什么"
          />
          <div className="agent-composer-foot">
            {running ? (
              <button className="btn-small agent-stop" onClick={stop}>停止</button>
            ) : (
              <button className="btn-primary agent-send" onClick={submit} disabled={!input.trim() || !settingsValid}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="agent-prefs">
        <button
          className={`pref-chip ${active.coach ? 'on' : ''}`}
          onClick={toggleCoach}
          aria-pressed={!!active.coach}
          title="陪练模式：先测后讲、一次只问一题、答错先给提示；顶部会出现陪练条，学完一键结束并写学习日志"
        >
          陪练
        </button>
        {/* 两档模式：read 是默认态，yolo 要显式点开并确认一次。
            用两个互斥 chip 而不是下拉或开关，是因为「当前在哪一档」必须一眼可见——
            写入权限的档位猜错一次就是一次误改。 */}
        <button
          className={`pref-chip ${prefs.yolo ? '' : 'on'}`}
          onClick={() => setPrefs({ yolo: false })}
          aria-pressed={!prefs.yolo}
          title="read：写入前先给你看 diff，点「应用」才落盘"
        >
          read
        </button>
        <button
          className={`pref-chip ${prefs.yolo ? 'on' : ''}`}
          onClick={() => {
            if (prefs.yolo) return;
            if (window.confirm('切到 yolo 后，AI 的新建与修改免确认直接写入（自动进历史版本，可回溯）。笔记被你改过时仍会先询问。确定切换吗？')) {
              setPrefs({ yolo: true });
            }
          }}
          aria-pressed={prefs.yolo}
          title="yolo：所有写入提案免确认直接落盘（历史版本可回溯；笔记被改过时仍会先询问）"
        >
          yolo
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
    </div>
  );
}

function toolIcon(name: string): string {
  if (name === 'list_notes') return '目录';
  if (name === 'search_notes') return '检索';
  if (name === 'read_note') return '读取';
  if (name === 'get_review_due') return '复习';
  if (name === 'get_study_summary') return '状态';
  if (name === 'get_weak_chapters') return '错题';
  if (name === 'get_quiz_progress') return '题库';
  if (name === 'list_medical_books' || name === 'search_medical_books' || name === 'read_med_book_page') return '教材';
  if (name === 'verify_quote') return '引文';
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

  // 医学教材库：本机索引的管理（导入 / 清单 / 删除 / 页码偏移）
  const [medBooks, setMedBooks] = useState<MedBookMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const medFileRef = useRef<HTMLInputElement>(null);
  /** 文本层抽取失败的书（多为扫描版）：留着手柄供「OCR 重新导入」 */
  const failedFilesRef = useRef<File[]>([]);
  const [canOcr, setCanOcr] = useState(false);
  // 用户自定义等价词组：设置页编辑，blur 时生效并持久化
  const [synText, setSynText] = useState(() => {
    try { return localStorage.getItem(USER_SYNONYMS_KEY) ?? ''; } catch { return ''; }
  });

  const refreshMedBooks = async () => setMedBooks(await medBookRecords());
  useEffect(() => {
    let alive = true;
    void medBookRecords().then((rows) => { if (alive) setMedBooks(rows); });
    return () => { alive = false; };
  }, []);

  /** 导入教材 PDF：convert/pdf.js 体量大，动态引入；逐个解析并入库，扫描件在 ocr 开启时走 OCR 回退 */
  const importMedBooks = async (files: File[], ocr = false) => {
    if (!files.length || importing) return;
    setImporting(true);
    setImportMsg('');
    try {
      const { importMedPdfFiles } = await import('../core/medImport');
      const res = await importMedPdfFiles(files, (p) => setImportMsg(`${p.label}（${p.done}/${p.total}）`), { ocr });
      const failedFiles = res.failed
        .map((f) => files.find((x) => x.name === f.name))
        .filter((x): x is File => !!x);
      failedFilesRef.current = failedFiles;
      setCanOcr(failedFiles.length > 0);
      const parts = [`已导入 ${res.imported.length} 本`];
      if (res.overwritten.length) {
        parts.push(`覆盖同名 ${res.overwritten.length} 本：${res.overwritten.join('、')}`);
      }
      if (res.failed.length) {
        parts.push(`${res.failed.length} 本失败：${res.failed.map((f) => f.name).join('、')}`);
      }
      for (const w of res.warnings) parts.push(w);
      setImportMsg(parts.join('；'));
      await refreshMedBooks();
    } catch (e) {
      setImportMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 页码偏移 = PDF 物理页 − 印刷页（前言/目录的页数）；留空按 0。检索结果据此直接报印刷页码 */
  const commitOffset = async (name: string, raw: string) => {
    const v = raw.trim();
    const n = v === '' ? 0 : Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return;
    try {
      await setMedBookPageOffset(name, n);
      await refreshMedBooks();
    } catch { /* 教材可能刚被删除 */ }
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
          {canOcr && !importing && (
            <button
              className="btn-small"
              onClick={() => void importMedBooks(failedFilesRef.current, true)}
              title="扫描版 PDF 没有文字层，走本地 OCR（每页约 2~5 秒，单次上限 30 页）"
            >
              用 OCR 导入失败的书
            </button>
          )}
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
                <label className="agent-medbooks-offset" title="页码偏移 = PDF 物理页 − 原书印刷页（即前言/目录的页数）。填好后检索结果直接报印刷页码，引用更准确。">
                  偏移
                  <input
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={b.pageOffset ?? 0}
                    onBlur={(e) => void commitOffset(b.name, e.target.value)}
                  />
                </label>
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
      <label className="agent-field">
        <span>自定义等价词组（可选，每行一组、组内词用空格分隔，搜索与教材检索通用）</span>
        <textarea
          value={synText}
          rows={3}
          spellCheck={false}
          placeholder={'如：\n支扩 支气管扩张\nRTA 肾小管酸中毒'}
          onChange={(e) => setSynText(e.target.value)}
          onBlur={() => {
            const groups = parseSynonymLines(synText);
            setUserSynonymGroups(groups);
            try { localStorage.setItem(USER_SYNONYMS_KEY, JSON.stringify(groups)); } catch { /* 存储不可用忽略 */ }
          }}
        />
      </label>
      <p className="agent-settings-hint muted">
        导入的教材只存在本机（浏览器 IndexedDB），助手用 list_medical_books / search_medical_books / read_med_book_page 查阅。
        页码默认按 PDF 物理页计（从封面第 1 页数起），在上面的「偏移」里填前言/目录页数即可换成原书印刷页码。
        扫描版 PDF（无文字层）普通导入会失败，可用「用 OCR 导入失败的书」走本地识别（较慢）。
      </p>
      {importMsg && <p className="agent-settings-hint muted">{importMsg}</p>}
      {hint && <p className="agent-settings-hint muted">{hint}</p>}
      {/* 合规提示从对话区底部移到这里：它是「关于这个助手怎么工作」的说明，
          每次打开面板都占一行是白占地方，放在设置里按需查阅即可。 */}
      <p className="agent-settings-hint muted">
        写入默认需你确认（yolo 模式除外），自动存入历史版本；会话与配置只保存在本机。
        消息会发送给你配置的模型服务商，请勿包含患者信息等敏感数据。
      </p>
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
