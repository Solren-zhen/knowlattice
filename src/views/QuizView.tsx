/**
 * 题库练习：导入 JSON 题库（文件或粘贴）→ 选库组卷 → 逐题作答 → 结果页错题回顾。
 * 答错且题目关联笔记（note 字段可解析）时自动记入错题本。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc } from './useEsc';
import {
  addBank, loadBanks, pickQuestions, removeBank, setOptionNote,
  correctIndices, explanationsOf, isCorrectPick, isMultiSelect,
  chaptersOf,
  type QuizBank, type QuizQuestion,
} from '../core/qbank';
import { analyzePick, pickHint } from '../core/answerReview';
import { questionNotePath, questionToMarkdown } from '../core/qbankNote';
import type { ImageEntry } from '../core/imageLib';
import { parseQbankFile, parseQbankJsonText } from '../core/qbankParse';
import { mergeQuestions, mergeSummary } from '../core/qbankMerge';
import {
  DEFAULT_RULES, chapterCounts, composeQuestions, filterPool,
  type ComposeOrder, type ComposeRules, type ComposeScope,
} from '../core/qbankCompose';
import { bankProgress, chapterMastery, consumeSaveFailure, initializeStats, loadStats, recordAnswer, statOf } from '../core/qbankStats';
import { initializeStars, isStarred, loadStars, starCount, toggleStar, type StarMap } from '../core/qbankStarred';
import { QUESTION_FIELD_LABELS, searchBanks } from '../core/qbankSearch';
import { generateCardsFromMistakes, getGeneratableCount } from '../core/qbankCards';
import { addGeneratedCards, loadGeneratedCards } from '../core/generatedCards';
import { segment } from '../core/searchHit';
import { buildTagContext, difficultyBand, DIFFICULTY_LABELS, Q_TAG_LABELS, tagsOf, type DifficultyBand, type QStatusTag } from '../core/qbankTags';
import { CONFIDENCE_LABELS, CONFIDENCE_VALUES, recordCalibration, type Confidence } from '../core/qbankCalib';
import {
  gatePrompt, needsRationale, rationaleHint, rationaleReady,
  reflectionCounter, reflectionReady, shouldGateExplanation,
} from '../core/reviewGate';
import { buildChapterIndex, questionNoteLabel, resolveQuestionNote } from '../core/qbankNotes';
import { getMistake, lapseMistake, recordMistake, stageOf } from '../core/mistakes';
import ImagePickerSheet from './ImagePickerSheet';
import { clearCursor, loadCursor, resumeQuestions, saveCursor, type QuizCursor } from '../core/quizCursor';
import { isKnowledgeDone, markKnowledgeDone, pickTodayKnowledge, type KnowledgePick } from '../core/dailyKnowledge';
import { toast, confirmBox } from '../core/feedback';
import { markStudy } from '../core/stats';
import { recordQuiz } from '../core/studyLog';
import { bankToAnki, downloadFile } from '../core/anki';
import { IconRestore, IconClose, IconHelp, IconPencil, IconBook } from './icons';
import type { QuoteSelection } from './agentChat';
import PanelOverlay from './PanelOverlay';

interface Props {
  docs: Map<string, string>;
  resolveLink: (name: string) => string | null;
  /** vault 路径 → 可显示的 URL（图片等附件）。不传则题干图片不显示，其余功能不受影响。 */
  resolveAsset?: (path: string) => string | undefined;
  /** 打开关联笔记（同时关闭本面板） */
  onOpenPath: (path: string) => void;
  onClose: () => void;
  /** 与 AI 笔记联动：把当前这道题（含我的选择）交给 AI 讲透；不传则不显示入口 */
  onAskAi?: (quote: QuoteSelection) => void;
  /** 打开「考试中心」（模拟考试）；不传则不显示入口 */
  onOpenExam?: (bankName: string) => void;
  /** 统一导入入口（自动识别格式 + 批量）。提供时，「导入题库」面板里的文件导入收敛成一条：
   *  不再各自摆 .json/.docx/.xlsx 三个按钮，由 Workspace 打开统一面板识别格式。
   *  粘贴框保留（剪贴板文本没有文件，走不了自动识别）；不传时保留原三按钮（向后兼容）。 */
  onUnifiedImport?: () => void;
  /** 外部导入完成后刷新题库列表的信号：统一面板是从本面板里打开的，导入的题库必须在
   *  「题库练习」里立刻可见，否则用户会以为导入失败了。数值变化即触发重新读库。 */
  refreshToken?: number;
  /** 把当前这道题写成一篇笔记（含解析、我的选择、批注、知识点）。不传则不显示入口 */
  onSaveNote?: (path: string, markdown: string) => void;
  /** 边刷边改：把侧栏里的笔记正文写回 vault。不传则不显示「笔记」抽屉 */
  onUpdateNote?: (path: string, content: string) => Promise<void> | void;
  /** 边刷边记的图片来源：vault 附件图片条目；与 resolveAsset 同时存在时才显示「插图」入口 */
  onImageEntries?: ImageEntry[];
  /** 从首页「继续刷题」进来：题库就绪后自动接上上次没练完的那一轮（见 core/quizCursor） */
  autoResume?: boolean;
  /** 自动续做已处理（无论接上没有）——调用方清掉标记，免得下次打开题库又自动续 */
  onAutoResumeDone?: () => void;
  /** 从全局搜索跳进来时带入的关键词：打开即显示跨库搜题结果 */
  initialSearch?: string;
}

/** rules 为 null = 不组题，整库洗牌（「全部」入口）；非 null 时「再练一轮」沿用同一套规则 */
type Session = { bankName: string; questions: QuizQuestion[]; rules: ComposeRules | null };

const HELP_TEXT = `[
  {
    "stem": "氧解离曲线右移的意义是？",
    "options": ["Hb 容易放氧", "Hb 容易结合氧", "亲和力增大", "P50 减小"],
    "answer": 0,
    "explanation": "右移 = 亲和力下降，P50 增大，利于向组织放氧。",
    "chapter": "生理学",
    "note": "氧解离曲线"
  }
]
字段中文名（题干/选项/答案/解析/章节/笔记）同样支持；
options 缺省即为简答题，显示答案后自行判定对错。
optionNotes 逐选项批注，下标对齐 options，可写可不写（应用里作答后点选项右侧的铅笔即可添加）。

· JSON 文件：数组，或 {"name":"题库名","questions":[…]}
· Word(.docx)：直接导入，自动抽取文本并按「1.题干 → A.选项 → 答案：A」识别
· Excel/CSV：表头含「题干/答案」，选项列用 A/B/C/D 或 选项1..4
· 同业 App 导出的题库 JSON（短键 s/o/a、富文本 title/options/jiexiArr 这类字段名）：自动识别形状后导入，报告里会写明识别成什么、置信度与跳过的条目
· 识别不到时会把原文填入输入框，手动整理后再粘贴导入
· 批量：上面三个入口都支持一次多选，逐个导入并在面板里逐条回报结果（成功几题 / 失败原因）
· 同名题库再次导入是**增量合并**：只补新题，已存在的（题干/选项/答案/章节都相同）跳过，不覆盖你已有的题、批注与逐题记录
· 整库备份（笔记）在这里不认：请走「笔记树右上角 ⋯ → 从备份 .json 恢复」；这里只吃上面的题库格式
· 题库与逐题复习记录保存在浏览器 IndexedDB；首次打开会自动迁移旧数据`;


/** 批量导入的逐文件结果（面板上逐条显示） */
interface ImportReport {
  file: string;
  ok: boolean;
  /** 成功：入库的题库名与题数（同名题库走**增量合并**时，这里是本次新增的题数） */
  bank?: string;
  count?: number;
  /** 成功但走了「自动识别形状」通道时的说明（识别成什么形状、置信度、跳过了哪几条） */
  note?: string;
  /** 同名题库增量合并的结果（「增量导入：新增 N 题，已存在 M 题（跳过）」）。
   *  只有真的走了合并才有它 —— 库里没有的新库名走原路径，报告文案一字不变。 */
  merge?: string;
  /** 失败原因（面向使用者的中文说明） */
  error?: string;
}
/** 讲解音频：只在答完/背题时出现；preload="none"——一题一段录音，预载会把带宽吃光 */
function ExplainAudio({ src, dur }: { src: string; dur?: number }) {
  const label = dur && dur > 0
    ? `讲解音频 · ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`
    : '讲解音频';
  return (
    <div className="quiz-audio">
      <span className="muted">{label}</span>
      <audio controls preload="none" src={src} />
    </div>
  );
}

/** 习题界面缩放：整块界面的百分比，存本机（换设备不带，属个人手感） */
const ZOOM_KEY = 'knowlattice-quiz-zoom';
const ZOOM_MIN = 0.9;
const ZOOM_MAX = 1.6;

function readZoom(): number {
  try {
    const n = Number(localStorage.getItem(ZOOM_KEY));
    if (!Number.isFinite(n) || n < ZOOM_MIN || n > ZOOM_MAX) return 1;
    return Math.round(n * 10) / 10;
  } catch {
    return 1;
  }
}

export default function QuizView({ docs, resolveLink, onOpenPath, onClose, onAskAi, onOpenExam, resolveAsset, onUnifiedImport, refreshToken, onSaveNote, onUpdateNote, onImageEntries, autoResume, onAutoResumeDone, initialSearch }: Props) {
  const [banks, setBanks] = useState<QuizBank[]>([]);
  /** 题库行操作区：默认折叠成行内竖向面板，用户自己决定展开哪些（偏好记在 localStorage） */
  const [openBankActions, setOpenBankActions] = useState<Set<string>>(new Set());
  /** 只初始化一次：偏好只决定默认，之后每行各点各的 */
  const bankActionsSeeded = useRef(false);

  const toggleBankActions = (name: string) => {
    setOpenBankActions((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try { localStorage.setItem('knowlattice.quiz.bank-actions', next.size > 0 ? 'open' : 'closed'); } catch { /* 同上 */ }
      return next;
    });
  };
  const toggleAllBankActions = (open: boolean) => {
    try { localStorage.setItem('knowlattice.quiz.bank-actions', open ? 'open' : 'closed'); } catch { /* 同上 */ }
    setOpenBankActions(open ? new Set(banks.map((b) => b.name)) : new Set());
  };
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /** 批量导入的逐文件结果：面板上要能看出「哪个文件成了、几题、没成的原因」 */
  const [batchReport, setBatchReport] = useState<ImportReport[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [idx, setIdx] = useState(0);
  /** 每题作答结果：true 对 / false 错 / undefined 未答 */
  const [results, setResults] = useState<(boolean | undefined)[]>([]);
  /** 本题已勾选的选项下标（空数组 = 未作答）；单选点一下即判定，多选切换后交卷 */
  const [picked, setPicked] = useState<number[]>([]);
  const [revealed, setRevealed] = useState(false);
  /** 多套解析里当前选中的来源下标；单条/无解析时用不到，切题时重置 */
  const [explIdx, setExplIdx] = useState(0);
  /**
   * 逐题的作答快照（下标 → 已选 + 是否已看答案）。
   * 前后翻题时必须把「当时选了什么、看到答案没有」一起存起来：只改 idx 的话
   * 回看会变成一道没答过的题，批注也藏起来了——那不是回看，是重做。
   */
  const [snaps, setSnaps] = useState<Record<number, { picked: number[]; revealed: boolean }>>({});
  /** 作答前自报的把握度（1~5）；null = 没报。可选，不报也能作答，只是不计入校准样本 */
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  /** 解析门控：答错 / 没把握时先写一句推理，写够字数或勾「我想过了」才展开解析 */
  const [reflectText, setReflectText] = useState('');
  const [reflectAck, setReflectAck] = useState(false);
  /** 自证：做对了也可能靠蒙，答案对了但题还没练熟时请人写一段推理链 */
  const [rationaleText, setRationaleText] = useState('');
  /** 自证后的自查结论：闭环 / 有漏洞（有漏洞的答对题要回到错题队列） */
  const [rationaleVerdict, setRationaleVerdict] = useState<'closed' | 'guess' | null>(null);
  /** 正在写批注的选项下标（null = 没在写）与草稿文本 */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const docxRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);
  /** 组题弹窗正在给哪个题库出题（null = 没开） */
  const [composing, setComposing] = useState<QuizBank | null>(null);
  const [rules, setRules] = useState<ComposeRules>(DEFAULT_RULES);
  const [stats, setStats] = useState(loadStats);
  /** 已生成错题卡的卡片键：生成后更新它，让「可生成数量」立刻减少 */
  const [generatedKeys, setGeneratedKeys] = useState<Set<string>>(
    () => new Set(loadGeneratedCards().map((c) => c.key)),
  );
  const questionIndex = useMemo(() => {
    const index = new Map<string, QuizQuestion>();
    for (const bank of banks) for (const q of bank.questions) index.set(q.id, q);
    return index;
  }, [banks]);
  const generatable = useMemo(
    () => getGeneratableCount(stats, generatedKeys),
    [stats, generatedKeys],
  );  /** 收藏/重点题（与逐题统计分开，见 core/qbankStarred）：组题范围与练习中收藏按钮都用它 */
  const [stars, setStars] = useState<StarMap>(loadStars);
  /** 搜题关键词（跨题库）；非空时题库列表区改显搜索结果 */
  const [searchQ, setSearchQ] = useState(initialSearch ?? '');
  /** 背题模式：不判分、直接摊开答案背一遍（进入即按「背题」渲染，见下方背题分支） */
  const [beatMode, setBeatMode] = useState(false);
  /** 断点续做：上次没练完的那一轮（见 core/quizCursor；过期/失效的游标读出来就是 null） */
  const [cursor, setCursor] = useState<QuizCursor | null>(loadCursor);
  const [zoom, setZoom] = useState(readZoom);
  /** 缩放只在 0.9–1.6 之间走，并且写回本机：调到 160% 是为了看清长题干，不是排版实验 */
  const nudgeZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((prev + delta) * 10) / 10));
      try { localStorage.setItem(ZOOM_KEY, String(next)); } catch { /* 存不上就只管本次 */ }
      return next;
    });
  };
  /** 今日知识点「看过了」的标记键（当天+库+章节）；null = 还没点 */
  const [knowDoneKey, setKnowDoneKey] = useState<string | null>(null);
  /** 边刷边改：右侧笔记抽屉。notePath = 正在改的笔记；noteDraft 是本地草稿，停手 900ms 落一次盘 */
  const [notePaneOpen, setNotePaneOpen] = useState(false);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null);
  /** 边刷边记里的「插图」：内嵌图片选择器开关。选图直接追加进笔记草稿（无光标概念就落文末） */
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const noteSnapshotRef = useRef<{ path: string | null; draft: string; dirty: boolean }>({ path: null, draft: '', dirty: false });

  /**
   * 首页「继续刷题」的两个 prop 走 ref：父组件内联箭头函数每次都换引用，直接进 effect 依赖
   * 会让题库每渲染一次就重读一遍 IndexedDB。这里只关心「这次读库里要不要顺手续上一轮」。
   */
  const autoResumeRef = useRef({ on: autoResume, done: onAutoResumeDone });
  autoResumeRef.current = { on: autoResume, done: onAutoResumeDone };

  useEffect(() => {
    let active = true;
    /**
     * 空列表 ≠ 用户没题库：读库会和「重置 / 迁移 legacy 数据」交错（组件重挂载时尤其明显）。
     * 再读一次把这个窗口挡掉；仍为空（或抛错）就按「确实还没有题库」处理——
     * 新用户第一次打开时必须看到导入入口，不能因为防抖反而给他一个错误提示。
     */
    const load = async () => {
      const [bankList, loadedStats, loadedStars] = await Promise.all([
        loadBanks(), initializeStats(), initializeStars(),
      ]);
      const list = bankList.length === 0 ? await loadBanks().catch(() => bankList) : bankList;
      return { list, loadedStats, loadedStars };
    };
    load().then(({ list: loadedBanks, loadedStats, loadedStars }) => {
      if (!active) return;
      setBanks(loadedBanks);
      // 和 setBanks 放在同一个提交里，避免「先渲染折叠按钮，再由 effect 展开」：
      // 用户恰好在 effect 前点了一下，会把展开又切回折叠。
      if (!bankActionsSeeded.current && loadedBanks.length > 0) {
        bankActionsSeeded.current = true;
        let open = false;
        try { open = localStorage.getItem('knowlattice.quiz.bank-actions') === 'open'; } catch { /* 隐私模式 */ }
        if (open) setOpenBankActions(new Set(loadedBanks.map((b) => b.name)));
      }

      if (loadedBanks.length === 0) setImportOpen(true);
      setStats(loadedStats);
      setStars(loadedStars);
      setLoadError(null);
      setReady(true);
      // 首页「继续刷题」进来的：题库刚读回来才谈得上续做。早于这里续，banks 还是空的，
      // resumeLast 会把游标当成「题库已删」清掉——点了没反应，回去还得重练。
      if (autoResumeRef.current.on) {
        const c = loadCursor();
        if (c) resumeLast(c, loadedBanks);
        autoResumeRef.current.done?.();
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setReady(true);
    });
    return () => { active = false; };
  }, [reloadKey, refreshToken]);

  /** 题库列表上的进度行。按 banks/stats 缓存——127 个库 × 上千题，
   *  每次渲染都重算会把题库面板拖垮。 */
  const progress = useMemo(() => {
    const m = new Map<string, ReturnType<typeof bankProgress>>();
    for (const b of banks) m.set(b.name, bankProgress(b.name, b.questions.map((x) => x.id), stats));
    return m;
  }, [banks, stats]);

  /** 搜题：非空关键词时跨题库找题（每题 haystack 在 core/qbankSearch 里按题库对象缓存，逐键不重建） */
  const searching = searchQ.trim().length > 0;
  const searchHits = useMemo(
    () => (searching ? searchBanks(banks, searchQ, { perBank: 20, limit: 60 }) : []),
    [banks, searchQ, searching],
  );
  /** 只在结果真正用到的题库上算标签上下文（大题库算全量分布不便宜，别对没出现的库白算） */
  const ctxByBank = useMemo(() => {
    const m = new Map<string, ReturnType<typeof buildTagContext>>();
    for (const h of searchHits) {
      if (m.has(h.bank)) continue;
      const b = banks.find((x) => x.name === h.bank);
      if (b) m.set(h.bank, buildTagContext(b));
    }
    return m;
  }, [searchHits, banks]);

  /** 章节掌握度：软门控用——只在正确率低时提示「先回看」，不锁内容、不禁用任何按钮。
   *  组题弹窗与练习中都要用，所以按「当前在看的题库」（composing 优先，其次 session）算；
   *  按整库而不是本轮 session 算：抽题是随机的，只看本轮会低估样本量。 */
  const mastery = useMemo(() => {
    const name = composing?.name ?? session?.bankName;
    const b = banks.find((x) => x.name === name);
    return b ? chapterMastery(b, stats) : [];
  }, [banks, stats, composing?.name, session?.bankName]);

  /** 题库笔记索引：题库题目的 chapter 是「学科·章节」，题库笔记路径是
   *  「题库/<源>/<学科>/<章节>.md」，两边精确对应（详见 core/qbankNotes.ts）。 */
  /** 题目分级标签上下文（当前题库）：新题/易错/在学/已掌握 + 高频 */
  const tagCtx = useMemo(() => {
    const name = composing?.name ?? session?.bankName;
    const b = banks.find((x) => x.name === name);
    return b ? buildTagContext(b) : null;
  }, [banks, composing?.name, session?.bankName]);

  const chapterIndex = useMemo(() => buildChapterIndex(docs.keys()), [docs]);

  /** 这道题关联哪篇笔记：note 字段与 chapter 反查都试，都没有就 null。
   *  必须先试 chapter——转换器产出的题库 note 字段是空的（111,548 题全空），
   *  只看 note 会让「答错进错题本」静默失效。 */
  const notePathOf = (question: QuizQuestion) =>
    resolveQuestionNote(question, resolveLink, chapterIndex, (p) => docs.has(p));

  const q = session?.questions[idx];

  /* ---------- 边刷边改：右侧笔记抽屉 ---------- */
  const noteChoices = useMemo(
    () => [...docs.keys()].filter((p) => p.endsWith('.md')).sort((a, b) => a.localeCompare(b, 'zh')),
    [docs],
  );
  const suggestedNote = q ? notePathOf(q) : null;
  const onUpdateNoteRef = useRef(onUpdateNote);
  onUpdateNoteRef.current = onUpdateNote;

  const saveNoteNow = useCallback(async (): Promise<boolean> => {
    const save = onUpdateNoteRef.current;
    if (!save || !notePath || !noteDirty) return true;
    const savingDraft = noteDraft;
    const savingPath = notePath;
    setNoteSaving(true);
    try {
      await save(savingPath, savingDraft);
      // 保存期间用户又改了字：不要把新的 dirty 清掉，下一轮自动保存继续
      if (noteSnapshotRef.current.path === savingPath && noteSnapshotRef.current.draft === savingDraft) {
        setNoteDirty(false);
        setNoteSavedAt(Date.now());
      }
      return true;
    } catch (e) {
      toast(`笔记保存失败：${(e as Error).message}`, 'err');
      return false;
    } finally {
      setNoteSaving(false);
    }
  }, [notePath, noteDraft, noteDirty]);

  const loadNote = useCallback((path: string) => {
    setNotePath(path);
    setNoteDraft(docs.get(path) ?? '');
    setNoteDirty(false);
    setNoteSavedAt(null);
  }, [docs]);

  const switchNote = async (path: string) => {
    if (!path || path === notePath) return;
    const ok = await saveNoteNow();
    if (!ok) return;
    loadNote(path);
  };

  const openNotePane = () => {
    if (!notePath) {
      const pick = suggestedNote ?? noteChoices[0] ?? null;
      if (pick) loadNote(pick);
    }
    setNotePaneOpen(true);
  };

  const closeNotePane = () => {
    void saveNoteNow();
    setNotePaneOpen(false);
  };

  useEffect(() => {
    noteSnapshotRef.current = { path: notePath, draft: noteDraft, dirty: noteDirty };
  }, [notePath, noteDraft, noteDirty]);

  // 停手约 1 秒自动落盘；切题不会中断这个计时（notePath / 草稿不变）
  useEffect(() => {
    if (!noteDirty || !notePath) return;
    const timer = window.setTimeout(() => { void saveNoteNow(); }, 900);
    return () => window.clearTimeout(timer);
  }, [noteDirty, notePath, noteDraft, saveNoteNow]);

  // 关闭题库（卸载）时把最后不到 1 秒的改动补写一次；只跑在卸载，不跟父组件每次渲染
  useEffect(() => () => {
    const s = noteSnapshotRef.current;
    if (s.dirty && s.path) void onUpdateNoteRef.current?.(s.path, s.draft);
  }, []);

  const noteToggle = onUpdateNote ? (
    <button
      type="button"
      className={`btn-small quiz-note-toggle${notePaneOpen ? ' is-on' : ''}`}
      aria-expanded={notePaneOpen}
      aria-controls="quiz-note-pane"
      title="边刷题边改笔记：在右侧打开笔记编辑区，保存走当前知识库"
      onClick={() => { if (notePaneOpen) closeNotePane(); else openNotePane(); }}
    >
      <IconPencil size={14} /> {notePaneOpen ? '收起笔记' : '笔记'}
    </button>
  ) : null;

  const notePaneNode = notePaneOpen ? (
    <aside className="quiz-note-pane" id="quiz-note-pane" aria-label="边刷边记">
      <div className="quiz-note-head">
        <span className="quiz-note-title"><IconPencil size={14} /> 边刷边记</span>
        <select
          className="quiz-note-select"
          aria-label="选择要编辑的笔记"
          value={notePath ?? ''}
          onChange={(e) => { void switchNote(e.target.value); }}
        >
          <option value="" disabled={Boolean(notePath)}>选择一篇笔记…</option>
          {notePath && !docs.has(notePath) && <option value={notePath}>（笔记已删除）</option>}
          {noteChoices.map((p) => (
            <option key={p} value={p}>{p.replace(/\.md$/, '')}</option>
          ))}
        </select>
        <button className="btn-icon" onClick={closeNotePane} aria-label="收起笔记" title="收起笔记">
          <IconClose size={14} />
        </button>
      </div>
      {notePath ? (
        <>
          <textarea
            className="quiz-note-text"
            data-note-input
            value={noteDraft}
            onChange={(e) => { setNoteDraft(e.target.value); setNoteDirty(true); }}
            placeholder="在这里改笔记，停手约 1 秒自动保存…"
            spellCheck={false}
            aria-label={`编辑笔记：${notePath}`}
          />
          <div className="quiz-note-foot">
            <span className={`quiz-note-status${noteDirty ? ' is-dirty' : ''}`} role="status">
              {noteSaving ? '保存中…' : noteDirty ? '未保存' : noteSavedAt ? '已保存' : '自动保存'}
            </span>
            <span className="muted">{noteDraft.replace(/\s/g, '').length} 字</span>
            {suggestedNote && suggestedNote !== notePath && (
              <button className="quiz-note-jump" onClick={() => { void switchNote(suggestedNote); }} title="切换到本题关联的笔记">
                本题笔记
              </button>
            )}
            <button
              className="btn-small"
              title="从图片库选一张图插入笔记"
              onClick={() => setNotePickerOpen(true)}
            >
              插图
            </button>
            <button className="btn-small" disabled={!noteDirty || noteSaving} onClick={() => { void saveNoteNow(); }}>
              保存
            </button>
          </div>
          {notePickerOpen && onImageEntries && resolveAsset && (
            <ImagePickerSheet
              entries={onImageEntries}
              resolveAsset={resolveAsset}
              onPick={(md) => {
                // 没有光标位置概念（textarea 不暴露选区锚点到渲染层），追加到文末并保证前后空行分隔
                setNoteDraft((d) => (d.endsWith('\n\n') || d === '' ? `${d}${md}\n` : `${d}\n\n${md}\n`));
                setNoteDirty(true);
              }}
              onClose={() => setNotePickerOpen(false)}
            />
          )}
        </>
      ) : (
        <div className="quiz-note-empty">
          <IconBook size={26} />
          <p>先在上方选一篇笔记，再开始边刷边改。</p>
          {noteChoices.length === 0 && <p className="muted">知识库里还没有笔记。</p>}
        </div>
      )}
    </aside>
  ) : null;

  /**
   * Exit policy: a practice run in progress must not be lost to a stray click.
   *
   * 判据是「还在答题中」（有 session 且当前题还没走完），**不是「有没有答过题」**：
   * 上一版用 `results.some(r => r === true || r === false)`，于是刚开练、第一题还没提交答案时
   * 点一下面板外面的任何地方（遮罩上铺着整屏，外面的按钮点到的就是它）会一声不响地整轮退出
   * —— 用户实测反馈「题库训练时候点击外面的按钮会直接退出训练」。
   * 成绩页（q 为空）没有可丢的进度，直接关；答题中才拦一下。
   */
  const inProgress = Boolean(session && q);
  const requestClose = () => {
    if (!inProgress) { onClose(); return; }
    const answered = results.filter((r) => r !== undefined).length;
    void confirmBox({
      title: '这一轮还没做完，确定退出？',
      detail: `已答 ${answered} / ${session!.questions.length} 题 · 逐题记录已保存，退出后可从「继续上次」接着练`,
      okText: '退出',
      danger: true,
    }).then((ok) => { if (ok) onClose(); });
  };

  // Esc 快捷关闭（走全局 Esc 栈）。批注输入框里的 Esc 只退出编辑、不关整个面板：
  // 这里仍按**事件目标**判断（而不是当前焦点）——输入框自己的 onKeyDown 会先退出编辑，
  // 那时焦点已经不在输入框上了，看焦点就会误判成「该关面板」。
  useEsc((e) => {
    if ((e.target as HTMLElement | null)?.dataset?.noteInput) return;
    requestClose();
  });

  const correctCount = results.filter((r) => r === true).length;

  // ---------- 导入 ----------
  // 文件解析统一走 core/qbankParse（与「统一导入」入口同一条通道）：本项目格式优先、
  // 认不出再按形状映射，本组件不再自己持有一套解析，避免两个入口口径分叉。

  /** 批量导入：逐个文件解析 → 逐个入库 → 汇总「哪个文件成了、几题、没成的原因」。
   *
   *  串行而不是 Promise.all：解析（mammoth / SheetJS）很吃内存，而且入库会落到同一个题库上，
   *  并行时同批里重名的两个文件会互相覆盖/交叉合并，结果不可预测。
   *  同批重名直接跳过并报出来 —— 静默覆盖等于丢一份题库。
   *
   *  入库分两条：题库名**库里没有**的走原来的整库导入（文案与行为一字不变）；
   *  同名题库走 **增量合并**（core/qbankMerge）：只补新题、不重复、不覆盖用户已有题目。
   *  合并必须保留 existing 里每道题的**原 id** —— 逐题统计 / 错题本 / 复习排程 / 组题 /
   *  Anki 导出都以「题库名 + 题目 id」为键，重新发 id 等于把用户历史整体作废。 */
  const importFiles = async (files: File[]) => {
    const list = files.filter(Boolean);
    if (batchBusy || list.length === 0) return;
    setBatchBusy(true);
    setBatchReport(null);
    const reports: ImportReport[] = [];
    const used = new Set<string>();
    let updated: QuizBank[] | null = null;
    for (const file of list) {
      try {
        const parsed = await parseQbankFile(file);
        if (parsed.kind === 'raw') {
          setPasteText(parsed.text);
          reports.push({ file: file.name, ok: false, error: '没识别出题目，原文已填入下方输入框，整理后再粘贴导入' });
          continue;
        }
        if (used.has(parsed.name)) {
          reports.push({ file: file.name, ok: false, error: `题库名「${parsed.name}」与本批另一个文件重名，已跳过（重名会互相覆盖）` });
          continue;
        }
        // 同名题库 → 增量合并，而不是整库覆盖。比对用的题库列表就是本轮已加载的那份：
        // 同一批里的重名文件已被上面的 used 挡住，这里不会读到「刚写了一半」的过期副本。
        const prev = banks.find((b) => b.name === parsed.name);
        if (prev) {
          const merged = mergeQuestions(prev.questions, parsed.questions);
          // 一点变化都没有（题全都在、也没有可补的缺字段）就不重写本地数据：
          // 十万题的库重导一次不该产生一次整库写盘，importedAt 也没必要动。
          if (merged.added > 0 || merged.enriched > 0) updated = await addBank(parsed.name, merged.questions);
          used.add(parsed.name);
          reports.push({
            file: file.name, ok: true, bank: parsed.name, count: merged.added,
            note: parsed.note, merge: mergeSummary(merged),
          });
          continue;
        }
        updated = await addBank(parsed.name, parsed.questions);
        used.add(parsed.name);
        // 识别形状导入的（parsed.note）在报告里多带一句 mappingSummary：识别成什么形状、
        // 置信度多少、跳过了哪几条 —— 「哪些成了、哪些没成、为什么」必须逐条说得出来
        reports.push({ file: file.name, ok: true, bank: parsed.name, count: parsed.questions.length, note: parsed.note });
      } catch (err) {
        reports.push({ file: file.name, ok: false, error: (err as Error).message });
      }
    }
    if (updated) setBanks(updated);
    setBatchReport(reports);
    setBatchBusy(false);
    const okFiles = reports.filter((r) => r.ok).length;
    const total = reports.reduce((n, r) => n + (r.count ?? 0), 0);
    if (okFiles) toast(`批量导入完成：${okFiles}/${reports.length} 个文件、共 ${total} 题`, 'ok', 4200);
    else toast(`批量导入失败：${reports.length} 个文件都没能导入（逐条原因见面板）`, 'err', 8000);
  };

  /** 粘贴导入：解析与报错都在 core（parseQbankJson），这条提示是用户唯一的线索，必须可测。
   *  与文件导入同一条口径：库里已有同名题库时走**增量合并**（只补新题、不重复、不覆盖），
   *  新库名走原来的整库导入，提示文案一字不变。 */
  const doImport = async (text: string, fallbackName: string) => {
    try {
      const { name, questions } = parseQbankJsonText(text, fallbackName);
      const prev = banks.find((b) => b.name === name);
      if (prev) {
        const merged = mergeQuestions(prev.questions, questions);
        if (merged.added > 0 || merged.enriched > 0) setBanks(await addBank(name, merged.questions));
        setPasteText('');
        setImportOpen(false);
        toast(`「${name}」${mergeSummary(merged)}`, 'ok', 6000);
        return;
      }
      setBanks(await addBank(name, questions));
      setPasteText('');
      setImportOpen(false);
      toast(`已导入「${name}」：${questions.length} 题`, 'ok');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err', 8000);
    }
  };

  // ---------- 练习 ----------
  /** 开一轮练习。rules 为 null 时整库洗牌（「全部」入口） */
  const start = (bank: QuizBank, rules: ComposeRules | null) => {
    const qs = rules ? composeQuestions(bank, rules, loadStats(), undefined, undefined, loadStars(), tagCtx ?? undefined) : pickQuestions(bank);
    setSession({ bankName: bank.name, questions: qs, rules });
    setIdx(0);
    setResults(new Array(qs.length).fill(undefined));
    setPicked([]);
    setRevealed(false);
    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setBeatMode(false);
  };

  /** 背题模式：进入即摊开答案背一遍（整库洗牌；不判分、不记错题本） */
  const startBeat = (bank: QuizBank, rules: ComposeRules | null = null) => {
    start(bank, rules);
    setBeatMode(true);
  };

  /** 从搜题结果直接练某一道题（单题精练，不组卷） */
  const startOne = (bank: QuizBank, question: QuizQuestion) => {
    setSession({ bankName: bank.name, questions: [question], rules: null });
    setIdx(0);
    setResults([undefined]);
    setPicked([]);
    setRevealed(false);
    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setBeatMode(false);
  };

  /**
   * 继续上次：按游标里的题目 id 找回原题（core/quizCursor.resumeQuestions）。
   * 题库被删、题被替换掉的部分直接跳过；一道都找不回来就清游标。
   * 本轮结果页只统计这一节——已经答过的题在逐题记录里（进度/待复习/错题本都还在）。
   */
  function resumeLast(c: QuizCursor, list: QuizBank[] = banks) {
    const bank = list.find((b) => b.name === c.bank);
    if (!bank) {
      clearCursor();
      setCursor(null);
      toast('上次练的题库已经不在了，断点已清除', 'info', 5000);
      return;
    }
    const r = resumeQuestions(c, bank.questions);
    if (!r) {
      clearCursor();
      setCursor(null);
      toast('上次那一轮已经没有可续的题了', 'info', 5000);
      return;
    }
    setSession({ bankName: bank.name, questions: r.questions, rules: c.rules });
    setIdx(r.idx);
    // 已经答过的题连对错一起恢复：只恢复题号、分数清零，等于「进度还在但记录没了」
    setResults(r.results.map((v) => (v === null ? undefined : v)));
    setPicked(c.picked ?? []);
    setRevealed(false);
    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setBeatMode(false);
    toast(`接着上次练：「${bank.name}」第 ${r.idx + 1}/${r.questions.length} 题`, 'ok', 4200);
  };


  /** 今日知识点：每天固定推一个章节（挑选规则见 core/dailyKnowledge），点了才换 */
  const todayKnowledge = useMemo(() => pickTodayKnowledge(banks, stats), [banks, stats]);
  const knowDone = todayKnowledge
    ? knowDoneKey === `${todayKnowledge.date}|${todayKnowledge.bank}|${todayKnowledge.chapter}`
      || isKnowledgeDone(todayKnowledge)
    : false;

  /** 练这个知识点的 5 道题（不足就全给）。不整库洗牌——那等于把今天的建议淹掉 */
  const startKnowledge = (p: KnowledgePick) => {
    const bank = banks.find((b) => b.name === p.bank);
    if (!bank) return;
    const pool = bank.questions.filter((q) => chaptersOf(q).includes(p.chapter));
    const qs = pickQuestions({ ...bank, questions: pool }, 5);
    if (!qs.length) {
      toast('这个知识点下没有可选题目', 'info', 4000);
      return;
    }
    setSession({ bankName: bank.name, questions: qs, rules: null });
    setIdx(0);
    setResults(new Array(qs.length).fill(undefined));
    setPicked([]);
    setRevealed(false);
    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setBeatMode(false);
  };

  /**
   * 断点续做：练到哪就记到哪。挂在 session/idx 上，作答、翻页、中途关掉面板都能覆盖到；
   * 一轮做完（idx 越界）就清游标，免得下次提示一个已经做完的轮次。
   * 这里只写外部存储、不改 state：提示条需要的最新值在「回到题库列表」时现读（见 exitToList），
   * 在 effect 里 setState 会多跑一遍渲染，React 也会给一条「effect 里不该同步 setState」的警告。
   */
  useEffect(() => {
    if (!session) return;
    if (idx >= session.questions.length) {
      clearCursor();
      return;
    }
    saveCursor({
      bank: session.bankName,
      qids: session.questions.map((x) => x.id),
      idx,
      rules: session.rules,
      // undefined 进不了 JSON：未答的题存 null，读回来再还原成 undefined
      results: results.map((r) => r ?? null),
      picked,
      at: Date.now(),
    });
  }, [session, idx, results, picked]);

  /** 回到题库列表：现读一次游标，让提示条与本轮实际进度对齐 */
  const exitToList = () => {
    setSession(null);
    setCursor(loadCursor());
  };
  /** 答错且关联笔记存在 → 记入错题本；同时对每道题记一次逐题历史（错题加权与 FSRS 排程的数据源） */
  const judge = async (correct: boolean) => {
    if (!q) return;
    markStudy(); // 打卡
    // 报过把握度才记样本：校准要的是「自信 vs 实际」的对照，没报的作答没有对照价值
    if (confidence !== null) recordCalibration(confidence, correct);
    setResults((prev) => prev.map((r, i) => (i === idx ? correct : r)));
    const wasWrong = (statOf(stats, session!.bankName, q.id)?.wrong ?? 0) > 0;
    await recordAnswer(session!.bankName, q.id, correct);
    recordQuiz(correct, wasWrong);
    setStats(loadStats());
    // 持久化失败时记录只在内存里活着，本轮结束就没了——必须告知用户
    if (consumeSaveFailure()) {
      toast('逐题记录保存失败：请检查浏览器存储空间和权限。', 'err', 9000);
    }
    if (!correct) {
      const path = notePathOf(q);
      const content = path ? docs.get(path) : undefined;
      // content 必须存在：错题本要拿原文提章节与标题（core/mistakes.ts）
      if (path && content !== undefined) recordMistake(path, content);
    }
  };

  /** 错题 → 复习卡：答错 3 次以上且没生成过的题，批量转成 FSRS 卡片（见 core/qbankCards）。 */
  const generateMistakeCards = () => {
    const existing = new Set(loadGeneratedCards().map((c) => c.key));
    const cards = generateCardsFromMistakes(stats, questionIndex, existing);
    const added = addGeneratedCards(cards.map((c) => ({ ...c, source: 'mistake' as const, createdAt: Date.now() })));
    setGeneratedKeys(new Set(loadGeneratedCards().map((c) => c.key)));
    toast(
      added > 0 ? `已生成 ${added} 张错题复习卡，去「复习」即可看到` : '没有新的可生成错题卡',
      added > 0 ? 'ok' : 'info',
    );
  };

  const next = () => {
    setPicked([]);
    setRevealed(false);    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setIdx((i) => i + 1);
  };

  /**
   * 跳到指定题号（上一题 / 直接输入题号都走这里）。
   * 离开前把当前题的作答状态存进快照，回来时原样恢复；越界直接忽略，
   * 不夹取——「下一题」已经在最后一题时换成「查看成绩」，这里再夹会跳回上一题。
   */
  const goTo = (n: number) => {
    if (!session || n < 0 || n >= session.questions.length || n === idx) return;
    setSnaps((m) => ({ ...m, [idx]: { picked, revealed } }));
    const back = snaps[n];
    setIdx(n);
    setPicked(back?.picked ?? []);
    setRevealed(back?.revealed ?? false);
    setExplIdx(0);
    setConfidence(null);
    setReflectText('');
    setReflectAck(false);
    setRationaleText('');
    setRationaleVerdict(null);
    setEditing(null);
  };

  /** 收藏 / 取消收藏当前题目（重点题）。内存先变、存储后写，按钮立即反映结果。 */
  const toggleCurrentStar = async () => {
    if (!q || !session) return;
    const on = await toggleStar(session.bankName, q.id);
    setStars(loadStars());
    toast(on ? '已收藏这道题（可在组题时选「收藏题」）' : '已取消收藏', 'ok', 2600);
  };

  /** 收藏任意题目（搜题结果用；只更新状态，不弹提示） */
  const toggleStarFor = async (bankName: string, qid: string) => {
    await toggleStar(bankName, qid);
    setStars(loadStars());
  };

  /** 背题模式标记：记一次逐题历史并前进（掌握了 = 对，没掌握 = 错） */
  const beatMark = async (correct: boolean) => {
    if (!q || !session) return;
    markStudy();
    await recordAnswer(session.bankName, q.id, correct);
    recordQuiz(correct);
    setStats(loadStats());
    next();
  };

  // ---------- 选项批注（作答后） ----------
  /** 打开某选项的批注输入框，草稿取该选项已有的批注 */
  const beginNote = (i: number) => {
    setDraft(q?.optionNotes?.[i] ?? '');
    setEditing(i);
  };

  /** 存批注：空文本即删除。写完要把面板里的题库列表和本轮题目一起刷新，
   *  否则同一题再进来读到的还是旧副本。 */
  const commitNote = async (i: number) => {
    setEditing(null);
    if (!q || !session) return;
    if ((q.optionNotes?.[i] ?? '') === draft.trim()) return;
    const banks = await setOptionNote(session.bankName, q.id, i, draft);
    setBanks(banks);
    const saved = banks.find((b) => b.name === session.bankName)?.questions.find((x) => x.id === q.id);
    setSession((s) => (s
      ? { ...s, questions: s.questions.map((x) => (x.id === q.id ? { ...x, optionNotes: saved?.optionNotes } : x)) }
      : s));
  };

  /** 选项批注输入框：作答视图与背题视图共用同一套交互（Ctrl/⌘+Enter 保存、Esc 取消、清空即删除） */
  const noteEditor = (i: number) => (
    <div className="opt-note-edit">
      <textarea
        className="opt-note-input"
        data-note-input="1"
        rows={2}
        autoFocus
        value={draft}
        placeholder="这个选项为什么对、为什么错，写下来下次一眼看到"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setEditing(null); return; }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commitNote(i);
          }
        }}
        onBlur={() => commitNote(i)}
      />
      <span className="opt-note-hint">Ctrl/⌘+Enter 保存 · Esc 取消 · 清空即删除</span>
    </div>
  );

  // ---------- 渲染 ----------
  if (!ready || loadError) {
    return (
      <PanelOverlay tone="quiz">
        <DialogSurface className="panel quiz-panel" label={loadError ? '题库加载失败' : '题库正在加载'}>
          <div className="panel__body quiz-body">
            <p role="status">{loadError ?? '\u6b63\u5728\u52a0\u8f7d\u9898\u5e93...'}</p>
            {loadError && <button className="btn-small" onClick={() => setReloadKey((key) => key + 1)}>{'\u91cd\u8bd5'}</button>}
          </div>
        </DialogSurface>
      </PanelOverlay>
    );
  }



  // ---------- 背题模式（不判分，直接摊开答案背） ----------
  if (session && q && beatMode) {
    const expls = explanationsOf(q);
    const right = correctIndices(q);
    const qTags = tagCtx ? tagsOf(q, statOf(stats, session.bankName, q.id), tagCtx) : [];
    const starredNow = isStarred(stars, session.bankName, q.id);
    const stemImg = q.image ? resolveAsset?.(q.image) : undefined;
    const notePath = notePathOf(q);
    return (
      <PanelOverlay tone="quiz" onClose={requestClose}>
        <DialogSurface className={`panel quiz-panel${notePaneOpen ? ' quiz-panel--note-open' : ''}`} style={{ zoom }} label={`背题模式，第 ${idx + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">背题 · {session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <button
              className={`btn-icon quiz-star${starredNow ? ' on' : ''}`}
              aria-pressed={starredNow}
              aria-label={starredNow ? '取消收藏这道题' : '收藏这道题（重点题）'}
              title={starredNow ? '取消收藏' : '收藏 / 标为重点题'}
              onClick={() => void toggleCurrentStar()}
            >{starredNow ? '★' : '☆'}</button>
            {/* 界面缩放：题干长、字号小的时候整块放大（连图一起放大），关掉应用再打开还保持 */}
            <button className="btn-icon" aria-label="缩小题目界面" title="缩小" onClick={() => nudgeZoom(-0.1)}>A−</button>
            <button className="btn-icon" aria-label="放大题目界面" title="放大" onClick={() => nudgeZoom(0.1)}>A+</button>
            <span className="muted">{(zoom * 100).toFixed(0)}%</span>
            {noteToggle}
            <button className="btn-small" onClick={() => setBeatMode(false)}>退出背题</button>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-progress"><i style={{ width: `${((idx + 1) / session.questions.length) * 100}%` }} /></div>
          <div className="quiz-workbench">
            <div className="quiz-main">
          {/* key={idx}：换题时重挂载，让 .quiz-body 的入场动画重播 —— 否则题干/选项/解析
              会在同一帧整体换掉（瞬移）。用 animation 而非 transition 也是因为这个原因。 */}
          <div className="panel__body quiz-body" key={idx}>
            <div className="quiz-tagrow">
              {q.chapter && <span className="quiz-chapter">{q.chapter}</span>}
              {qTags.map((t) => <span key={t} className={`exam-tag exam-tag--${t}`}>{Q_TAG_LABELS[t]}</span>)}
              {(() => {
                const d = difficultyBand(statOf(stats, session.bankName, q.id));
                return d !== 'unknown' ? <span className={`exam-tag exam-tag--diff-${d}`}>难度·{DIFFICULTY_LABELS[d]}</span> : null;
              })()}
            </div>
            {q.groupStem ? (
              <details className="quiz-group" open>
                <summary className="quiz-group-head">共用题干{q.groupTotal ? ` · 第 ${q.groupNo ?? 1}/${q.groupTotal} 问` : ''}</summary>
                <p className="quiz-group-stem">{q.groupStem}</p>
              </details>
            ) : null}
            <p className="quiz-stem">{q.stem}</p>
            {stemImg ? (
              <figure className="quiz-stem-figure"><img className="quiz-stem-img" src={stemImg} alt="题干图片" loading="lazy" /></figure>
            ) : null}
            {q.type === 'choice' && q.options.length > 0 && (
              <div className="quiz-opts">
                {q.options.map((opt, i) => {
                  /* 背题就是对着答案看题：这里正是想写批注的时候。
                     以前背题模式没有铅笔，X 型题这类多选项题基本只能靠背题复习，
                     于是「X 型题无法批注」的一半原因在这里。 */
                  const note = q.optionNotes?.[i] ?? '';
                  const letter = String.fromCharCode(65 + i);
                  return (
                    <div key={i} className={`opt${right.includes(i) ? ' right' : ''}`}>
                      <b>{letter}</b> {opt}
                      {right.includes(i) && <span className="opt-mark">✓</span>}
                      <button
                        className={`btn-icon opt-note-btn${note ? ' has-note' : ''}`}
                        aria-label={note ? `修改选项 ${letter} 的批注` : `给选项 ${letter} 写批注`}
                        title={note ? '修改批注' : '给这个选项写批注'}
                        onClick={() => (editing === i ? setEditing(null) : beginNote(i))}
                      >
                        <IconPencil size={14} />
                      </button>
                      {editing === i ? noteEditor(i) : note ? (
                        <div className="opt-note">
                          <span className="opt-note-icon" aria-hidden="true"><IconPencil size={12} /></span>
                          <span className="opt-note-text">{note}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="quiz-answer"><b>参考答案</b><p>{q.answerText}</p></div>
            {q.audio && <ExplainAudio src={q.audio} dur={q.audioDur} />}
            {expls.length > 0 && (
              <div className="quiz-expl is-right">
                {expls.map((e, i) => <p key={i}>{e.source ? `${e.source}：${e.text}` : e.text}</p>)}
              </div>
            )}
            {notePath && <p className="muted">关联笔记：{questionNoteLabel(q, notePath)}</p>}
          </div>
          <div className="quiz-footer">
            <button className="btn-small" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>← 上一题</button>
            <button className="btn-small danger" onClick={() => void beatMark(false)}>没掌握</button>
            <button className="btn-small" onClick={() => void beatMark(true)}>掌握了</button>
            {idx + 1 < session.questions.length ? (
              <button className="btn-primary" onClick={() => setIdx((i) => i + 1)}>下一题 →</button>
            ) : (
              <button className="btn-primary" onClick={exitToList}>结束背题</button>
            )}
          </div>
            </div>
            {notePaneNode}
          </div>
        </DialogSurface>
      </PanelOverlay>
    );
  }

  if (session && q) {
    const answered = results[idx] !== undefined;
    // 解析门控：只有「答对且很确定」才直接看解析，其余先过反思闸门
    const gated = answered && shouldGateExplanation(Boolean(results[idx]), confidence);
    const gateOpen = !gated || reflectionReady(reflectText, reflectAck);
    const gatedHint = '先写下你的推理：写够 10 字，或勾「我想过了」，解析就展开。';
    const notePath = notePathOf(q);
    // 自证只看熟练度：这道笔记在错题本里的晋级阶段（没进过错题本 = 0）
    const mistakeRec = notePath ? getMistake(notePath) : null;
    const stage = mistakeRec ? stageOf(mistakeRec) : 0;
    // 门控没放行时只给反思框，别同时压两个输入框
    const askRationale = answered && gateOpen && Boolean(results[idx]) && needsRationale(true, confidence, stage);
    // 题干图片：拿不到 URL（调用方没传 resolveAsset，或附件还没加载）就当没有图
    const stemImg = q.image ? resolveAsset?.(q.image) : undefined;
    // 软门控（成员口径，O1 收尾）：题目**任一所属章节**薄弱就提示，与组题筛选 / 章节清单 /
    // 掌握度热力图同口径（多章节题在每个所属章节各算一次）。没有 chapters 的历史题在 chaptersOf
    // 里退回 [q.chapter]，结果与旧的 `q.chapter ? … : undefined` 逐字等价；
    // 没标章节的题归到空串，提示「未标章节」没有意义（mastery 里那一档本来也不会 weak）。
    const weakChapter = chaptersOf(q)
      .map((c) => mastery.find((m) => m.chapter === c && m.weak))
      .find((m) => m !== undefined);
    // 一题多解析：有 explanations 就用它，否则把单条 explanation 包成一条；都没有即空数组
    const expls = explanationsOf(q);
    // 题目分级标签（新题/易错/在学/已掌握 + 高频）
    const qTags = tagCtx ? tagsOf(q, statOf(stats, session.bankName, q.id), tagCtx) : [];
    const starredNow = isStarred(stars, session.bankName, q.id);
    return (
      <PanelOverlay tone="quiz" onClose={requestClose}>
        <DialogSurface className={`panel quiz-panel${notePaneOpen ? ' quiz-panel--note-open' : ''}`} style={{ zoom }} label={`${session.bankName}练习，第 ${idx + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">{session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <span className="muted">已对 {correctCount}</span>
            {/* 界面缩放：题干长、字号小的时候整块放大（连图一起放大），关掉应用再打开还保持 */}
            <button className="btn-icon" aria-label="缩小题目界面" title="缩小" onClick={() => nudgeZoom(-0.1)}>A−</button>
            <button className="btn-icon" aria-label="放大题目界面" title="放大" onClick={() => nudgeZoom(0.1)}>A+</button>
            <span className="muted">{(zoom * 100).toFixed(0)}%</span>
            {/* 背题模式（不判分、直接摊开答案背）之前只有实现没有入口：setBeatMode 从没被调用过 */}
            <button
              className="btn-small"
              title="背题模式：不判分，直接看答案背；可以标「掌握了 / 没掌握」"
              onClick={() => setBeatMode(true)}
            >背题</button>
            {noteToggle}
            {onSaveNote && (
              <button
                className="btn-small"
                title="把这道题连同解析、我的选择、批注、知识点写成一篇笔记：之后能复习、能搜到、能进图谱"
                onClick={() => {
                  const q = session.questions[idx];
                  if (!q) return;
                  onSaveNote(
                    questionNotePath(session.bankName, q),
                    questionToMarkdown({
                      question: q,
                      bank: session.bankName,
                      picked,
                      correct: results[idx],
                    }),
                  );
                }}
              >写成笔记</button>
            )}
            <button
              className={`btn-icon quiz-star${starredNow ? ' on' : ''}`}
              aria-pressed={starredNow}
              aria-label={starredNow ? '取消收藏这道题' : '收藏这道题（重点题）'}
              title={starredNow ? '取消收藏' : '收藏 / 标为重点题'}
              onClick={() => void toggleCurrentStar()}
            >{starredNow ? '★' : '☆'}</button>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-progress"><i style={{ width: `${((idx + (answered ? 1 : 0)) / session.questions.length) * 100}%` }} /></div>

          <div className="quiz-workbench">
            <div className="quiz-main">
          {/* key={idx}：同上，换题重挂载以重播入场动画。
              注意另外两处 .quiz-body 不能加 key：加载/错误态（上方）与「自动组题」表单，
              后者加 key 会在换题时清空用户已填的表单。 */}
          <div className="panel__body quiz-body" key={idx}>
            <div className="quiz-tagrow">
              {q.chapter && <span className="quiz-chapter">{q.chapter}</span>}
              {qTags.map((t) => <span key={t} className={`exam-tag exam-tag--${t}`}>{Q_TAG_LABELS[t]}</span>)}
              {(() => {
                const d = difficultyBand(statOf(stats, session.bankName, q.id));
                return d !== 'unknown' ? <span className={`exam-tag exam-tag--diff-${d}`}>难度·{DIFFICULTY_LABELS[d]}</span> : null;
              })()}
            </div>
            {q.groupStem ? (
              <details className="quiz-group" open>
                <summary className="quiz-group-head">
                  共用题干{q.groupTotal ? ` · 第 ${q.groupNo ?? 1}/${q.groupTotal} 问` : ''}
                </summary>
                <p className="quiz-group-stem">{q.groupStem}</p>
              </details>
            ) : null}
            <p className="quiz-stem">{q.stem}</p>
            {/* 题干图片：路径解析失败（附件被删/尚未加载）时不渲染破图，也不占位 */}
            {stemImg ? (
              <figure className="quiz-stem-figure">
                <img className="quiz-stem-img" src={stemImg} alt="题干图片" loading="lazy" />
              </figure>
            ) : null}

            {/* 作答前自报把握度：可选，不选也能直接答；答完再用一行对照把「自信」和「实际」摆一起 */}
            <div className="compose-chips" role="group" aria-label="作答把握度（可选）">
              <span className="muted">有几分把握？（不选也行）</span>
              {CONFIDENCE_VALUES.map((c) => (
                <button
                  key={c}
                  className={`chip${confidence === c ? ' on' : ''}`}
                  // 看到答案后再改自信度就没有对照意义了，所以揭示/作答后锁住
                  disabled={answered || revealed}
                  aria-pressed={confidence === c}
                  onClick={() => setConfidence(confidence === c ? null : c)}
                >
                  {c} {CONFIDENCE_LABELS[c]}
                </button>
              ))}
            </div>

            {q.type === 'choice' && q.options.length === 0 ? (
              <>
                <p className="quiz-degenerate muted">（本题没有选项数据，请检查题库文件；可直接看「参考答案」继续）</p>
                {revealed ? (
                  <div className="quiz-answer">
                    <b>参考答案</b>
                    <p>{q.answerText}</p>
                  </div>
                ) : (
                  <button className="btn-small" onClick={() => setRevealed(true)}>显示答案</button>
                )}
              </>
            ) : q.type === 'choice' ? (
              <>
              <div className="quiz-opts">
                {q.options.map((opt, i) => {
                  const right = correctIndices(q).includes(i);
                  const chosen = picked.includes(i);
                  const cls = !answered ? 'opt' : right ? 'opt right' : chosen ? 'opt wrong' : 'opt';
                  const letter = String.fromCharCode(65 + i);
                  const note = q.optionNotes?.[i] ?? '';
                  // 选项图：拿不到 URL（调用方没传 resolveAsset，或附件未加载）就当作没有图
                  const optImg = q.optionImages?.[i]
                    ? resolveAsset?.(q.optionImages[i] as string)
                    : undefined;
                  return (
                    <div key={i} className="quiz-opt">
                      <button
                        className={`${cls}${!answered && chosen ? ' on' : ''}`}
                        disabled={answered}
                        aria-pressed={answered ? undefined : chosen}
                        onClick={() => {
                          // 多选：点一下只切换勾选，交卷才判定；单选保持「点一下即判定」
                          if (isMultiSelect(q)) {
                            setPicked((prev) => (prev.includes(i)
                              ? prev.filter((x) => x !== i)
                              : [...prev, i].sort((a, b) => a - b)));
                            return;
                          }
                          setPicked([i]);
                          void judge(isCorrectPick(q, [i]));
                        }}
                      >
                        <b>{letter}</b> {opt}
                        {/* 未交卷也要有「我勾了这一项」的确定信号：X 型题勾完不判定，
                            只靠描边一圈，勾了三项回头看根本认不出勾了哪几个。 */}
                        {!answered && chosen && <span className="opt-mark opt-mark--pick" aria-hidden="true">✓</span>}
                        {answered && right && <span className="opt-mark">✓</span>}
                        {answered && chosen && !right && <span className="opt-mark">✗</span>}
                      </button>
                      {optImg ? (
                        <figure className="opt-figure">
                          <img className="opt-img" src={optImg} alt={`选项 ${letter} 的图`} loading="lazy" />
                        </figure>
                      ) : null}
                      {/* 批注入口不绑「已作答」：X 型题要按交卷才算作答，入口挂在判分状态上时，
                          勾完选项还没交卷就去点铅笔，看到的是一片空白——这就是「X 型题无法批注」。
                          批注是学习笔记，不该被判定流程卡住；未作答时铅笔淡一点表示「还没对答案」。 */}
                      <button
                        className={`btn-icon opt-note-btn${note ? ' has-note' : ''}${answered ? '' : ' idle'}`}
                        aria-label={note ? `修改选项 ${letter} 的批注` : `给选项 ${letter} 写批注`}
                        title={note ? '修改批注' : '给这个选项写批注'}
                        onClick={() => (editing === i ? setEditing(null) : beginNote(i))}
                      >
                        <IconPencil size={14} />
                      </button>
                      {editing === i ? noteEditor(i) : note ? (
                        <div className="opt-note">
                          <span className="opt-note-icon" aria-hidden="true"><IconPencil size={12} /></span>
                          <span className="opt-note-text">{note}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {isMultiSelect(q) && !answered && (
                <div className="quiz-submit-row">
                  <button
                    className="btn-primary"
                    disabled={picked.length === 0}
                    onClick={() => void judge(isCorrectPick(q, picked))}
                  >
                    交卷（已选 {picked.length} 项）
                  </button>
                  {picked.length > 0 && (
                    <span className="quiz-picked" role="status">
                      已选：{picked.map((i) => String.fromCharCode(65 + i)).join('、')}
                    </span>
                  )}
                  <span className="muted">
                    多选题：全对才算对（少选、多选都算错）
                  </span>
                </div>
              )}
              </>
            ) : revealed ? (
              <div className="quiz-answer">
                <b>参考答案</b>
                <p>{q.answerText}</p>
              </div>
            ) : (
              <button className="btn-small" onClick={() => setRevealed(true)}>显示答案</button>
            )}

            {/* 自证：答案对了不等于会做，练熟之前请人写一段推理链（折叠，不挡路） */}
            {askRationale && rationaleVerdict === null && (
              <details className="quiz-rationale">
                <summary>这题做对了——写下你的推理链，确认不是蒙的（≥30 字）</summary>
                <textarea
                  className="quiz-reflect-input"
                  value={rationaleText}
                  onChange={(e) => setRationaleText(e.target.value)}
                  placeholder="从题干线索推到这个答案，中间经过哪几步？"
                  rows={3}
                  aria-label="作答自证"
                />
                <div className="quiz-reflect-foot">
                  <span className="muted">{rationaleHint(rationaleText)}</span>
                  {rationaleReady(rationaleText) && (
                    <>
                      <button className="btn-small" onClick={() => setRationaleVerdict('closed')}>
                        推理闭环了
                      </button>
                      <button
                        className="btn-small"
                        onClick={() => {
                          // 答对了但自己承认推理有洞：这题要回队列，不能因为「对了」就往前排
                          if (notePath) {
                            if (getMistake(notePath)) lapseMistake(notePath);
                            else recordMistake(notePath, q.stem);
                          }
                          setRationaleVerdict('guess');
                          toast(
                            notePath ? '答案对了但推理有漏洞：已记进错题本，下次优先重练' : '没有关联笔记，这条只记在本轮',
                            notePath ? 'ok' : 'info',
                          );
                        }}
                      >
                        答案对，但推理有漏洞
                      </button>
                    </>
                  )}
                </div>
              </details>
            )}
            {rationaleVerdict !== null && (
              <p className={rationaleVerdict === 'closed' ? 'quiz-rationale-done' : 'quiz-gate'} role="status">
                {rationaleVerdict === 'closed'
                  ? '逻辑闭环：答案对、推理也走得通，这题可以往后排。'
                  : '答案对但推理有漏洞——已回错题队列，下次优先重练。'}
              </p>
            )}
            {/* 门控期间先给反思框，解析正文换成一行提示——对错反馈始终可见 */}
            {gated && !gateOpen && (
              <div className="quiz-reflect">
                <p className="quiz-reflect-prompt">{gatePrompt(Boolean(results[idx]))}</p>
                <textarea
                  className="quiz-reflect-input"
                  value={reflectText}
                  onChange={(e) => setReflectText(e.target.value)}
                  placeholder="这题你是怎么排除其他选项的？"
                  rows={3}
                  aria-label="作答反思"
                />
                <div className="quiz-reflect-foot">
                  <span className="muted">{reflectionCounter(reflectText)}</span>
                  <label className="muted">
                    <input
                      type="checkbox"
                      checked={reflectAck}
                      onChange={(e) => setReflectAck(e.target.checked)}
                    />{' '}
                    我想过了，直接看解析
                  </label>
                </div>
              </div>
            )}
            {answered && expls.length === 1 && (
              <>
                {expls[0].source && <p className="muted">解析来源：{expls[0].source}</p>}
                <div className={`quiz-expl ${results[idx] ? 'is-right' : 'is-wrong'}`}>
                  <b>{results[idx] ? '✓ 答对了' : '✗ 答错了'}</b>
                  <p>{gateOpen ? expls[0].text : gatedHint}</p>
                </div>
              </>
            )}
            {/* 一题多解析：同题不同老师的讲法并排可选，切来源不丢其他份 */}
            {answered && expls.length > 1 && (
              <>
                <div className="quiz-expl-sources" role="group" aria-label="选择解析来源">
                  {expls.map((e, i) => (
                    <button
                      key={e.source || i}
                      className={`chip${explIdx === i ? ' on' : ''}`}
                      aria-pressed={explIdx === i}
                      onClick={() => setExplIdx(i)}
                    >
                      {e.source || `解析 ${i + 1}`}
                    </button>
                  ))}
                </div>
                {/* 与单条分支同结构：多解析也要看到「答对/答错」，否则答完这一块毫无反馈 */}
                <div className={`quiz-expl ${results[idx] ? 'is-right' : 'is-wrong'}`}>
                  <b>{results[idx] ? '✓ 答对了' : '✗ 答错了'}</b>
                  <p>{gateOpen ? expls[explIdx]?.text : gatedHint}</p>
                </div>
              </>
            )}
            {/* 作答复盘：把「错」拆成漏选/多选/错选，单选题答错也落到具体项上 */}
            {answered && !results[idx] && picked.length > 0 && (
              <p className="muted" role="status">{pickHint(analyzePick(q, picked))}</p>
            )}
            {/* 把握度对照：只把「报的」和「实际」并排摆出来，不下「你高估了」这种结论 */}
            {answered && confidence !== null && (
              <p className="muted" role="status">
                你报的是「{CONFIDENCE_LABELS[confidence]}」，这题{results[idx] ? '答对了' : '答错了'}
              </p>
            )}
            {/* 软门控：正确率偏低时只提示「先回看」，不锁下一题、不禁用任何按钮 */}
            {answered && weakChapter && (
              <p className="quiz-gate" role="status">
                这一章你做过 {weakChapter.seen} 题、答错 {weakChapter.wrong} 题（正确率 {Math.round(weakChapter.accuracy * 100)}%）
                —— 建议先回看{notePath ? '本节笔记' : '对应章节的笔记'}再继续练。
              </p>
            )}
            {q.type === 'recall' && revealed && !answered && (
              <div className="quiz-actions">
                <button className="btn-small" onClick={() => void judge(true)}>我答对了</button>
                <button className="btn-small danger" onClick={() => void judge(false)}>我答错了</button>
              </div>
            )}
          </div>

          {/* 前后翻题常驻：不必先答完这题才能走（题量大时靠「下一题」一题题磨过去不现实） */}
          <div className="quiz-nav">
            <button className="btn-small" disabled={idx === 0} onClick={() => goTo(idx - 1)}>
              ← 上一题
            </button>
            <label className="quiz-jump">
              第
              <input
                key={idx}
                type="number"
                min={1}
                max={session.questions.length}
                defaultValue={idx + 1}
                aria-label="跳到第几题"
                // 只在回车/失焦时跳：边输边跳会把人扔到别处
                onBlur={(e) => goTo(Number(e.target.value) - 1)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') goTo(Number((e.target as HTMLInputElement).value) - 1);
                }}
              />
              / {session.questions.length} 题
            </label>
          </div>

          {answered && (
            <div className="quiz-footer">
              {notePath && (
                <button className="btn-small" onClick={() => { onClose(); onOpenPath(notePath); }}>
                  打开笔记「{questionNoteLabel(q, notePath)}」
                </button>
              )}
              {/* 与 AI 笔记的联动：把这道题（含我的选择与对错）整段交给 AI 讲透。
                  本面板不收起来 —— AI 面板拿到引用后会抬到浮层之上（.agent-panel.has-quote），
                  练习到一半不会被打断。 */}
              {onAskAi && (
                <button
                  className="btn-small"
                  title="把这道题交给 AI 笔记讲透（先说我错在哪，再给依据）"
                  onClick={() => {
                    onAskAi({
                      text: [
                        `【题目】${q.stem}`,
                        ...(q.options.length ? q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`) : []),
                        `【参考答案】${q.answerText}`,
                        // 一题多解析全部带上（带来源名）：交给 AI 的引用不该只看到其中一份
                        ...(expls.length
                          ? [`【解析】${expls.map((e) => (e.source ? `${e.source}：${e.text}` : e.text)).join('\n')}`]
                          : []),
                        ...(picked.length > 0 && q.type === 'choice'
                          ? [`【我选的】${[...picked].sort((a, b) => a - b)
                            .map((i) => `${String.fromCharCode(65 + i)}. ${q.options[i] ?? ''}`)
                            .join('、')}（${results[idx] ? '答对了' : '答错了'}）`]
                          : []),
                        ...(q.chapter ? [`【章节】${q.chapter}`] : []),
                      ].join('\n'),
                      path: notePath,
                      ask: '帮我讲透这道题：先指出我错在哪（或哪里理解不牢），再讲正确答案的依据，最后给出该考点该连的 [[双链]]。',
                    });
                  }}
                >
                  问 AI 讲这题
                </button>
              )}
              {idx + 1 < session.questions.length ? (
                <button className="btn-primary quiz-next" onClick={next}>下一题 →</button>
              ) : (
                <button className="btn-primary quiz-next" onClick={next}>查看成绩 →</button>
              )}
            </div>
          )}
            </div>
            {notePaneNode}
          </div>
        </DialogSurface>
      </PanelOverlay>
    );
  }

  // ---------- 成绩页 ----------
  if (session) {
    const total = session.questions.length;
    const wrong = session.questions.filter((_, i) => results[i] === false);
    /** 真正进了错题本的错题数（关联不到笔记的题进不去，别把话说满） */
    const wrongFiled = wrong.filter((w) => notePathOf(w)).length;
    return (
      <PanelOverlay tone="quiz" onClose={requestClose}>
        <DialogSurface className="panel quiz-panel" label={`练习成绩：${session.bankName}`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">练习成绩 · {session.bankName}</span>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-result">
            <div className="score">{total ? Math.round((correctCount / total) * 100) : 0}<small>分</small></div>
            <p className="muted">{correctCount} / {total} 题正确{wrong.length > 0 && (
              wrongFiled === wrong.length
                ? `，答错的 ${wrongFiled} 题已收录进错题本`
                : `，答错的 ${wrong.length} 题中 ${wrongFiled} 题已收录进错题本`
            )}</p>
            {wrong.length > 0 && (
              <div className="quiz-wrong-list">
                {wrong.map((w) => {
                  const wp = notePathOf(w);
                  return (
                    <div key={w.id} className="quiz-wrong-item">
                      <span>{w.stem}</span>
                      <i>正解：{w.answerText}</i>
                      {wp && (
                        <button className="btn-small" onClick={() => { onClose(); onOpenPath(wp); }}>
                          打开笔记
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="quiz-actions center">
              <button className="btn-primary" onClick={async () => {
                const b = (await loadBanks()).find((x) => x.name === session.bankName);
                if (b) start(b, session.rules); // 沿用同一套组题规则，不偷偷换回「全部」
              }}>再练一轮</button>
              <button className="btn-small" onClick={exitToList}>返回题库列表</button>
            </div>
          </div>
        </DialogSurface>
      </PanelOverlay>
    );
  }

  // ---------- 自动组题 ----------
  if (composing) {
    const b = composing;
    // 候选池与「将要抽几题」实时算给用户看：范围/章节一改就能看到还剩多少题可抽，
    // 不然「做错过 + 某章」这种组合抽不到题时，用户只会以为按钮坏了
    const pool = filterPool(b.questions, rules, stats, b.name, undefined, stars, tagCtx ?? undefined);
    const willPick = rules.count > 0 ? Math.min(rules.count, pool.length) : pool.length;
    const chapters = chapterCounts(b.questions);
    /**
     * 选中的章节里正确率偏低的：组题前提示先回看，但不拦着不让练（软门控，O1 收尾）。
     *
     * 成员口径：章节清单（chapterCounts）与组题筛选（filterPool）都按 `chaptersOf(q)` 判
     * 「题属不属于某章」——多章节题在每个所属章节各计一次；而 mastery 的每一项**本身就是**
     * chaptersOf 的一个成员章节（core/qbankStats 里就是这么分组的），所以「某章被选中」
     * 与「题目有任一所属章节被选中」是同一个判断，这里用集合成员判定即可。
     * 没有 chapters 的历史题在 chaptersOf 里退回 [q.chapter]，结果与旧的
     * `rules.chapters.includes(m.chapter)` 逐字等价 —— 软门控只影响提示，不许悄悄改变行为。
     */
    const pickedChapters = new Set(rules.chapters);
    const weakPicked = mastery.filter((m) => m.weak && pickedChapters.has(m.chapter)).slice(0, 3);
    const toggleChapter = (c: string) =>
      setRules((r) => ({
        ...r,
        chapters: r.chapters.includes(c) ? r.chapters.filter((x) => x !== c) : [...r.chapters, c],
      }));
    const toggleTag = (t: QStatusTag) =>
      setRules((r) => {
        const tags = r.tags ?? [];
        return { ...r, tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] };
      });
    const toggleDiff = (d: DifficultyBand) =>
      setRules((r) => {
        const cur = r.difficulty ?? [];
        return { ...r, difficulty: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] };
      });
    return (
      <PanelOverlay tone="quiz" onClose={() => setComposing(null)}>
        <DialogSurface className="panel quiz-panel" label={`自动组题：${b.name}`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">自动组题 · {b.name}</span>
            <button className="btn-icon" onClick={() => setComposing(null)} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="panel__body quiz-body">
            <div className="compose-row">
              <span className="compose-label">题量</span>
              <div className="compose-chips">
                {[10, 20, 50, 100].map((c) => (
                  <button key={c} className={`chip${rules.count === c ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, count: c }))}>{c}</button>
                ))}
                <button className={`chip${rules.count === 0 ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, count: 0 }))}>全部</button>
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">范围</span>
              <div className="compose-chips">
                {([
                  ['all', '全部题目'], ['new', '没做过'], ['wrong', '做错过'], ['due', '今日待复习'], ['starred', '收藏题'],
                ] as Array<[ComposeScope, string]>).map(([v, label]) => (
                  <button key={v} className={`chip${rules.scope === v ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, scope: v }))}>{label}</button>
                ))}
              </div>
            </div>

            {/* 考点 / 难度：从逐题历史与题库本身算出的信号（core/qbankTags），不是外部考频表 */}
            <div className="compose-row">
              <span className="compose-label">考点</span>
              <div className="compose-chips">
                <button
                  className={`chip${rules.highFreqOnly ? ' on' : ''}`}
                  aria-pressed={!!rules.highFreqOnly}
                  title="只抽题量最多的那一档章节（高频考点）"
                  onClick={() => setRules((r) => ({ ...r, highFreqOnly: !r.highFreqOnly }))}
                >高频</button>
                {([['new', '新题'], ['weak', '易错'], ['learning', '在学'], ['solid', '已掌握']] as Array<[QStatusTag, string]>).map(([v, label]) => (
                  <button
                    key={v}
                    className={`chip${rules.tags?.includes(v) ? ' on' : ''}`}
                    aria-pressed={!!rules.tags?.includes(v)}
                    onClick={() => toggleTag(v)}
                  >{label}</button>
                ))}
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">难度</span>
              <div className="compose-chips">
                {(['easy', 'medium', 'hard', 'unknown'] as DifficultyBand[]).map((d) => (
                  <button
                    key={d}
                    className={`chip${rules.difficulty?.includes(d) ? ' on' : ''}`}
                    aria-pressed={!!rules.difficulty?.includes(d)}
                    title={d === 'unknown' ? '还没做过的题（FSRS 尚无难度估计）' : undefined}
                    onClick={() => toggleDiff(d)}
                  >{DIFFICULTY_LABELS[d]}</button>
                ))}
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">顺序</span>
              <div className="compose-chips">
                {([['shuffle', '乱序'], ['chapter', '按章节'], ['interleave', '按章节交错']] as Array<[ComposeOrder, string]>).map(([v, label]) => (
                  <button key={v} className={`chip${rules.order === v ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, order: v }))}>
                    {label}
                    {v === 'interleave' && <span className="muted">（推荐：混着练更能分辨相似知识点）</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">章节{rules.chapters.length > 0 && <b className="compose-picked">{rules.chapters.length}</b>}</span>
              <div className="compose-chapters">
                {chapters.map(({ chapter, count }) => (
                  <label key={chapter || '~none'} className={`compose-chapter${rules.chapters.includes(chapter) ? ' on' : ''}`}>
                    <input type="checkbox" checked={rules.chapters.includes(chapter)} onChange={() => toggleChapter(chapter)} />
                    <span className="compose-chapter-name">{chapter || '未标章节'}</span>
                    <span className="muted">{count}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="compose-chips compose-chips--end">
              <button className="chip" onClick={() => setRules((r) => ({ ...r, chapters: [] }))}>不限章节</button>
              <button className="chip" onClick={() => setRules((r) => ({ ...r, chapters: chapters.map((c) => c.chapter) }))}>全选</button>
            </div>

            {/* 软门控：只提示，不禁用「开始练习」 */}
            {weakPicked.length > 0 && (
              <p className="quiz-gate" role="status">
                选中的章节里 {weakPicked.map((m) => `${m.chapter}（正确率 ${Math.round(m.accuracy * 100)}%，做过 ${m.seen} 题）`).join('、')} 偏低
                —— 建议先回看对应笔记再练。
              </p>
            )}

            <p className="muted compose-summary">
              本轮将抽 <b>{willPick}</b> 题（候选 {pool.length} 题）。答错过的题与已到期的题权重更高，会优先出现。
            </p>

            <div className="quiz-actions">
              <button className="btn-primary" disabled={willPick === 0} onClick={() => { setComposing(null); start(b, rules); }}>
                开始练习
              </button>
              <button className="btn-small" onClick={() => setRules(DEFAULT_RULES)}>恢复默认</button>
            </div>
          </div>
        </DialogSurface>
      </PanelOverlay>
    );
  }

  // ---------- 题库列表 ----------
  return (
    <PanelOverlay tone="quiz" onClose={requestClose}>
      <DialogSurface className="panel quiz-panel" label="题库练习" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">题库练习</span>
          <button className="btn-primary quiz-import-toggle" aria-expanded={importOpen} aria-controls="quiz-import-options" onClick={() => setImportOpen((open) => !open)}>
            {importOpen ? '收起导入' : '导入题库'}
          </button>
          <button className="btn-icon" onClick={() => setShowHelp(!showHelp)} aria-label="格式说明" aria-expanded={showHelp} aria-controls="quiz-format-help" title="题库 JSON 格式说明"><IconHelp /></button>
          <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
        </div>

        {/* 搜题：跨题库按关键词找题（题干 / 考点 / 选项 / 解析）。输入即搜，非空时下方列表区改显结果。 */}
        <div className="quiz-searchbar">
          <input
            className="quiz-search-input"
            type="search"
            placeholder="搜题：题干 / 考点 / 选项关键词（跨题库）"
            aria-label="搜索题目"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
          {searching && <button className="btn-small" onClick={() => setSearchQ('')}>清除</button>}
          {generatable > 0 && (
            <button
              type="button"
              className="btn-small"
              onClick={generateMistakeCards}
              title="答错 3 次以上、且还没生成过卡片的题：生成后会进入复习队列"
            >
              错题卡 +{generatable}
            </button>
          )}
        </div>

        <div className="quiz-help" id="quiz-format-help" hidden={!showHelp}>
            <p className="muted">导入格式（保存为 .json 文件导入，或直接粘贴）：</p>
            <pre>{HELP_TEXT}</pre>
        </div>

        <div className="quiz-import" id="quiz-import-options" hidden={!importOpen}>
          {onUnifiedImport ? (
            /* 统一入口：不再单独摆 .json/.docx/.xlsx 三个按钮（用户得先知道自己的文件是哪种才点得对）；
               点这一条由 Workspace 打开统一导入面板，自动识别格式（题库 / 笔记 / Anki / 数据集 / Word·PDF·Excel）。
               粘贴框保留 —— 剪贴板里的文本没有文件可拖，走不了自动识别。 */
            <button className="btn-small" onClick={onUnifiedImport} title="一个入口导入所有资料：自动识别题库 JSON / Word / Excel / 笔记 / Anki 牌组 / 数据集 / 备份，支持多选与拖拽批量处理">
              <IconRestore /> 导入…（自动识别格式）
            </button>
          ) : (
            <>
          <button className="btn-small" onClick={() => fileRef.current?.click()} disabled={batchBusy} title="可一次多选：逐个导入并逐个回报结果。同业 App 导出的题库 JSON（短键 / 富文本字段名）会自动识别形状后导入；识别不出会告诉你缺哪些字段">
            <IconRestore /> 题库文件 (.json)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void importFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button className="btn-small" onClick={() => docxRef.current?.click()} disabled={batchBusy} title="Word 文档：自动抽取文本并识别题目（仅支持 .docx），可一次多选">
            Word (.docx)
          </button>
          <input
            ref={docxRef}
            type="file"
            accept=".docx,.doc"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void importFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button className="btn-small" onClick={() => xlsxRef.current?.click()} disabled={batchBusy} title="Excel/CSV：表头含「题干/答案」，选项列用 A/B/C/D 或 选项1..4，可一次多选">
            Excel/CSV (.xlsx/.csv)
          </button>
          <input
            ref={xlsxRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void importFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
            </>
          )}
          {batchBusy && <span className="muted">正在逐个导入…</span>}
          {/* 逐文件结果常驻在面板里：一次拖进十来个文件时，只弹一句「导入完成」等于没说清
              哪些成了、哪些没成、为什么没成。 */}
          {batchReport && (
            <div className="quiz-import-report" role="status" aria-label="批量导入结果">
              <div className="quiz-import-report-head">
                <b>导入结果</b>
                <span className="muted">
                  {batchReport.filter((r) => r.ok).length}/{batchReport.length} 个文件成功 · 共{' '}
                  {batchReport.reduce((n, r) => n + (r.count ?? 0), 0)} 题
                </span>
                <button className="btn-small" onClick={() => setBatchReport(null)}>收起</button>
              </div>
              <ul>
                {batchReport.map((r) => (
                  <li key={r.file} className={r.ok ? 'ok' : 'err'}>
                    <span className="quiz-import-report-file" title={r.file}>{r.file}</span>
                    {r.ok
                      ? (
                        <span className="muted">
                          {r.bank} · {r.count} 题
                          {/* 走了自动识别形状通道时补一句映射说明：识别成什么、置信度、跳过了哪几条 */}
                          {r.note ? ` · ${r.note}` : ''}
                          {/* 同名题库走了增量合并时补一句合并结果：新增几题、已存在几题（跳过）。
                              新库名的路径不会有这一段，原来的「题库名 · N 题」逐字不变。 */}
                          {r.merge ? ` · ${r.merge}` : ''}
                        </span>
                      )
                      : <span className="quiz-import-report-err">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <span className="muted">或粘贴 JSON：</span>
          <textarea
            className="quiz-paste"
            placeholder='[{"stem": "题干", "options": ["A", "B"], "answer": 0, "note": "关联笔记名"}]'
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={3}
          />
          <button className="btn-small" disabled={!pasteText.trim()} onClick={() => doImport(pasteText, `粘贴题库 ${new Date().toLocaleDateString()}`)}>
            粘贴导入
          </button>
        </div>

        {searching ? (
          <div className="quiz-search-results" role="region" aria-label="搜题结果">
            <p className="muted" role="status">
              找到 {searchHits.length} 条{searchHits.length >= 60 ? '（仅显示前 60 条，缩小关键词更精确）' : ''}
            </p>
            {searchHits.length === 0 ? (
              <p className="muted">没有匹配的题目。换个关键词，或确认题库已导入。</p>
            ) : (
              <ul>
                {searchHits.map((h) => {
                  const b = banks.find((x) => x.name === h.bank);
                  const ctx = ctxByBank.get(h.bank);
                  const stat = statOf(stats, h.bank, h.question.id);
                  const qTags = ctx ? tagsOf(h.question, stat, ctx) : [];
                  const d = difficultyBand(stat);
                  const on = isStarred(stars, h.bank, h.question.id);
                  return (
                    <li key={`${h.bank}\u0000${h.question.id}`} className="quiz-search-item">
                      <div className="quiz-search-meta">
                        <span className="quiz-search-bank">{h.bank}</span>
                        {h.question.chapter && <span className="quiz-chapter">{h.question.chapter}</span>}
                        {h.primary !== 'stem' && <span className="exam-tag">命中{QUESTION_FIELD_LABELS[h.primary]}</span>}
                        {qTags.map((t) => <span key={t} className={`exam-tag exam-tag--${t}`}>{Q_TAG_LABELS[t]}</span>)}
                        {d !== 'unknown' && <span className={`exam-tag exam-tag--diff-${d}`}>难度·{DIFFICULTY_LABELS[d]}</span>}
                      </div>
                      <p className="quiz-search-stem">
                        {segment(h.text, h.hits).map((s, i) =>
                          s.hit ? <mark key={i} className="qs-mark">{s.text}</mark> : <span key={i}>{s.text}</span>,
                        )}
                      </p>
                      <div className="quiz-search-actions">
                        {b && <button className="btn-small" onClick={() => startOne(b, h.question)}>练这题</button>}
                        <button
                          className={`btn-icon quiz-star${on ? ' on' : ''}`}
                          aria-pressed={on}
                          aria-label={on ? '取消收藏' : '收藏这道题（重点题）'}
                          title={on ? '取消收藏' : '收藏 / 标为重点题'}
                          onClick={() => void toggleStarFor(h.bank, h.question.id)}
                        >{on ? '★' : '☆'}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
        <div className="quiz-banks">
          {todayKnowledge && (
            <div className={`quiz-resume quiz-knowledge${knowDone ? ' is-done' : ''}`} role="status">
              <div className="quiz-resume__text">
                <b>
                  今日知识点 · {todayKnowledge.chapter}
                  {knowDone && <span className="quiz-knowledge__flag">今天看过了</span>}
                </b>
                <span className="muted">
                  「{todayKnowledge.bank}」这个知识点 {todayKnowledge.count} 题
                  {todayKnowledge.wrong > 0 && ` · 错过 ${todayKnowledge.wrong} 次`}
                  {todayKnowledge.due > 0 && ` · ${todayKnowledge.due} 题到期`}
                  {todayKnowledge.count > 0 && ` · 掌握度 ${Math.round(todayKnowledge.mastery * 100)}%`}
                  {todayKnowledge.reason === 'fresh' && ' · 还没练过'}
                </span>
              </div>
              <button className="btn-primary" onClick={() => startKnowledge(todayKnowledge)}>
                练这 5 题
              </button>
              {!knowDone && (
                <button
                  className="btn-small"
                  onClick={() => {
                    if (markKnowledgeDone(todayKnowledge)) setKnowDoneKey(`${todayKnowledge.date}|${todayKnowledge.bank}|${todayKnowledge.chapter}`);
                  }}
                >
                  今天看过了
                </button>
              )}
            </div>
          )}
          {cursor && banks.some((b) => b.name === cursor.bank) && (
            <div className="quiz-resume" role="status">
              <div className="quiz-resume__text">
                <b>上次没练完</b>
                <span className="muted">
                  「{cursor.bank}」练到第 {cursor.idx + 1}/{cursor.qids.length} 题
                  {new Date(cursor.at).toLocaleString()} · 已答过的题在逐题记录里
                </span>
              </div>
              <button className="btn-primary" onClick={() => resumeLast(cursor)}>继续上次</button>
              <button className="btn-small" onClick={() => { clearCursor(); setCursor(null); }}>不用了</button>
            </div>
          )}
          {banks.length === 0 && (
            <div className="quiz-empty">
              <h2>还没有题库</h2>
              <p className="muted">导入 JSON、Word 或 Excel 题目开始练习；答错的题会自动收录进错题本</p>
              <button className="btn-primary" onClick={() => setImportOpen(true)}>导入第一份题库</button>
            </div>
          )}
          {banks.length > 0 && (
            <div className="bank-toolbar">
              <span className="muted">{banks.length} 个题库</span>
              <button
                className="btn-small"
                aria-pressed={openBankActions.size === banks.length}
                onClick={() => toggleAllBankActions(openBankActions.size < banks.length)}
              >
                {openBankActions.size === banks.length ? '收起操作' : '展开操作'}
              </button>
            </div>
          )}
          {banks.map((b, i) => {
            const p = progress.get(b.name);
            const open = openBankActions.has(b.name);
            return (
              <div key={b.name} className={`bank-item stagger-item${open ? ' is-open' : ''}`} style={{ ['--i' as string]: Math.min(i, 12) }}>
                <div className="bank-info">
                  <div className="bank-name">{b.name}</div>
                  <div className="muted">
                    {b.questions.length} 题 · {new Date(b.importedAt).toLocaleDateString()} 导入
                    {p && p.seen > 0 && (
                      <>
                        {' · '}做过 {p.seen}
                        {p.wrong > 0 && <> · 错过 {p.wrong}</>}
                        {p.due > 0 && <> · <b className="bank-due">待复习 {p.due}</b></>}
                      </>
                    )}
                    {starCount(stars, b.name) > 0 && <> · <b className="bank-star">★ {starCount(stars, b.name)}</b></>}
                  </div>
                </div>
                <button
                  className="btn-small bank-actions-toggle"
                  aria-expanded={open}
                  aria-label={`操作：${b.name}`}
                  onClick={() => toggleBankActions(b.name)}
                >
                  操作
                </button>
                {open && (
                  <div className="bank-actions" role="group" aria-label={`${b.name} 的操作`}>
                    <button className="btn-small" onClick={() => { setRules(DEFAULT_RULES); setComposing(b); }}>组题</button>
                    <button className="btn-small" onClick={() => startBeat(b, null)} title="不判分，直接摊开答案背一遍">背题</button>
                    {onOpenExam && <button className="btn-small" onClick={() => onOpenExam(b.name)} title="限时整卷，交卷自动评分">模拟考试</button>}
                    <button className="btn-small" title="不组题，整库洗牌后全部做完" onClick={() => start(b, null)}>整库练习</button>
                    <button className="btn-small" title="导出本题库为 Anki 导入文件" onClick={() => downloadFile(`${b.name}-anki.txt`, bankToAnki(b))}>导出 Anki</button>
                    <button
                      className="btn-small danger"
                      onClick={() => {
                        void confirmBox({ title: `删除题库「${b.name}」？`, danger: true, okText: '删除' })
                          .then(async (ok) => { if (ok) setBanks(await removeBank(b.name)); });
                      }}
                    >删除题库</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
      </DialogSurface>
    </PanelOverlay>
  );
}
