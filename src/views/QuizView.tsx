/**
 * 题库练习：导入 JSON 题库（文件或粘贴）→ 选库组卷 → 逐题作答 → 结果页错题回顾。
 * 答错且题目关联笔记（note 字段可解析）时自动记入错题本。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc } from './useEsc';
import {
  addBank, loadBanks, pickQuestions, removeBank, setOptionNote,
  correctIndices, explanationsOf, isCorrectPick, isMultiSelect,
  chaptersOf,
  type QuizBank, type QuizQuestion,
} from '../core/qbank';
import { parseQbankFile, parseQbankJsonText } from '../core/qbankParse';
import { mergeQuestions, mergeSummary } from '../core/qbankMerge';
import {
  DEFAULT_RULES, chapterCounts, composeQuestions, filterPool,
  type ComposeOrder, type ComposeRules, type ComposeScope,
} from '../core/qbankCompose';
import { bankProgress, chapterMastery, consumeSaveFailure, initializeStats, loadStats, recordAnswer, statOf } from '../core/qbankStats';
import { initializeStars, isStarred, loadStars, starCount, toggleStar, type StarMap } from '../core/qbankStarred';
import { QUESTION_FIELD_LABELS, searchBanks } from '../core/qbankSearch';
import { segment } from '../core/searchHit';
import { buildTagContext, difficultyBand, DIFFICULTY_LABELS, Q_TAG_LABELS, tagsOf, type DifficultyBand, type QStatusTag } from '../core/qbankTags';
import { CONFIDENCE_LABELS, CONFIDENCE_VALUES, recordCalibration, type Confidence } from '../core/qbankCalib';
import { buildChapterIndex, questionNoteLabel, resolveQuestionNote } from '../core/qbankNotes';
import { recordMistake } from '../core/mistakes';
import { toast, confirmBox } from '../core/feedback';
import { markStudy } from '../core/stats';
import { bankToAnki, downloadFile } from '../core/anki';
import { IconRestore, IconClose, IconHelp, IconPencil } from './icons';
import type { QuoteSelection } from './AiAgentPanel';

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
export default function QuizView({ docs, resolveLink, onOpenPath, onClose, onAskAi, onOpenExam, resolveAsset, onUnifiedImport, refreshToken }: Props) {
  const [banks, setBanks] = useState<QuizBank[]>([]);
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
  /** 作答前自报的把握度（1~5）；null = 没报。可选，不报也能作答，只是不计入校准样本 */
  const [confidence, setConfidence] = useState<Confidence | null>(null);
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
  /** 收藏/重点题（与逐题统计分开，见 core/qbankStarred）：组题范围与练习中收藏按钮都用它 */
  const [stars, setStars] = useState<StarMap>(loadStars);
  /** 搜题关键词（跨题库）；非空时题库列表区改显搜索结果 */
  const [searchQ, setSearchQ] = useState('');
  /** 背题模式：不判分、直接摊开答案背一遍（进入即按「背题」渲染，见下方背题分支） */
  const [beatMode, setBeatMode] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([loadBanks(), initializeStats(), initializeStars()]).then(([loadedBanks, loadedStats, loadedStars]) => {
      if (!active) return;
      setBanks(loadedBanks);
      if (loadedBanks.length === 0) setImportOpen(true);
      setStats(loadedStats);
      setStars(loadedStars);
      setLoadError(null);
      setReady(true);
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

  // Exit policy: a practice run in progress must not be lost to a stray click.
  const inProgress = Boolean(session) && results.some((r) => r === true || r === false);
  const requestClose = () => {
    if (inProgress === false) { onClose(); return; }
    void confirmBox({
      title: '练习题还没做完，确定退出？',
      detail: '已作答的记录不会保存',
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

  const q = session?.questions[idx];
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

  /** 答错且关联笔记存在 → 记入错题本；同时对每道题记一次逐题历史（错题加权与 FSRS 排程的数据源） */
  const judge = async (correct: boolean) => {
    if (!q) return;
    markStudy(); // 打卡
    // 报过把握度才记样本：校准要的是「自信 vs 实际」的对照，没报的作答没有对照价值
    if (confidence !== null) recordCalibration(confidence, correct);
    setResults((prev) => prev.map((r, i) => (i === idx ? correct : r)));
    await recordAnswer(session!.bankName, q.id, correct);
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

  const next = () => {
    setPicked([]);
    setRevealed(false);
    setExplIdx(0);
    setConfidence(null);
    setEditing(null);
    setIdx((i) => i + 1);
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

  // ---------- 渲染 ----------
  if (!ready || loadError) {
    return (
      <div className="panel-backdrop quiz-overlay">
        <DialogSurface className="panel quiz-panel" label={loadError ? '题库加载失败' : '题库正在加载'}>
          <div className="panel__body quiz-body">
            <p role="status">{loadError ?? '\u6b63\u5728\u52a0\u8f7d\u9898\u5e93...'}</p>
            {loadError && <button className="btn-small" onClick={() => setReloadKey((key) => key + 1)}>{'\u91cd\u8bd5'}</button>}
          </div>
        </DialogSurface>
      </div>
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
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <DialogSurface className="panel quiz-panel" label={`背题模式，第 ${idx + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">背题 · {session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <button
              className={`btn-icon quiz-star${starredNow ? ' on' : ''}`}
              aria-pressed={starredNow}
              aria-label={starredNow ? '取消收藏这道题' : '收藏这道题（重点题）'}
              title={starredNow ? '取消收藏' : '收藏 / 标为重点题'}
              onClick={() => void toggleCurrentStar()}
            >{starredNow ? '★' : '☆'}</button>
            <button className="btn-small" onClick={() => setBeatMode(false)}>退出背题</button>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-progress"><i style={{ width: `${((idx + 1) / session.questions.length) * 100}%` }} /></div>
          <div className="panel__body quiz-body">
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
                {q.options.map((opt, i) => (
                  <div key={i} className={`opt${right.includes(i) ? ' right' : ''}`}>
                    <b>{String.fromCharCode(65 + i)}</b> {opt}
                    {right.includes(i) && <span className="opt-mark">✓</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="quiz-answer"><b>参考答案</b><p>{q.answerText}</p></div>
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
              <button className="btn-primary" onClick={() => setSession(null)}>结束背题</button>
            )}
          </div>
        </DialogSurface>
      </div>
    );
  }

  if (session && q) {
    const answered = results[idx] !== undefined;
    const notePath = notePathOf(q);
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
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <DialogSurface className="panel quiz-panel" label={`${session.bankName}练习，第 ${idx + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">{session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <span className="muted">已对 {correctCount}</span>
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

          <div className="panel__body quiz-body">
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
                        {answered && right && <span className="opt-mark">✓</span>}
                        {answered && chosen && !right && <span className="opt-mark">✗</span>}
                      </button>
                      {optImg ? (
                        <figure className="opt-figure">
                          <img className="opt-img" src={optImg} alt={`选项 ${letter} 的图`} loading="lazy" />
                        </figure>
                      ) : null}
                      {/* 批注只在答案出现后可写：先看答案再记「为什么」，避免猜着写 */}
                      {answered && (
                        <button
                          className={`btn-icon opt-note-btn${note ? ' has-note' : ''}`}
                          aria-label={note ? `修改选项 ${letter} 的批注` : `给选项 ${letter} 写批注`}
                          title={note ? '修改批注' : '给这个选项写批注'}
                          onClick={() => (editing === i ? setEditing(null) : beginNote(i))}
                        >
                          <IconPencil size={14} />
                        </button>
                      )}
                      {answered && editing === i ? (
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
                      ) : answered && note ? (
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

            {answered && expls.length === 1 && (
              <>
                {expls[0].source && <p className="muted">解析来源：{expls[0].source}</p>}
                <div className={`quiz-expl ${results[idx] ? 'is-right' : 'is-wrong'}`}>
                  <b>{results[idx] ? '✓ 答对了' : '✗ 答错了'}</b>
                  <p>{expls[0].text}</p>
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
                  <p>{expls[explIdx]?.text}</p>
                </div>
              </>
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
        </DialogSurface>
      </div>
    );
  }

  // ---------- 成绩页 ----------
  if (session) {
    const total = session.questions.length;
    const wrong = session.questions.filter((_, i) => results[i] === false);
    /** 真正进了错题本的错题数（关联不到笔记的题进不去，别把话说满） */
    const wrongFiled = wrong.filter((w) => notePathOf(w)).length;
    return (
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
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
              <button className="btn-small" onClick={() => setSession(null)}>返回题库列表</button>
            </div>
          </div>
        </DialogSurface>
      </div>
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
      <div className="panel-backdrop quiz-overlay" onClick={() => setComposing(null)}>
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
      </div>
    );
  }

  // ---------- 题库列表 ----------
  return (
    <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
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
          {banks.length === 0 && (
            <div className="quiz-empty">
              <h2>还没有题库</h2>
              <p className="muted">导入 JSON、Word 或 Excel 题目开始练习；答错的题会自动收录进错题本</p>
              <button className="btn-primary" onClick={() => setImportOpen(true)}>导入第一份题库</button>
            </div>
          )}
          {banks.map((b, i) => {
            const p = progress.get(b.name);
            return (
              <div key={b.name} className="bank-item stagger-item" style={{ ['--i' as string]: Math.min(i, 12) }}>
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
                <button className="btn-small" onClick={() => { setRules(DEFAULT_RULES); setComposing(b); }}>组题</button>
                <button className="btn-small" onClick={() => startBeat(b, null)} title="不判分，直接摊开答案背一遍">背题</button>
                {onOpenExam && <button className="btn-small" onClick={() => onOpenExam(b.name)} title="限时整卷，交卷自动评分">模拟考试</button>}
                <details className="bank-more">
                  <summary aria-label={`更多操作：${b.name}`}>更多</summary>
                  <div className="bank-more-menu">
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
                </details>
              </div>
            );
          })}
        </div>
        )}
      </DialogSurface>
    </div>
  );
}
