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
 *   智谱 / Kimi / OpenRouter / Ollama 均可），配置只存本机；桌面版 API Key 进系统凭据库
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentNetHint, buildHistoryMessages, buildNoteSystemPrompt, detectMention, expandCommand, extractMentionedNotes, formatNoteList,
  isAbortError, listCommands, MEDBOOK_TOOLS, NOTE_AGENT_TOOLS, readNoteSlice, runAgent, searchNotes, truncateForModel,
  type AgentSettings, type MentionHit, type RunAgentOptions, type TokenUsage, type WireMessage,
} from '../core/aiAgent';
import { capToolResult } from '../core/aiBudget';
import {
  citeKeyOf, formatMedBooks, formatMedHits, medBookFullText, medBookPage, medBooksList,
  medBooksSearch, verifyQuotesAgainstBooks,
  type MedBookHit,
} from '../core/medBooks';
import { PiUnavailableError, runPiAgent } from '../core/piAgent';
import { collapseDiff, diffLines } from '../core/aiDiff';
import { LEARNING_TOOLS, quizProgressReport, reviewDueReport, reviewPlanPrompt, studySummaryReport, weakChaptersReport } from '../core/aiLearning';
import {
  applyMastery, clampLevel, loadMastery, MASTERY_LABELS, masteryReport, nextStepHint, saveMastery,
  TUTOR_TOOLS, type MasteryMap,
} from '../core/tutor';
import { appendStudyLogEntry, studyLogEntryFromArgs, studyLogPath } from '../core/aiStudyLog';
import { appendBankQuestions, loadBanks } from '../core/qbank';
import { containsQuestions, importAiQuestions } from '../core/aiQuestionImport';
import { initializeStats } from '../core/qbankStats';
import { renderMarkdown } from '../core/markdown';
import { CITE_LABEL, CITE_MARK, CITE_RANK, lookupQuote, verifyCitations, verifyQuote, type CiteStatus } from '../core/citeVerify';
import { safeVaultPath, BACKUP_RESTORED_EVENT } from '../core/vault';
import { structureLossWarnings } from '../core/aiPatch';
import { applyNotePatch, cleanCardKeys, insertCardHints } from '../core/aiTools';
import { AGENT_TOOL_NAMES, AGENT_TOOL_REGISTRY, createAgentRuntime, makeWriteVerifier } from '../core/agentRuntime';
import {
  collectSkills, collectSouls, distillSkills, findSkill, formatSkillCatalog, formatSoulPrefix, skillBody,
  stripFrontmatter, toSkillMarkdown, validateSkills,
} from '../core/agentSkills';
import { createTraceRecorder } from '../core/agentTrace';
import { adviseCompaction, measureContext } from '../core/agentContextUsage';
import { CONTEXT_TOTAL_BUDGET } from '../core/aiBudget';
import { toast } from '../core/feedback';
import { bumpRecallHits, lookupRecall, saveRecall, type RecallEntry } from '../core/localRecall';
import { useEsc, escThenClose } from './useEsc';
import { IconClose, IconLattice, IconTrash } from './icons';
import Preview from './Preview';
import { loadAgentSettings } from '../core/agentSettings';
import SettingsForm from './AgentSettingsForm';
import {
  fmtAgo,
  fmtTokens,
  freshSession,
  loadPrefs,
  loadSessions,
  persistSessions,
  savePrefs,
  type AgentPrefs,
  type AgentSession,
  type ChatItem,
  type QuoteSelection,
} from './agentChat';

interface Props {
  onClose: () => void;
  /** 一个 AI 入口：面板内切回 AI 问答 */
  onSwitchToAi?: () => void;
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
  /** 一键导师的开场白（Workspace 桥接）：面板消费一次后由 onSeedConsumed 清空 */
  seed?: { text?: string; tutor: boolean } | null;
  onSeedConsumed?: () => void;
}

/** 常见 OpenAI 兼容入口；模型名以服务商控制台为准，可改 */


/** 斜杠命令与 AGENT.md 的约定位置 */
const CMD_DIR = 'AI命令/';
const AGENT_MD = 'AGENT.md';
/** 引用笔记附进上下文时的单篇截断 */
const MENTION_CONTENT_LIMIT = 8_000;

type Decision = 'applied' | 'rejected';



/** 流式正文也吃 markdown 排版：防抖 250ms 渲染（markdown-it 懒加载，首条消息后常驻内存） */
function useDeferredMarkdown(text: string): string {
  const [html, setHtml] = useState('');
  const [debouncedText, setDebouncedText] = useState(text);

  // 防抖：text 变化 250ms 后才更新 debouncedText
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), 250);
    return () => clearTimeout(timer);
  }, [text]);

  // 渲染：只在防抖后的文本变化时执行
  useEffect(() => {
    if (!debouncedText) return; // 空文本不触发渲染，html 保持原值或初始值

    let alive = true;
    renderMarkdown(debouncedText)
      .then((h) => { if (alive) setHtml(h); })
      .catch(() => { /* 渲染失败保持纯文本展示 */ });
    return () => { alive = false; };
  }, [debouncedText]);

  // 派生状态：text 为空时直接返回空字符串，不通过 effect
  return text ? html : '';
}

/** 引用核验徽标：把回答里 “…”〔…〕 形式的引用逐条与库内原文比对，展示四档结论。
 *  没给出原文的标记也照实列出来——否则用户会以为所有引用都核验过了。
 *
 *  带书名的引用另外按需查本机教材原文（不依赖本轮是否检索过这本教材），
 *  否则上一轮查过、或模型直接按记忆写的教材页码会被误报成「未找到出处」。
 *  教材侧结论比笔记侧更好时取教材侧；两边都没命中时，标题里写明「已比对本机教材」，
 *  把「核验过但没有」与「本机没有这本书的索引」区分开。 */
function CitationCheck({ text, docs }: { text: string; docs: Map<string, string> }) {
  /**
   * 只在正文变化时核验一次，**不跟 docs 走**：docs 每次自动保存都会换引用，
   * 挂在它上面等于「用户每敲停一次，所有历史消息都把全库重扫一遍」
   * （5000 篇 × 20 条消息）。引用核验是给人看的快照，不是实时视图；
   * 新收到的消息本来就会带着当时的 docs 算一次。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => verifyCitations(text, docs), [text]);
  const [bookHits, setBookHits] = useState<Map<string, { status: CiteStatus; book: string }>>(new Map());

  useEffect(() => {
    const targets = results.filter((c) => c.book && c.quote);
    if (!targets.length) return;
    let alive = true;
    void (async () => {
      const found = await verifyQuotesAgainstBooks(
        targets.map((c) => ({ book: c.book!, quote: c.quote })),
      ).catch(() => new Map<string, { status: CiteStatus; book: string }>());
      // 只并入不覆盖：旧结论保留，重渲染时徽标不会闪回旧状态
      if (alive && found.size) setBookHits((prev) => new Map([...prev, ...found]));
    })();
    return () => { alive = false; };
  }, [results]);

  if (!results.length) return null;
  return (
    <div className="agent-cites">
      {results.map((c, i) => {
        if (!c.quote) {
          return (
            <span key={i} className="agent-cite agent-cite-nocite" title={`${c.raw}\n没有给出原文，无法逐字核验`}>
              未给出原文
            </span>
          );
        }
        const hit = c.book ? bookHits.get(citeKeyOf(c.book, c.quote)) : undefined;
        const status = hit && CITE_RANK[hit.status] > CITE_RANK[c.status] ? hit.status : c.status;
        const source = hit ? `《${hit.book}》` : c.sourcePath;
        const note = hit
          ? '已比对本机教材原文'
          : c.book ? '本机没有这本书的索引，只比对了笔记库' : '';
        return (
          <span
            key={i}
            className={`agent-cite agent-cite-${status}${c.ambiguous ? ' agent-cite-multi' : ''}`}
            title={`${CITE_LABEL[status]}${source ? `：${source}` : ''}\n“${c.quote}”`
              + (c.ambiguous ? `\n库内 ${c.hits} 篇笔记都含此句，出处不唯一` : '')
              + (note ? `\n（${note}）` : '')}
          >
            {CITE_MARK[status]} {c.quote.length > 18 ? `${c.quote.slice(0, 18)}…` : c.quote}
            {c.page ? ` P${c.page}` : ''}
            {c.ambiguous ? ` · ${c.hits} 处` : ''}
          </span>
        );
      })}
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

/** AI 出题入库的题库名：固定一个，连着导入几轮都追加到同一本 */
const AI_BANK_NAME = 'AI 生成题库';

/**
 * 助手回答里带题目时，给一个「导入题库」入口——把回答里解析出的题目追加进
 * 「AI 生成题库」（同名追加、同题不重复收），题目自动关联当前笔记。
 * 解析不出一题就完全不渲染，不占位。
 */
function ImportQuestionsRow({ text, notePath }: { text: string; notePath?: string | null }) {
  const count = useMemo(
    () => (containsQuestions(text) ? importAiQuestions(text).count : 0),
    [text],
  );
  const [imported, setImported] = useState(0);
  const [busy, setBusy] = useState(false);
  if (!count) return null;

  const run = async () => {
    setBusy(true);
    try {
      const { questions } = importAiQuestions(text, { notePath: notePath ?? undefined });
      const banks = await appendBankQuestions(AI_BANK_NAME, questions);
      const total = banks.find((b) => b.name === AI_BANK_NAME)?.questions.length ?? questions.length;
      setImported(questions.length);
      toast(`已把 ${questions.length} 道题加入「${AI_BANK_NAME}」（题库现有 ${total} 题）`, 'ok');
    } catch (e) {
      toast(`导入题库失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-quiz-import">
      {imported ? (
        <span className="muted">已导入 {imported} 题到「{AI_BANK_NAME}」</span>
      ) : (
        <button className="btn-small" disabled={busy} onClick={() => void run()}>
          {busy ? '导入中…' : `导入题库（${count} 题）`}
        </button>
      )}
    </div>
  );
}

/** 停顿看门狗阈值：这么久没有任何流事件就认为连接卡死（模型思考会走 thinking 增量） */
const STALL_IDLE_MS = 120_000;

/** 全部工具＝笔记工具＋学习状态工具。两档模式都给同一套工具：
 *  差别只在「写入要不要等用户点应用」，而不是「能不能写」——read 档若拿掉写入工具，
 *  diff 预览＋人工确认这条主写入路径就整个消失了，那是砍功能，不是简化界面。 */
const ALL_AGENT_TOOLS = [...NOTE_AGENT_TOOLS, ...MEDBOOK_TOOLS, ...LEARNING_TOOLS, ...TUTOR_TOOLS];

/** seed 的去重键：同一次点击只发一次；没有 text 的一键导师用固定键 */
function seedKey(seed: { text?: string; tutor: boolean }): string {
  return seed.text ?? (seed.tutor ? 'tutor' : 'plain');
}

export default function AiAgentPanel({
  onClose, docs, onSave, onOpenPath, currentPath, resolveLink, quote, onQuoteConsumed, onSwitchToAi,
  seed, onSeedConsumed,
}: Props) {  /** 会话切换弹层开着时 Esc 只关弹层，不把整块面板带走（ref 供栈顶闭包读最新值） */
  const switcherOpenRef = useRef(false);
  useEsc((e) => {
    if (switcherOpenRef.current) {
      switcherOpenRef.current = false;
      setSwitcherOpen(false);
      return;
    }
    escThenClose(onClose)(e);
  });
  const [initialSettings] = useState<AgentSettings | null>(loadAgentSettings);
  const [settings, setSettings] = useState<AgentSettings | null>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(() => !initialSettings);
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
  /** 上一轮的上下文占用读数（只展示，不参与裁剪） */
  const [ctxHint, setCtxHint] = useState('');
  /** 当前正在跑的工具：工具卡已隐藏，至少要有一行「还在干活」的可见状态，
   *  否则模型跑一次长工具（读大笔记、抓网页）就是 20 秒的静止画面。 */
  const [activeTool, setActiveTool] = useState<{ name: string; since: number } | null>(null);
  /** 只用来驱动上面那行的秒数重渲染 */
  const [, setTick] = useState(0);
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

  /**
   * 全部 .md 路径：补全下拉与 @ 引用都要这一份。按**路径签名**memo（与 vault.notePaths 同一手法）：
   * `docs` 每次自动保存都换引用，直接依赖它会在每次按键时重建 5000 条路径的数组 + 过滤。
   */
  const pathSig = useMemo(() => [...docs.keys()].join('\u0000'), [docs]);
  const notePaths = useMemo(() => (pathSig ? pathSig.split('\u0000').filter((p) => p.endsWith('.md')) : []), [pathSig]);
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
  /** 导师模式开关：与 coach 一样走 ref，异步续跑读最新值 */
  const tutorRef = useRef(false);
  useEffect(() => { tutorRef.current = !!active?.tutor; });
  /** 掌握度台账快照：set_mastery 写入后同步更新，让顶部台账条立刻重绘 */
  const [mastery, setMastery] = useState<MasteryMap>(() => loadMastery());
  /** 一键导师：同一段开场白只发一次（面板可能因引用/切换重挂载） */
  const seedSentRef = useRef('');
  /** 开场白在这里拼：reviewPlanPrompt 已在本面板的懒加载链里，放 Workspace 会把学习聚合拖进主包 */
  const buildTutorKickoff = () =>
    `用导师模式开始今天的学习。${reviewPlanPrompt([...docsRef.current.keys()], docsRef.current)}`;
  /* 每轮把最新闭包挂到 ref：seed 的 effect 只按 seed 触发，
     不因 sendText / updateActive / 回调每轮重建而反复执行（否则会重复发送）。 */
  const seedApiRef = useRef<(text: string, tutor: boolean) => void>(() => {});
  const onSeedConsumedRef = useRef(onSeedConsumed);
  useEffect(() => {
    seedApiRef.current = (text, tutor) => {
      if (tutor) {
        tutorRef.current = true;
        coachRef.current = true;
        updateActive((s) => ({ ...s, tutor: true, coach: true }));
      }
      void sendText(text);
    };
    onSeedConsumedRef.current = onSeedConsumed;
  });
  useEffect(() => {
    if (!seed || seedSentRef.current === seedKey(seed)) return;
    seedSentRef.current = seedKey(seed);
    onSeedConsumedRef.current?.();
    seedApiRef.current(seed.text ?? buildTutorKickoff(), seed.tutor);
  }, [seed]);
  const runningRef = useRef(false);
  /* 面板尺寸可拖（左边缘改宽、上边缘改高）。宽度要同步写 .app 的 --side-w：
     主区靠这个变量让位，只改面板宽度会让它压住笔记。 */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sizeDragRef = useRef<{ axis: 'w' | 'h'; x: number; y: number; w: number; h: number } | null>(null);
  const PANEL_SIZE_KEY = 'knowlattice.agent.panel.size';
  const applyPanelSize = (w: number, h: number) => {
    const el = panelRef.current;
    if (!el) return;
    const lim = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi));
    const width = lim(w, 320, Math.max(320, window.innerWidth * 0.96));
    const height = lim(h, 240, Math.max(240, window.innerHeight - 8));
    el.style.width = width + 'px';
    // top:0 + bottom:0 会把 height 撑满；改成贴底定高，拖上边缘才有意义
    el.style.top = 'auto';
    el.style.height = height + 'px';
    const app = el.closest('.app');
    if (app instanceof HTMLElement) app.style.setProperty('--side-w', width + 'px');
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || 'null');
      if (saved && Number(saved.w) > 0 && Number(saved.h) > 0) applyPanelSize(Number(saved.w), Number(saved.h));
    } catch { /* 存坏了就当没存过 */ }
  }, []);
  // 工具耗时秒数：每 500ms 推一次，工具结束时 activeTool 置空自动停
  useEffect(() => {
    if (!activeTool) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [activeTool]);

  useEffect(() => {
    const onResize = () => {
      const el = panelRef.current;
      if (!el || !el.style.width) return;
      applyPanelSize(parseFloat(el.style.width), parseFloat(el.style.height) || window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const onSizeDown = (axis: 'w' | 'h') => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = panelRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    sizeDragRef.current = { axis, x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sizeDragRef.current;
    if (!d) return;
    if (d.axis === 'w') applyPanelSize(d.w + (d.x - e.clientX), d.h);
    else applyPanelSize(d.w, d.h + (d.y - e.clientY));
  };
  const onSizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sizeDragRef.current) return;
    sizeDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    try {
      localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }));
    } catch { /* 隐私模式禁用存储 */ }
  };
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
  /** 上一轮的工具审计记录器：本轮发车前取它的异常摘要，再换成本轮的 */
  const runtimeRef = useRef<ReturnType<typeof createAgentRuntime> | null>(null);
  /** 回合轨迹：意图键 + 工具序列 + 裁决结果，跨轮累积，供技能蒸馏聚类 */
  const traceRef = useRef<ReturnType<typeof createTraceRecorder> | null>(null);
  /** 已经提示过的技能建议 id：同一张建议卡只打扰用户一次 */
  const suggestedSkillsRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 视口是否贴着底部（用户上翻回看时为 false，此时不自动跟随） */
  const pinnedRef = useRef(true);
  /** 本轮最后一次「有事件」的时刻（增量/思考/工具开始）：停顿看门狗据此判断连接卡死 */
  const lastEventRef = useRef(0);
  const caretRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  // 备份恢复会直接改写会话/偏好的存储键：面板的内存态不重读的话，下一次持久化会把恢复内容整体覆盖回去。
  // 回答进行中不换底（避免打断流式写入）；这种情况下恢复内容会在本轮结束后被覆盖，属已知取舍。
  useEffect(() => {
    if (running) return;
    const reload = () => {
      const loaded = loadSessions();
      const list = loaded.length ? loaded : [freshSession()];
      setSessions(list);
      setActiveId((cur) => (list.some((s) => s.id === cur) ? cur : list[0].id));
      setPrefs(loadPrefs());
    };
    window.addEventListener(BACKUP_RESTORED_EVENT, reload);
    return () => window.removeEventListener(BACKUP_RESTORED_EVENT, reload);
  }, [running]);
  /** 持久化失败只提示一次：每条新消息都会重试写一次，反复弹窗比丢会话更烦人 */
  const persistWarnedRef = useRef(false);
  useEffect(() => {
    if (persistSessions(sessions, activeId)) return;
    if (persistWarnedRef.current) return;
    persistWarnedRef.current = true;
    toast('对话太长，没能存进本机存储：关掉面板后这段对话会丢。可先删掉几个旧会话再继续。', 'err', 9000);
  }, [sessions, activeId]);
  useEffect(() => {
    savePrefs(prefs);
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
    // 工具结果展示与模型同一口径：超过单条上限的同样截断并标注。
    // 之前面板显示的是回填前的原文（read_note 可达 12k），而模型只收到裁剪后的 8k，
    // 用户会以为模型读到了面板上的全部内容——展示的就该是模型真正看到的那份。
    const next: ChatItem = item.kind === 'tool' ? { ...item, detail: capToolResult(item.detail) } : item;
    itemsRef.current = [...itemsRef.current, next];
    updateActive((s) => ({ ...s, updatedAt: Date.now(), items: [...s.items, next] }));
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
      // 分段读：结果自带总长度与续读位置，且不超过单条工具结果上限——
      // 面板显示的就是模型收到的，不再出现「面板 12k、模型 8k」的落差。
      const result = readNoteSlice(path, content, args);
      push({ kind: 'tool', id: idRef.current++, name, summary: path, detail: result });
      return result;
    }

    if (name === 'load_skill') {
      const key = String(args.id ?? args.skill ?? '').trim();
      if (!key) return '错误：需要 id（技能目录里的名字）。';
      const card = findSkill(docsRef.current, key);
      if (!card) {
        return '错误：没有技能「' + key + '」。技能目录在系统提示里；没有对应卡就按常规做法执行，不要臆造技能。';
      }
      const result = skillBody(docsRef.current, card);
      push({ kind: 'tool', id: idRef.current++, name, summary: '技能 ' + card.id, detail: result });
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

    if (name === 'get_mastery') {
      const result = masteryReport(loadMastery());
      push({ kind: 'tool', id: idRef.current++, name, summary: '掌握度台账', detail: result });
      return result;
    }
    if (name === 'set_mastery') {
      const topic = String(args.topic ?? '').trim();
      if (!topic) return '错误：需要 topic（知识点名称）。';
      const level = clampLevel(args.level);
      const evidence = String(args.evidence ?? '').trim();
      const next = applyMastery(loadMastery(), topic, level, evidence);
      saveMastery(next);
      // 面板里的台账条用的是内存快照：写盘后同步，避免要等下次重开面板才更新
      setMastery(next);
      const result = `已记录「${topic}」= ${MASTERY_LABELS[level]}（${level}/3）`
        + `${evidence ? `；依据：${evidence}` : ''}。${nextStepHint(level)}`;
      push({ kind: 'tool', id: idRef.current++, name, summary: `${topic} · ${MASTERY_LABELS[level]}`, detail: result });
      return result;
    }

    if (name === 'propose_note_edit' || name === 'propose_note_patch' || name === 'propose_note_create' || name === 'propose_card_hints' || name === 'propose_study_log') {
      // 学习日志的路径与内容由代码定位/组装（今天哪篇、追加成什么样），模型只给条目字段
      const isLog = name === 'propose_study_log';
      const path = isLog ? studyLogPath(new Date()) : safeVaultPath(String(args.path ?? ''));
      if (!path) return '错误：路径不合法（需要库内相对路径，如 解剖/心脏.md）。';
      // 只接受 .md：非 .md 文件不进目录树、不切复习卡，也不进备份与 Markdown 导出
      // （vault 只收 .md 与 _attachments/），用户既看不见也搬不走。宁可报错让模型改路径。
      if (!isLog && !path.toLowerCase().endsWith('.md')) {
        return `错误：路径必须以 .md 结尾（收到「${path}」）。请改成「${path}.md」再提交。`;
      }
      const old = docsRef.current.get(path);
      const isNew = isLog ? old === undefined : name === 'propose_note_create';
      if (!isLog) {
        if (isNew && old !== undefined) return `错误：「${path}」已存在，请改用 propose_note_edit / propose_note_patch 修改它。`;
        if (!isNew && old === undefined) return `错误：「${path}」不存在，请先用 list_notes 或 search_notes 确认路径。`;
      }

      // patch：锚文本唯一性校验后算出新正文；hints：小节定位后插属性键骨架；log：追加小节；edit/create 直接用模型给的整篇
      let next: string;
      if (isLog) {
        // 落盘前做 grounding：weak_points 里的 [[双链]] 必须解析到真实笔记，否则回填错误让模型改
        const entry = studyLogEntryFromArgs(args, {
          resolve: resolveLink ? (target) => resolveLink(target) !== null : undefined,
        });
        if (typeof entry === 'string') return entry;
        next = appendStudyLogEntry(old, entry, new Date());
      } else if (name === 'propose_card_hints') {
        const heading = String(args.heading ?? '').trim();
        if (!heading) return '错误：缺少 heading（小节标题）。先 read_note，再原样复制标题（不含 # 号）。';
        // 键的清洗（去尾部全角冒号）与校验在 core/aiTools，同一套逻辑直接单测
        const cleaned = cleanCardKeys(args.keys);
        if ('error' in cleaned) return cleaned.error;
        const nextLines = insertCardHints(old!, heading, cleaned.keys);
        if (typeof nextLines === 'string') return nextLines;
        next = nextLines.join('\n');
      } else if (name === 'propose_note_patch') {
        const patched = applyNotePatch(
          old!,
          typeof args.find_text === 'string' ? args.find_text : '',
          typeof args.replace_text === 'string' ? args.replace_text : '',
        );
        if ('error' in patched) return patched.error;
        next = patched.next;
      } else {
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content.trim()) return '错误：正文为空。';
        next = content;
      }

      // 整篇重写（edit）才做结构丢失检查：patch/hints/日志都是增量改动，没有「丢掉一大块」的风险。
      const warnings = !isNew && name === 'propose_note_edit'
        ? structureLossWarnings(old ?? '', next)
        : [];
      // AGENT.md 与 AI命令/ 是助手自己的指令来源：改它们等于改下一次会话的行为，
      // 即使在 yolo 档位也必须人工确认——不允许模型自我改写指令。
      const configGuard = path === AGENT_MD || path.startsWith(CMD_DIR);

      const itemId = idRef.current++;
      push({
        kind: 'proposal', id: itemId, path, old: old ?? '', next,
        isNew, status: 'pending',
        ...(warnings.length ? { warnings } : {}),
        ...(configGuard ? { configGuard: true } : {}),
      });

      // yolo：写入免确认（指令文件除外）。漂移（笔记被用户改过）永远要人工确认，
      // 任何模式下都不悄悄覆盖用户的手改。
      const autoOk = prefsRef.current.yolo && !configGuard;
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
        // yolo 静默落盘：必须让用户看见「笔记已经变了」；有结构丢失提醒时一并说出来。
        const warn = warnings.length ? `；注意：${warnings.map((w) => w.detail).join(' ')}` : '';
        toast(
          (isNew ? `已自动创建笔记「${path}」` : `已自动应用对「${path}」的修改`) + warn,
          warnings.length ? 'info' : 'ok',
          4200,
        );
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

  /** 导师模式开关（会话级）：比陪练多一层掌握度门禁；开启时自动进入陪练 */
  const toggleTutor = () => {
    const next = !active.tutor;
    tutorRef.current = next;
    if (next) {
      coachRef.current = true;
      setMastery(loadMastery());
    }
    updateActive((s) => ({ ...s, tutor: next, coach: next ? true : s.coach }));
  };

  /** 结束陪练：让模型把薄弱点写进学习日志再收尾，然后自动退出陪练模式 */
  const endCoach = () => {
    if (runningRef.current) return;
    coachRef.current = false;
    tutorRef.current = false;
    updateActive((s) => ({ ...s, coach: false, tutor: false }));
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
    // 历史里除了问答，还要带上「写入提案的结果」：否则用户拒绝一次提案后再发一句话，
    // 模型并不知道自己被拒过，会照着原样再提一遍（提示词里「被拒不要重复提交」只在本轮有效）。
    const history = buildHistoryMessages(
      itemsRef.current.flatMap((i) => {
        if (i.kind === 'msg') return [{ role: i.role, text: i.text }];
        if (i.kind !== 'proposal' || i.status === 'pending') return [];
        const outcome = i.status === 'applied'
          ? (i.autoApplied ? '已自动应用' : '已由用户应用')
          : i.status === 'rejected' ? '被用户拒绝'
            : i.status === 'failed' ? `写入失败（${i.error ?? '未知错误'}）`
              : '上次会话遗留、未应用';
        return [{
          role: 'assistant' as const,
          text: `【写入提案结果】${i.isNew ? '新建' : '修改'}「${i.path}」：${outcome}。`,
        }];
      })
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
      coach: text.trimStart().startsWith('/陪练') || text.trimStart().startsWith('/导师') ? true : s.coach,
      // /导师 在陪练之上再打开掌握度门禁（发送其它消息不会退出，保持会话级）
      tutor: text.trimStart().startsWith('/导师') ? true : s.tutor,
    }));
    if (text.trimStart().startsWith('/陪练')) coachRef.current = true;
    if (text.trimStart().startsWith('/导师')) { coachRef.current = true; tutorRef.current = true; }
    runningRef.current = true;
    setRunning(true);
    streamRef.current = '';
    setStreamText('');
    setThinkingText('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let wasAborted = false;
    let turnFailed = false;
    let thinkAccum = '';
    // 本轮助手正文累计（工具轮之间的过渡语也算进来，避免把最后一句「已写入…」当成答案存进速查）
    let answerAccum = '';
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
    // 教材数量决定系统提示里「本机有没有教材」的说法：读一次元数据（小表，不读正文），
    // 失败按「没有」处理——宁可让模型少用教材工具，也不能让它以为有书却查不到。
    const medBookCount = await medBooksList().then((books) => books.length).catch(() => 0);
    // 技能目录：库里「AI命令/技能/」下的卡，只注入通过校验的那些（卡里出现未注册工具就整卡作废），
    // 正文靠 load_skill 按需取——目录常驻、正文不常驻。
    const skillCards = validateSkills(collectSkills(docsRef.current), (t) => AGENT_TOOL_NAMES.has(t)).active;
    const skillCatalog = formatSkillCatalog(skillCards);
    // 人格卡与技能卡同目录族但语义不同：它常驻、只取一张；没有卡就是空串，保持默认口吻。
    const soulPrefix = formatSoulPrefix(collectSouls(docsRef.current));
    const sys = buildNoteSystemPrompt(
      currentPath,
      agentMd ? truncateForModel(agentMd, 4_000) : null,
      coachRef.current,
      medBookCount,
      skillCatalog,
      soulPrefix,
      tutorRef.current,
      tutorRef.current ? masteryReport(loadMastery()) : '',
    )
      + (prefsRef.current.yolo
        ? '\nyolo 模式：写入操作免确认直接生效（自动存历史版本，可回溯）。仍必须先 read_note 拿最新原文再动手；'
          + '发现笔记被用户改过会停下询问；改动保持最小，删除或整篇重写要格外谨慎。'
        : '\nread 模式：写入一律先出 diff 卡片等用户点「应用」，不要假设已经写入；提案被拒就换方向，别重复提交。');
    const wire: WireMessage[] = [
      { role: 'system', content: sys },
      ...history,
      { role: 'user', content: wireContent },
    ];
    // 上一轮的工具异常（执行失败 / 被用户拒绝 / 写后核对不符）补进本轮系统消息。
    // 会话历史里的【写入提案结果】只覆盖已裁决的提案卡，读工具报错与重复被拒在这里兜住。
    const prevAudit = runtimeRef.current?.takeAuditSummary() ?? '';
    if (prevAudit) wire.splice(1, 0, { role: 'system', content: prevAudit });

    // 治理记录器：只做分类、动作日志与写后核对，不接管执行——写入仍由 executeTool
    // 里的 diff 卡片 + awaitDecision 把关，两套确认不叠加。
    const runtime = createAgentRuntime({
      registry: AGENT_TOOL_REGISTRY,
      // 包一层只为了上报「现在在跑哪个工具」，执行语义不变
      execute: async (name, argsJson, signal) => {
        setActiveTool({ name, since: Date.now() });
        try {
          return await executeTool(name, argsJson, signal);
        } finally {
          setActiveTool(null);
        }
      },
      verify: makeWriteVerifier((p) => docsRef.current.get(p)),
    });
    runtimeRef.current = runtime;

    // 回合轨迹：本轮意图键 + 工具序列 + 裁决，跨轮累积成技能蒸馏的样本集。
    // 历史提问去掉最后一条（就是本轮这条，否则自己跟自己相似度 1.0，永远是「重复提问」）。
    traceRef.current ??= createTraceRecorder({ limit: 200 });
    const priorAsks = itemsRef.current
      .flatMap((i) => (i.kind === 'msg' && i.role === 'user' ? [i.text] : []))
      .slice(0, -1);
    const slashCommand = text.trimStart().startsWith('/')
      ? (text.trimStart().slice(1).split(/\s+/, 1)[0] || null)
      : null;
    const turnTrace = traceRef.current.begin({
      sessionId: active.id,
      userText: text,
      command: slashCommand,
      priorUserTexts: priorAsks,
    });

    // 预算分桶：这里只度量、不干预（真正的裁剪在 aiAgent 的 fitToolBudget 里做），
    // 给出「这一轮是谁吃掉了上下文」的读数，超 85% 时提示优先压哪段。
    const buckets = measureContext(wire, { toolsJson: JSON.stringify(ALL_AGENT_TOOLS) });
    const advice = adviseCompaction(buckets);
    setCtxHint(
      '上下文 ' + Math.round((buckets.totalTokens / CONTEXT_TOTAL_BUDGET) * 100) + '%'
        + (advice.needed ? '·' + advice.reason : ''),
    );

    const agentOpts: RunAgentOptions = {
      settings: settingsRef.current,
      messages: wire,
      tools: ALL_AGENT_TOOLS,
      executeTool: runtime.executeTool,
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
      else turnFailed = true;
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
      // 回合收尾：把本轮的治理记录回放成一条轨迹，再据此校准「AI命令/技能/」里已有卡的置信度。
      // 这一段属于副业：任何一步出错都只吞掉，不能影响本轮回复，也不影响队列续跑。
      try {
        for (const rec of runtime.records()) {
          turnTrace.call(
            rec.toolName, JSON.stringify(rec.toolArgs ?? {}),
            rec.executionStatus === 'success', rec.result ? rec.result.length : 0,
          );
          if (rec.approvalStatus === 'rejected') turnTrace.decide(rec.id, 'rejected');
          else if (rec.approvalStatus === 'approved') turnTrace.decide(rec.id, 'applied');
          else if (rec.approvalStatus === 'auto') turnTrace.decide(rec.id, 'auto');
        }
        turnTrace.finish(wasAborted ? 'aborted' : turnFailed ? 'error' : 'ok');
        // 中止的轨迹工具序列是残缺的：拿它调置信度会把「用户中途叫停」记成技能失败。
        if (!wasAborted) {
          const { updates, suggestions } = distillSkills(traceRef.current.list(), collectSkills(docsRef.current), { now: Date.now() });
          for (const updated of updates) {
            const body = docsRef.current.get(updated.path);
            if (body === undefined) continue;
            try {
              await onSave(updated.path, toSkillMarkdown(updated, stripFrontmatter(body)));
            } catch { /* 单张卡写失败只影响这一张的置信度，不影响回复 */ }
          }
          // 建议卡不自动落盘：技能卡是指令文件，等于给助手加规矩，只能由用户决定。
          const fresh = suggestions.find((c) => !suggestedSkillsRef.current.has(c.path));
          if (fresh) {
            suggestedSkillsRef.current.add(fresh.path);
            toast(`同类任务已经成功重复 ${fresh.samples} 次，可以固化成技能：新建 ${fresh.path}（工具顺序 ${fresh.tools.join(' → ')}）`, 'ok', 12_000);
          }
        }
      } catch { /* 轨迹/技能维护失败不影响本轮 */ }
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
        ? notePaths.filter((p) => p.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8)
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

  const [copiedId, setCopiedId] = useState(0);
  /** 复制一条回答：Tauri WebView 里 clipboard.writeText 可能被权限挡，退回 execCommand */
  const copyMessage = async (id: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(0), 1600);
  };
  /** 重试：砍掉这条回答之后的所有条目，把它对应的用户提问原样重发 */
  const retryTurn = (assistantId: number) => {
    if (runningRef.current) return;
    const list = itemsRef.current;
    const ai = list.findIndex((i) => i.id === assistantId);
    if (ai < 0) return;
    let ui = -1;
    for (let k = ai - 1; k >= 0; k -= 1) {
      const it = list[k];
      if (it.kind === 'msg' && it.role === 'user') { ui = k; break; }
    }
    if (ui < 0) return;
    const ask = list[ui];
    if (ask.kind !== 'msg') return;
    const { text, quote } = ask;
    const cut = (arr: ChatItem[]) => {
      const k = arr.findIndex((i) => i.id === ask.id);
      if (k < 0) return arr;
      // 被砍掉的待确认提案要先拒掉，否则等在那里的 promise 永远不 resolve
      for (const it of arr.slice(k)) {
        if (it.kind === 'proposal' && it.status === 'pending') pendingRef.current.get(it.id)?.('rejected');
      }
      return arr.slice(0, k);
    };
    itemsRef.current = cut(itemsRef.current);
    updateActive((s) => ({ ...s, items: cut(s.items), updatedAt: Date.now() }));
    pendingQuoteRef.current = quote ?? null;
    setPendingQuote(quote ?? null);
    void sendText(text);
  };

  /* ------------------------------------------------------------- 渲染 */

  /** 助手消息里的 [[双链]]：能解析就跳转对应笔记 */
  const openWikiLink = (name: string) => {
    const p = resolveLink?.(name);
    if (p) { onClose(); onOpenPath?.(p); }
  };

  const settingsValid = !!settings;
  const usage = active.usage;
  /** 面板标识随模式切换：同一个面板，但「导师陪练 / 陪练 / AI 笔记」必须一眼能分清 */
  const panelMode: 'tutor' | 'coach' | 'note' = active.tutor ? 'tutor' : active.coach ? 'coach' : 'note';
  const panelBrand = panelMode === 'tutor' ? '导师陪练' : panelMode === 'coach' ? '陪练' : 'AI 笔记';
  /** 输入框无障碍名：普通模式必须保持「对 AI 笔记说点什么」（既有 DOM 测试按这个名字取元素） */
  const composerLabel =
    panelMode === 'tutor' ? '对导师陪练说点什么' : panelMode === 'coach' ? '对陪练说点什么' : '对 AI 笔记说点什么';
  const composerHint =
    panelMode === 'tutor'
      ? '向导师提问，或复述你学到的内容…（@ 引用笔记）'
      : panelMode === 'coach'
        ? '开始陪练：说一个想练的主题…（/导师 开启掌握度门禁）'
        : '问点什么…（@ 引用笔记，/ 用命令）';
  const usageText = usage.promptTokens + usage.completionTokens > 0
    ? `tokens ↑${fmtTokens(usage.promptTokens)} ↓${fmtTokens(usage.completionTokens)}${usage.estimated ? ' ≈' : ''}`
    : '';

  return (
    <div className={`agent-panel${pendingQuote ? ' has-quote' : ''}`} data-mode={panelMode} ref={panelRef}>
      {/* 左边缘拖宽、上边缘拖高。pointer capture 挂在把手上，拖出面板外也不丢事件。 */}
      <div
        className="agent-panel-grip agent-panel-grip-w"
        role="separator" aria-orientation="vertical" aria-label="拖动调整 AI 面板宽度"
        onPointerDown={onSizeDown('w')} onPointerMove={onSizeMove} onPointerUp={onSizeUp} onPointerCancel={onSizeUp}
      />
      <div
        className="agent-panel-grip agent-panel-grip-h"
        role="separator" aria-orientation="horizontal" aria-label="拖动调整 AI 面板高度"
        onPointerDown={onSizeDown('h')} onPointerMove={onSizeMove} onPointerUp={onSizeUp} onPointerCancel={onSizeUp}
      />
      <div className="ai-header agent-header">
        <div className="agent-brand">
          <span className="agent-brand-mark" aria-hidden="true"><IconLattice size={15} /></span>
          <span className="agent-brand-name" data-mode={panelMode}>{panelBrand}</span>
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
                            {(s.tutor || s.coach) && (
                              <span className="agent-session-badge" data-mode={s.tutor ? 'tutor' : 'coach'}>
                                {s.tutor ? '导师陪练' : '陪练'}
                              </span>
                            )}
                            {s.items.filter((i) => i.kind === 'msg').length} 条 · {fmtAgo(s.updatedAt)}
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
        {onSwitchToAi && (
          <button className="btn-small" onClick={onSwitchToAi} aria-label="切到 AI 问答">
            AI 问答
          </button>
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
            {active.tutor
              ? <><strong>导师中</strong>掌握度门禁 · 一次一个台阶 · 未过门槛不推进</>
              : <><strong>陪练中</strong>一次一题 · 答错先给提示 · 讲完必验证</>}
          </span>
          <button type="button" className="agent-coach-end" onClick={endCoach} disabled={running}>
            结束并写日志
          </button>
        </div>
      )}

      {active.tutor && (
        <div className="agent-mastery" role="status" aria-label="掌握度台账">
          <span className="agent-mastery__label">掌握度</span>
          {Object.keys(mastery).length === 0 ? (
            <span className="agent-mastery__empty">还没有判定记录，先来一道诊断题</span>
          ) : (
            Object.entries(mastery)
              .sort((a, b) => a[1].level - b[1].level || b[1].updatedAt - a[1].updatedAt)
              .slice(0, 4)
              .map(([topic, entry]) => (
                <span
                  key={topic}
                  className={`agent-mastery__item lv-${entry.level}`}
                  title={`${MASTERY_LABELS[entry.level]}${entry.evidence ? ` · ${entry.evidence}` : ''}`}
                >
                  {topic}
                  <i className="agent-mastery__dots" aria-label={`${entry.level}/3`}>
                    {[1, 2, 3].map((dot) => <b key={dot} className={dot <= entry.level ? 'on' : ''} />)}
                  </i>
                </span>
              ))
          )}
          {Object.keys(mastery).length > 4 && (
            <span className="agent-mastery__more">+{Object.keys(mastery).length - 4}</span>
          )}
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
          aria-label={panelMode === 'note' ? 'AI 笔记对话' : `${panelBrand}对话`}
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
                <ImportQuestionsRow text={item.text} notePath={currentPath} />
                <div className="agent-msg-actions">
                  <button
                    type="button" className="agent-msg-act"
                    aria-label="复制这条回答"
                    onClick={() => void copyMessage(item.id, item.text)}
                  >
                    {copiedId === item.id ? '已复制' : '复制'}
                  </button>
                  <button
                    type="button" className="agent-msg-act"
                    aria-label="重新生成这条回答"
                    disabled={running}
                    onClick={() => retryTurn(item.id)}
                  >
                    重试
                  </button>
                </div>
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
          // 工具调用不进正文：查了什么、返回了多少字都在 turn trace 与治理日志里，
          // 面板只留「依据」（引文核验）与「推理」（思考卡），读起来才是一篇文章而不是操作流水
          if (item.kind === 'tool') return null;
          if (item.kind === 'thinking') {
            return (
              <details key={item.id} className="agent-thinking" open>
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
                  {item.configGuard && (
                    <div className="agent-drift">
                      这是助手的指令文件（AGENT.md / AI命令/）。即使开着 yolo 也要你确认，
                      避免助手改写自己的指令、影响下一次会话。
                    </div>
                  )}
                  {!!item.warnings?.length && (
                    <div className="agent-drift">
                      这次是整篇重写，结构有变化：
                      <ul className="agent-warn-list">
                        {item.warnings.map((w, k) => <li key={k}>{w.detail}</li>)}
                      </ul>
                    </div>
                  )}
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
                <>
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
                  {/* 已落盘的提案也要留下结构提醒：yolo 下只有一条 toast，划过去就没了，
                      而「这次重写丢了 frontmatter / 双链」是事后要能回看的信息。 */}
                  {!!item.warnings?.length && item.status === 'applied' && (
                    <div className="agent-drift">
                      应用时结构有变化：
                      <ul className="agent-warn-list">
                        {item.warnings.map((w, k) => <li key={k}>{w.detail}</li>)}
                      </ul>
                    </div>
                  )}
                </>
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
            placeholder={settingsValid ? composerHint : '先在「设置」里配置模型服务…'}
            rows={1}
            aria-label={composerLabel}
          />
          <div className="agent-composer-foot">
            {activeTool && (
              <span className="agent-status" role="status">
                {activeTool.name} · {((Date.now() - activeTool.since) / 1000).toFixed(1)}s
              </span>
            )}
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
        <button
          className={`pref-chip ${active.tutor ? 'on' : ''}`}
          onClick={toggleTutor}
          aria-pressed={!!active.tutor}
          title="导师模式：在陪练之上加掌握度门禁（0 未测 / 1 有印象 / 2 能复述 / 3 能应用），未过门槛不进入下一个知识点；顶部会显示台账"
        >
          导师
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
        {ctxHint && (
          <span
            className="agent-usage"
            title="上一轮请求发出前的上下文预算估算（系统提示 + 历史 + 工具结果 + 工具声明）；超 85% 会提示优先压哪一段"
          >
            {ctxHint}
          </span>
        )}
      </div>
    </div>
  );
}
