/**
 * 单词工坊：跟打 / 听写 / 自测三种打字式背词模式 + 错词本 + 自定义词库。
 *
 * 三条与「手感」直接相关的规则（改交互前先读）：
 * 1. **答错不跳题**：打错后停在当前词，逐字符对照「你打的 vs 正确」，按 Enter 才继续。
 *    直接跳到下一题会把错因一起带走，等于没纠错。
 * 2. **逐字对照走 LCS 对齐**（`core/wordDrill.diffChars`）：少打一个字母只标那一个位置，
 *    不会把后面全染红。
 * 3. **音效不是装饰**：敲键、答对、答错三种反馈都有独立音色（`core/keySound`，WebAudio 合成，
 *    无音频资源），可以一键关掉并存本地。
 *
 * 项目约定：遮罩走 `PanelOverlay`，Esc 走 `useEsc`，持久化只在 core 层，视图不碰 localStorage。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { playSound, setSoundEnabled, soundEnabled } from '../core/keySound';
import { agentNetHint, isAbortError, runAgent, type AgentSettings, type WireMessage } from '../core/aiAgent';
import { loadAgentSettings } from '../core/agentSettings';
import {
  STORY_ARCHIVE_LIMIT,
  analysisBatches,
  archiveFileName,
  buildAnalysisMessages,
  buildStoryMessages,
  clearStoryArchive,
  loadStoryArchive,
  makeStoryArchiveEntry,
  newStoryId,
  parseAnalysis,
  parseStory,
  removeStoryArchive,
  saveStoryArchive,
  storyArchiveToMarkdown,
  storyCoverage,
  storyFileName,
  storySurfaceForms,
  maskStoryText,
  storyToMarkdown,
  storyToMarkdownDocument,
  upsertStoryArchive,
  weakestWords,
  wordForms,
  type StoryAnalysis,
  type StoryArchiveEntry,
  type StoryLine,
  type WeakWord,
  type WordStory,
} from '../core/wordStory';
import { downloadTextFile } from '../core/download';
import {
  DRILL_SIZES,
  NEW_LIMIT_MAX,
  REVIEW_LIMIT_MAX,
  WORD_BANKS,
  bankSummary,
  dailyPlan,
  dailySeries,
  diffChars,
  hintOf,
  judge,
  loadBank,
  loadCustomWords,
  loadDaily,
  loadRecords,
  loadSettings,
  nextRecord,
  normWord,
  parseWordList,
  parseWordBankFile,
  pickDailyQueue,
  pickQueue,
  recordDaily,
  saveCustomWords,
  saveDaily,
  saveRecords,
  saveSettings,
  searchWords,
  shuffle,
  speakWord,
  speakText,
  wordState,
  wrongBook,
  type DailyPlan,
  type DrillDaily,
  type DrillMode,
  type QueueFilter,
  type Verdict,
  type Word,
  type WordRecord,
  type WordState,
} from '../core/wordDrill';
import { addVocab, loadVocab, rateVocab, vocabCardKey } from '../core/vocab';
import { recordReview } from '../core/studyLog';
import PanelOverlay from './PanelOverlay';
import { escThenClose, useEsc } from './useEsc';

interface Props {
  onClose: () => void;
  /** 保存完整短文笔记（Workspace 转发 vault.save + openNote）；未传时隐藏「存为笔记」 */
  onSaveNote?: (dir: string, title: string, content: string) => Promise<string>;
}

type Phase = 'idle' | 'run' | 'done';
type BankId = string;

interface Answered {
  word: Word;
  ok: boolean;
}

interface Pending {
  verdict: Verdict;
  given: string;
  word: Word;
}

const MODES: Array<{ id: DrillMode; label: string; tip: string }> = [
  { id: 'copy', label: '跟打', tip: '看着单词敲一遍：建立拼写的肌肉记忆' },
  { id: 'dictation', label: '听写', tip: '只听发音、看释义，把拼写敲出来' },
  { id: 'recall', label: '自测', tip: '先在心里回忆，再翻答案自评记得 / 忘了' },
];

const DEFAULT_MODE = MODES[0];

const VERDICT_TEXT: Record<Verdict, string> = {
  right: '打对了',
  near: '差一点',
  wrong: '打错了',
};

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 词条状态的中文标签（查词列表用） */
const STATE_LABEL: Record<WordState, string> = {
  new: '未学',
  due: '待复习',
  later: '未到期',
  mastered: '已掌握',
};

/** 最近 14 天正确率折线：只用有作答的天连点，空白天不画成 0% */
function Sparkline({ series }: { series: Array<{ key: string; total: number; rate: number }> }) {
  const width = 260;
  const height = 46;
  const pad = 4;
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  const x = (i: number) => pad + i * step;
  const y = (rate: number) => pad + (1 - rate) * (height - pad * 2);
  const drawn = series.map((d, i) => ({ ...d, x: x(i), y: y(d.rate) })).filter((d) => d.total > 0);
  const points = drawn.map((d) => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' ');

  return (
    <svg className="wd-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近 14 天正确率">
      {drawn.length > 1 && (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      )}
      {drawn.map((d) => (
        <circle key={d.key} cx={d.x} cy={d.y} r="1.9" fill="currentColor" />
      ))}
    </svg>
  );
}

/** 例句里的目标词挖空（听写模式用），避免直接送答案。
 *  除了原词，还遮常见词形（spectators / studied / studying…）：只遮原词时，
 *  例句里留着变体，等于把答案换个后缀写在题目上。 */
function maskWord(example: string, en: string): string {
  const target = en.trim().toLowerCase();
  if (!target) return example;
  let out = example;
  try {
    const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = example.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '____');
  } catch {
    /* 正则构造失败时退回下面的逐词匹配 */
  }
  // 多词术语已经整体遮掉；单词再补常见词形
  if (/\s/.test(en)) return out;
  const forms = new Set([
    target,
    `${target}s`,
    `${target}es`,
    `${target}ed`,
    `${target}d`,
    `${target}ing`,
    `${target}ly`,
  ]);
  if (target.endsWith('e')) {
    forms.add(`${target.slice(0, -1)}ing`);
    forms.add(`${target}d`);
  }
  if (target.endsWith('y')) {
    forms.add(`${target.slice(0, -1)}ies`);
    forms.add(`${target.slice(0, -1)}ied`);
  }
  return out.replace(/[A-Za-z][A-Za-z'’-]*/g, (token) => (forms.has(token.toLowerCase()) ? '____' : token));
}

/** 词库里的释义带词性和全部义项，chip 里只留第一个义项，完整释义放 title */
function shortGloss(zh: string): string {
  const first = (zh.split(/[；;]/)[0] ?? '').trim();
  return first.length > 16 ? `${first.slice(0, 16)}…` : first;
}

/** 历史列表的时间：只到分钟，不展示年份，列表更安静 */
function fmtStoryTime(ts: number): string {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 短文里的目标词标亮。优先用模型回报的实际形态（went / children），
 *  没有回报时退回词形规则；标亮只做阅读提示，不宣称覆盖数量。 */
function highlightTargets(text: string, words: readonly Word[], forms: readonly string[] = []): ReactNode {
  const alts = (forms.length ? [...forms] : words.flatMap((w) => wordForms(w.en)))
    .sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  if (!alts.length) return text;
  const re = new RegExp(`(?<![A-Za-z])(?:${alts.join('|')})(?![A-Za-z])`, 'gi');
  const out: ReactNode[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark className="wd-story__mark" key={`${m.index}-${m[0]}`}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : text;
}

/** 背诵模式的挖空：把占位符渲染成带底色的空，不只显示下划线 */
function maskedTargets(text: string, forms: readonly string[]): ReactNode {
  const masked = maskStoryText(text, forms);
  if (masked === text) return text;
  const parts = masked.split('＿＿＿');
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && (
        <span className="wd-story__blank" title="目标词">
          ＿＿＿
        </span>
      )}
    </span>
  ));
}

export default function WordDrillView({ onClose, onSaveNote }: Props) {
  const [records, setRecords] = useState<Record<string, WordRecord>>(loadRecords);
  const recordsRef = useRef(records);
  const [daily, setDaily] = useState<DrillDaily>(loadDaily);
  const dailyRef = useRef(daily);
  const [customWords, setCustomWords] = useState<Word[]>(loadCustomWords);
  const [sound, setSound] = useState(soundEnabled);

  /** 上次用的词库 / 模式 / 题量 / 配额：只读一次，之后由 effect 回写 */
  const [saved] = useState(loadSettings);

  const [bankId, setBankId] = useState<BankId>(() =>
    saved.bankId === 'custom' && customWords.length === 0 ? 'cet6' : saved.bankId,
  );
  const [bankWords, setBankWords] = useState<Word[]>([]);
  const [bankStatus, setBankStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bankError, setBankError] = useState('');
  /** 加载失败后点「重试」：自增一次让上面的 effect 重新发请求 */
  const [bankReload, setBankReload] = useState(0);
  const [mode, setMode] = useState<DrillMode>(saved.mode);
  const [size, setSize] = useState(saved.size);
  const [newLimit, setNewLimit] = useState(saved.newLimit);
  const [reviewLimit, setReviewLimit] = useState(saved.reviewLimit);

  const [phase, setPhase] = useState<Phase>('idle');
  const [queue, setQueue] = useState<Word[]>([]);
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState<Answered[]>([]);
  const [feedback, setFeedback] = useState<{ verdict: Verdict; word: Word } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState('');
  const [asideTab, setAsideTab] = useState<'wrong' | 'bank' | 'lookup'>('wrong');
  const [importText, setImportText] = useState('');
  const [pendingFileWords, setPendingFileWords] = useState<Word[] | null>(null);
  const [filePreview, setFilePreview] = useState<{
    name: string;
    total: number;
    duplicates: number;
    skipped: number;
  } | null>(null);
  const [lookupQuery, setLookupQuery] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);

  /** 薄弱词成文：短文 / 逐句精读是两块独立结果，精读失败时短文仍然保留 */
  const [storyOpen, setStoryOpen] = useState(false);
  const [story, setStory] = useState<WordStory | null>(null);
  const [analysis, setAnalysis] = useState<StoryAnalysis | null>(null);
  const [storyPicks, setStoryPicks] = useState<WeakWord[]>([]);
  const [storyBusy, setStoryBusy] = useState<'story' | 'analysis' | null>(null);
  const [storyError, setStoryError] = useState('');
  const [storyNotice, setStoryNotice] = useState('');
  const [storyChars, setStoryChars] = useState(0);
  /** 背诵模式：默认挖空 + 遮译文；显示答案后才露出精读 */
  const [recite, setRecite] = useState(false);
  const [reciteAnswers, setReciteAnswers] = useState(false);
  /** 历史短文：只在成功拿到短文后落盘；重试精读按 id 覆盖，不多出一篇 */
  const [archive, setArchive] = useState<StoryArchiveEntry[]>(loadStoryArchive);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [archivePinnedOnly, setArchivePinnedOnly] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [storyId, setStoryId] = useState<string | null>(null);
  /** 自增触发「自定义词库」导入框聚焦：等 React 提交完导入区再 focus */
  const [focusImportKey, setFocusImportKey] = useState(0);
  const archiveRef = useRef(archive);
  /** 打开面板时确认 AI 配置是否就绪：配置在另一个面板里，关掉再回来会重新求值 */
  const [aiReady] = useState(() => Boolean(loadAgentSettings()));

  const inputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const importRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const startedAt = useRef(0);
  /** 中文输入法组词期间不提交、不响敲键声 */
  const composing = useRef(false);
  const storyAbort = useRef<AbortController | null>(null);

  /** 面板卸载时停掉还在跑的模型请求，避免回到列表后继续烧 token */
  useEffect(() => () => storyAbort.current?.abort(), []);

  /** 导入区挂载后再聚焦：直接写在点击回调的 rAF 里，真实浏览器可能抢在 React 提交前 */
  useEffect(() => {
    if (!focusImportKey) return;
    const el = importRef.current;
    if (!el) return;
    el.focus();
    const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches;
    if (narrow && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusImportKey]);

  /** 设置回写：事件里改 state，effect 里只做持久化（不在渲染期写盘） */
  useEffect(() => {
    saveSettings({ bankId, mode, size, newLimit, reviewLimit });
  }, [bankId, mode, size, newLimit, reviewLimit]);

  /** 中途关闭前确认：已经答过题但这一轮还没做完，丢掉的是剩下的题 */
  const requestClose = () => {
    if (phase === 'run' && answers.length > 0 && answers.length < queue.length) {
      const remain = queue.length - answers.length;
      if (!window.confirm(`这一轮还没练完，还剩 ${remain} 个词。关闭会丢掉未完成的进度，确定关闭？`)) {
        return;
      }
    }
    onClose();
  };

  useEsc(escThenClose(requestClose));

  /** 词库按需下载：切换词库时才拉 JSON，拉完缓存在 core 里。
   *  这里只发起请求、在回调里落状态 —— 同步 setState 放在 effect 里会触发级联渲染（lint 会拦）。 */
  useEffect(() => {
    if (bankId === 'custom') return;
    let alive = true;
    loadBank(bankId)
      .then((list) => {
        if (!alive) return;
        setBankWords(list);
        setBankStatus('ready');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setBankWords([]);
        setBankStatus('error');
        setBankError(err instanceof Error ? err.message : '词库加载失败');
      });
    return () => {
      alive = false;
    };
  }, [bankId, bankReload]);

  /** 切换词库：先同步把 UI 切到「加载中」，再让上面的 effect 发请求 */
  const changeBank = (id: string) => {
    setBankId(id);
    // 上一轮的结果 / 错题对照属于旧词库，切库后不该还挂在主区
    setPhase('idle');
    setQueue([]);
    setIndex(0);
    setAnswers([]);
    setFeedback(null);
    setPending(null);
    setInput('');
    setRevealed(false);
    setNotice('');
    // 短文按当前词库的薄弱词生成，切库后旧短文就失去依据了
    storyAbort.current?.abort();
    setStory(null);
    setAnalysis(null);
    setStoryPicks([]);
    setStoryId(null);
    setArchiveOpen(false);
    setRecite(false);
    setReciteAnswers(false);
    setStoryError('');
    setStoryNotice('');
    setStoryBusy(null);
    if (id === 'custom') {
      setBankError('');
      setBankStatus('ready');
      return;
    }
    setBankWords([]);
    setBankError('');
    setBankStatus('loading');
  };

  /** 切换模式 / 题量：结果页属于上一轮，换设置后回到准备态 */
  const changeMode = (id: DrillMode) => {
    setMode(id);
    if (phase === 'done') {
      setPhase('idle');
      setNotice('');
    }
  };

  const changeSize = (value: number) => {
    setSize(value);
    if (phase === 'done') {
      setPhase('idle');
      setNotice('');
    }
  };

  const words: readonly Word[] = bankId === 'custom' ? customWords : bankWords;
  const bank = WORD_BANKS.find((b) => b.id === bankId);
  const bankReady = bankId === 'custom' || bankStatus === 'ready';
  /** 抬头与侧栏统计只算**当前词库**，否则切库后数字和错词本对不上 */
  const summary = useMemo(() => bankSummary(words, records), [words, records]);
  const wrong = useMemo(() => wrongBook(words, records), [words, records]);
  const plan: DailyPlan = useMemo(() => dailyPlan(daily, newLimit, reviewLimit), [daily, newLimit, reviewLimit]);
  const series = useMemo(() => dailySeries(daily, 14), [daily]);
  const hits = useMemo(() => searchWords(words, lookupQuery), [words, lookupQuery]);
  /** 当前词库最不熟练的一批词：取词规则在 core，视图只负责展示与发起生成 */
  const weakPicks = useMemo(() => weakestWords(words, records), [words, records]);
  const current: Word | null = phase === 'run' ? (queue[index] ?? null) : null;
  /**
   * 听写 / 自测答题中收起右侧词表。
   *
   * 错词本默认就在侧栏，而「只练错词」练的正是里面列着的词：不收起的话，
   * 题目还没答，答案已经写在右边了。复制模式（跟打）本来就展示单词，不受影响。
   */
  const concealAnswers = phase === 'run' && !pending && mode !== 'copy';
  const activeMode = MODES.find((m) => m.id === mode) ?? DEFAULT_MODE;

  useEffect(() => {
    if (phase === 'run' && mode !== 'recall' && !pending) inputRef.current?.focus();
  }, [phase, index, mode, pending]);

  /** 听写模式：单词一出现就自动读一遍（用户仍可点「发音」重听）。
   *  不放在 copy 模式：看着拼写再读一遍意义不大，还会打断敲键节奏。 */
  useEffect(() => {
    if (phase !== 'run' || mode !== 'dictation' || pending || !current) return;
    speakWord(current.en);
  }, [phase, mode, pending, current]);

  /** 记一条结果：先算 next → 写 store + ref → 再 setState（副作用不进 updater） */
  const commit = (word: Word, ok: boolean) => {
    const key = normWord(word.en);
    const isNew = !recordsRef.current[key];
    const rec = nextRecord(recordsRef.current[key], word.en, ok);
    const next = { ...recordsRef.current, [key]: rec };
    recordsRef.current = next;
    saveRecords(next);
    setRecords(next);

    const nextDaily = recordDaily(dailyRef.current, { isNew, ok });
    dailyRef.current = nextDaily;
    saveDaily(nextDaily);
    setDaily(nextDaily);

    // 与生词本/学习流水联动：已在生词本的词，这次作答就是一次复习——按对错推进 FSRS
    // 并写入 studyLog（走 recordReview 的既有通道，报告页才能看到单词投入）；
    // 不在生词本的词答错时收进生词本。首次收录不当次评分：同一次作答不记两遍。
    const vKey = vocabCardKey(word.en);
    const entry = loadVocab().find((v) => vocabCardKey(v.term) === vKey);
    if (entry) {
      rateVocab(entry, ok ? 'good' : 'again');
      recordReview(ok ? 'good' : 'again');
    } else if (!ok) {
      addVocab(word.en, word.zh, 'wordDrill');
    }
  };

  /** 起一轮练习：任何来源（今日计划 / 错词 / 查词单练）都走这里 */
  const beginRun = (picked: Word[]): boolean => {
    if (!picked.length) return false;
    // 侧栏的「单练 / 只练这些词」也能在练习途中点：先确认，别把剩下的题悄悄丢掉
    if (phase === 'run' && answers.length > 0 && answers.length < queue.length) {
      if (!window.confirm('这一轮还没练完，开始新的练习会丢掉剩下的题。继续？')) return false;
    }
    startedAt.current = Date.now();
    setElapsedMs(0);
    setQueue(picked);
    setIndex(0);
    setAnswers([]);
    setFeedback(null);
    setPending(null);
    setInput('');
    setRevealed(false);
    setNotice('');
    setPhase('run');
    return true;
  };

  const start = (kind: QueueFilter | 'plan' = 'plan') => {
    const picked =
      kind === 'plan'
        ? pickDailyQueue(words, recordsRef.current, {
            newLimit,
            reviewLimit,
            daily: dailyRef.current,
          })
        : pickQueue(words, recordsRef.current, { limit: size, filter: kind });

    if (!picked.length) {
      setNotice(
        kind === 'wrong'
          ? '错词本是空的 —— 先跑一轮普通练习。'
          : '这个词库暂时没有可练的词。可以改用「全部重练」，或导入自己的词库。',
      );
      return;
    }
    // 每轮题量对「今日计划」也生效：否则下拉框写着 10，一点开始却冒出 30 个词
    beginRun(kind === 'plan' ? shuffle(picked).slice(0, size) : picked);
  };

  /** 推进到下一题：先算好下一个下标，再做状态更新（副作用不写进 updater） */
  const advance = useCallback(() => {
    const next = index + 1;
    setInput('');
    setRevealed(false);
    setPending(null);
    if (next >= queue.length) {
      setElapsedMs(startedAt.current ? Date.now() - startedAt.current : 0);
      setPhase('done');
      return;
    }
    setIndex(next);
  }, [index, queue.length]);

  /** 判错 → 停在当前词复盘（不推进） */
  const hold = (word: Word, verdict: Verdict, given: string) => {
    commit(word, false);
    setAnswers((list) => [...list, { word, ok: false }]);
    setPending({ verdict, given, word });
    setFeedback(null);
    playSound('wrong');
  };

  const answerRight = (word: Word) => {
    commit(word, true);
    setAnswers((list) => [...list, { word, ok: true }]);
    setFeedback({ verdict: 'right', word });
    playSound('right');
    advance();
  };

  const submit = () => {
    const word = current;
    if (!word) return;
    if (pending) {
      advance();
      return;
    }
    if (!input.trim()) return;
    const verdict = judge(input, word.en);
    if (verdict === 'right') {
      answerRight(word);
      return;
    }
    hold(word, verdict, input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // 中文输入法组词时按 Enter 是「上屏」，不是「提交答案」
    if (e.nativeEvent.isComposing || composing.current) return;
    e.preventDefault();
    submit();
  };

  const onChange = (value: string) => {
    // 只在「新增字符」时响：删改、输入法组词都不该有敲键声
    if (!composing.current && value.length > input.length) playSound('key');
    setInput(value);
  };

  /** 给首字母后把焦点送回输入框，并把光标放在末尾（否则用户还得再点一下输入框） */
  const giveHint = () => {
    if (!current) return;
    setInput(hintOf(current.en).slice(0, 1));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  /** 复盘态下按 Enter 继续：
   *  不挂 window keydown —— 那会把「提交时按下的同一个 Enter」也吃进来，
   *  复盘卡会一闪而过。改为让「继续」按钮 autoFocus，由浏览器原生回车激活。 */



  const importWords = () => {
    const textParsed = pendingFileWords ? null : parseWordList(importText);
    const parsed = pendingFileWords ?? textParsed?.words ?? [];
    const skipped = pendingFileWords ? filePreview?.skipped ?? 0 : textParsed?.skipped ?? 0;
    if (!parsed.length) {
      setNotice('没解析出词条。每行写成「单词 释义」，例如：anatomy 解剖学');
      return;
    }
    const merged = customWords.slice();
    const seen = new Set(merged.map((w) => normWord(w.en)));
    let added = 0;
    let duplicates = 0;
    for (const word of parsed) {
      const key = normWord(word.en);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      merged.push(word);
      added += 1;
    }
    setCustomWords(merged);
    saveCustomWords(merged);
    changeBank('custom');
    setImportText('');
    setPendingFileWords(null);
    setFilePreview(null);
    if (added === 0) {
      setNotice('没有新增：这些词已经在我的词库里。');
      return;
    }
    const detail = [
      duplicates > 0 ? `重复 ${duplicates} 条` : '',
      skipped > 0 ? `跳过 ${skipped} 行` : '',
    ].filter(Boolean).join('，');
    setNotice(`已导入 ${added} 条${detail ? `（${detail}）` : ''}。`);
  };

  /** 读词库文件：先预览条数/重复，确认后才写入，避免选错文件直接污染词库 */
  const readBankFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseWordBankFile(file.name, text);
      if (parsed.error) {
        setPendingFileWords(null);
        setFilePreview(null);
        setNotice(parsed.error);
        return;
      }
      if (!parsed.words.length) {
        setPendingFileWords(null);
        setFilePreview(null);
        setNotice('文件里没解析出词条：请确认是「单词 释义」逐行，或带 words 数组的 JSON。');
        return;
      }
      const existing = new Set(customWords.map((word) => normWord(word.en)));
      const duplicates = parsed.words.filter((word) => existing.has(normWord(word.en))).length;
      setImportText(parsed.words.map((word) => `${word.en} ${word.zh}`).join('\n'));
      setPendingFileWords(parsed.words);
      setFilePreview({
        name: file.name,
        total: parsed.words.length,
        duplicates,
        skipped: parsed.skipped,
      });
      setNotice(
        `已读取 ${file.name}：${parsed.words.length} 条${duplicates ? `，其中 ${duplicates} 条已存在` : ''}。确认后点「导入到我的词库」。`,
      );
    } catch {
      setPendingFileWords(null);
      setFilePreview(null);
      setNotice('读取文件失败：请换一个 UTF-8 编码的 .txt / .md / .csv / .json 文件。');
    }
  };

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
    if (next) playSound('right');
  };

  /** 两次请求共用的打字机状态：按字符数增量刷，避免每个 SSE chunk 都触发渲染 */
  const makeDeltaHandler = () => {
    const state = { chars: 0, shown: 0 };
    return (delta: string) => {
      state.chars += delta.length;
      if (state.chars - state.shown >= 60) {
        state.shown = state.chars;
        setStoryChars(state.chars);
      }
    };
  };

  /** 历史短文：state 与本地存储永远同一次写入，避免「界面有、刷新没」 */
  const commitArchive = (next: StoryArchiveEntry[]) => {
    archiveRef.current = next;
    setArchive(next);
    saveStoryArchive(next);
  };

  const rememberStory = (entry: StoryArchiveEntry) => {
    commitArchive(upsertStoryArchive(archiveRef.current, entry));
  };

  const forgetStory = (id: string) => {
    if (!window.confirm('删除这篇历史短文？短文与逐句精读会一起删除。')) return;
    commitArchive(removeStoryArchive(archiveRef.current, id));
    if (storyId === id) setStoryId(null);
  };

  const clearArchive = () => {
    if (!window.confirm('清空全部历史短文？练习记录与错词本不受影响。')) return;
    archiveRef.current = [];
    setArchive([]);
    clearStoryArchive();
    setStoryId(null);
    setArchiveOpen(false);
  };

  const toggleStoryPin = (entry: StoryArchiveEntry) => {
    commitArchive(upsertStoryArchive(archiveRef.current, { ...entry, pinned: entry.pinned !== true }));
    setStoryNotice(entry.pinned ? '已取消收藏。' : '已收藏：会排在历史最前，淘汰时优先保留。');
  };

  /** 当前短文存进知识库：目录固定「单词工坊」，同名直接覆盖（重复保存不会堆副本） */
  const saveStoryNote = async () => {
    if (!story || !onSaveNote || savingNote) return;
    setSavingNote(true);
    setStoryError('');
    try {
      const existing = storyId ? archiveRef.current.find((entry) => entry.id === storyId) : undefined;
      const createdAt = existing?.createdAt ?? Date.now();
      const title = storyFileName(story, createdAt).replace(/\.md$/i, '');
      const content = storyToMarkdownDocument(story, analysis, {
        createdAt,
        bankName: existing?.bankName ?? (bankId === 'custom' ? '我的词库' : bank?.name ?? ''),
        words: (existing?.words ?? storyPicks).map((pick) => pick.word),
      });
      const path = await onSaveNote('单词工坊', title, content);
      setStoryNotice(`已存为知识库笔记：${path}`);
    } catch {
      setStoryError('存为笔记失败：请确认知识库目录可写，或稍后重试。');
    } finally {
      setSavingNote(false);
    }
  };

  /** 一次模型请求 + 解析；失败时把「只输出 JSON」追加到最后一条消息再试一次 */
  const runJson = async <T,>(
    messages: WireMessage[],
    parse: (raw: string) => T | null,
    settings: AgentSettings,
    signal: AbortSignal,
  ): Promise<T> => {
    const ask = async (wire: WireMessage[]) => {
      const res = await runAgent({
        settings,
        messages: wire,
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 1,
        signal,
        onDelta: makeDeltaHandler(),
      });
      return parse(res.content);
    };
    const first = await ask(messages);
    if (first) return first;
    const last = messages[messages.length - 1];
    const lastText = 'content' in last && typeof last.content === 'string' ? last.content : '';
    const retry: WireMessage[] = [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: `${lastText}\n\n注意：上一次输出无法解析为约定 JSON。请只输出 JSON，不要代码围栏或解释。`,
      },
    ];
    const second = await ask(retry);
    if (second) return second;
    throw new Error('模型输出无法解析为约定 JSON，可重试或换一个指令跟随更好的模型。');
  };

  /** 精读按 6 句一批请求：长文不会被一次 JSON 输出截断，每批成功后就落盘 */
  const requestAnalysis = async (
    target: WordStory,
    settings: AgentSettings,
    signal: AbortSignal,
    onPartial?: (analysis: StoryAnalysis) => void,
  ): Promise<StoryAnalysis> => {
    const batches = analysisBatches(target);
    const collected: StoryLine[] = [];
    for (const batch of batches) {
      let parsed: StoryAnalysis;
      try {
        parsed = await runJson(buildAnalysisMessages(target, batch), parseAnalysis, settings, signal);
      } catch (e) {
        if (isAbortError(e)) throw e;
        throw new Error(
          `第 ${batch.start}–${batch.end} 句精读失败：${e instanceof Error ? e.message : '未知错误'}`,
        );
      }
      // 模型偶尔无视「沿用原编号」而从 1 重新数：整批都对不上时按本批顺序补编号
      const inRange = parsed.lines.filter(
        (line) => line.index >= batch.start && line.index <= batch.end,
      );
      const use = inRange.length
        ? inRange
        : parsed.lines.map((line, i) => ({ ...line, index: batch.start + i }));
      collected.push(...use);
      const merged: StoryAnalysis = {
        lines: [...new Map(collected.map((line) => [line.index, line])).values()].sort(
          (a, b) => a.index - b.index,
        ),
      };
      onPartial?.(merged);
    }
    return {
      lines: [...new Map(collected.map((line) => [line.index, line])).values()].sort(
        (a, b) => a.index - b.index,
      ),
    };
  };

  /** 回看历史：直接换上当时保存的短文、精读与取词快照 */
  const openArchived = (entry: StoryArchiveEntry) => {
    storyAbort.current?.abort();
    setStoryBusy(null);
    setStory(entry.story);
    setAnalysis(entry.analysis);
    setStoryPicks(entry.words);
    setRecite(false);
    setReciteAnswers(false);
    setStoryId(entry.id);
    setStoryError('');
    setStoryNotice('');
    setArchiveOpen(false);
    requestAnimationFrame(() => {
      const el = mainRef.current;
      if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0 });
    });
  };

  /** 只生成逐句精读：短文成功后精读失败时可单独重试，不重写短文 */
  const generateAnalysis = async (target: WordStory) => {
    const settings = loadAgentSettings();
    if (!settings) {
      setStoryError('还没配置 AI：先到「AI 助手 → 设置」填接口地址、密钥与模型名，保存后再回来。');
      return;
    }
    storyAbort.current?.abort();
    const ctrl = new AbortController();
    storyAbort.current = ctrl;
    setStoryBusy('analysis');
    setStoryError('');
    setStoryChars(0);
    const existing = storyId ? archiveRef.current.find((entry) => entry.id === storyId) : undefined;
    const createdAt = existing?.createdAt ?? Date.now();
    const entryId = existing?.id ?? newStoryId(createdAt);
    const bankName = bankId === 'custom' ? '我的词库' : bank?.name ?? '';
    try {
      const parsed = await requestAnalysis(target, settings, ctrl.signal, (partial) => {
        setAnalysis(partial);
        rememberStory(
          makeStoryArchiveEntry({
            id: entryId,
            createdAt,
            bankName,
            words: existing?.words.length ? existing.words : storyPicks,
            story: target,
            analysis: partial,
            pinned: existing?.pinned === true,
          }),
        );
      });
      setStory(target);
      setAnalysis(parsed);
      rememberStory(
        makeStoryArchiveEntry({
          id: entryId,
          createdAt,
          bankName,
          words: existing?.words.length ? existing.words : storyPicks,
          story: target,
          analysis: parsed,
          pinned: existing?.pinned === true,
        }),
      );
      setStoryId(entryId);
    } catch (e) {
      if (isAbortError(e)) return;
      setStory(target);
      setStoryError(e instanceof Error ? agentNetHint(e) : '精读生成失败，请重试。');
    } finally {
      if (storyAbort.current === ctrl) storyAbort.current = null;
      setStoryBusy(null);
    }
  };

  /** 主流程：先取当前最弱的一批词写短文，再让同一份短文进入逐句精读 */
  const generateStory = async () => {
    const settings = loadAgentSettings();
    if (!settings) {
      setStoryError('还没配置 AI：先到「AI 助手 → 设置」填接口地址、密钥与模型名，保存后再回来。');
      return;
    }
    const fresh = weakestWords(words, records);
    if (!fresh.length) {
      setStoryError('还没有练习记录：先在工坊练一轮，再按错次、遗忘程度和难度挑出最不熟练的词。');
      return;
    }
    storyAbort.current?.abort();
    const ctrl = new AbortController();
    storyAbort.current = ctrl;
    const bankName = bankId === 'custom' ? '我的词库' : bank?.name ?? '';
    const createdAt = Date.now();
    const entryId = newStoryId(createdAt);
    setStoryPicks(fresh);
    setRecite(false);
    setReciteAnswers(false);
    setStory(null);
    setAnalysis(null);
    setStoryId(null);
    setArchiveOpen(false);
    setStoryError('');
    setStoryNotice('');
    setStoryBusy('story');
    setStoryChars(0);
    try {
      const parsed = await runJson(
        buildStoryMessages(fresh.map((p) => p.word), bankName),
        parseStory,
        settings,
        ctrl.signal,
      );
      setStory(parsed);
      setStoryId(entryId);
      // 短文先落盘：即使第二步精读失败，用户回看时也不会只剩一段空白
      const baseEntry = makeStoryArchiveEntry({
        id: entryId,
        createdAt,
        bankName,
        words: fresh,
        story: parsed,
        analysis: null,
      });
      rememberStory(baseEntry);
      setStoryBusy('analysis');
      setStoryChars(0);
      const parsedAnalysis = await requestAnalysis(parsed, settings, ctrl.signal, (partial) => {
        setAnalysis(partial);
        rememberStory({ ...baseEntry, analysis: partial });
      });
      setAnalysis(parsedAnalysis);
      rememberStory({ ...baseEntry, analysis: parsedAnalysis });
    } catch (e) {
      if (isAbortError(e)) return;
      setStoryError(
        e instanceof Error
          ? agentNetHint(e)
          : '生成失败，请重试。',
      );
    } finally {
      if (storyAbort.current === ctrl) storyAbort.current = null;
      setStoryBusy(null);
    }
  };

  const copyStory = async () => {
    if (!story) return;
    try {
      await navigator.clipboard.writeText(storyToMarkdown(story, analysis));
      setStoryNotice('已复制短文与逐句精读。');
    } catch {
      setStoryNotice('复制失败：浏览器没有开放剪贴板权限，可手动选中文本复制。');
    }
  };

  /** 导出当前短文：优先用历史里的生成时间与词库名，保证文件名和 frontmatter 一致 */
  const exportStory = () => {
    if (!story) return;
    const existing = storyId ? archiveRef.current.find((entry) => entry.id === storyId) : undefined;
    const createdAt = existing?.createdAt ?? Date.now();
    const name = storyFileName(story, createdAt);
    downloadTextFile(
      name,
      storyToMarkdownDocument(story, analysis, {
        createdAt,
        bankName: existing?.bankName ?? (bankId === 'custom' ? '我的词库' : bank?.name ?? ''),
        words: (existing?.words ?? storyPicks).map((pick) => pick.word),
      }),
      'text/markdown;charset=utf-8',
    );
    setStoryNotice(`已导出 ${name}`);
  };

  const exportArchiveEntry = (entry: StoryArchiveEntry) => {
    const name = storyFileName(entry.story, entry.createdAt);
    downloadTextFile(
      name,
      storyToMarkdownDocument(entry.story, entry.analysis, {
        createdAt: entry.createdAt,
        bankName: entry.bankName,
        words: entry.words.map((pick) => pick.word),
      }),
      'text/markdown;charset=utf-8',
    );
    setStoryNotice(`已导出《${entry.story.title}》`);
  };

  const exportAllArchive = () => {
    if (!archive.length) return;
    const name = archiveFileName();
    downloadTextFile(name, storyArchiveToMarkdown(archive), 'text/markdown;charset=utf-8');
    setStoryNotice(`已导出全部 ${archive.length} 篇历史短文`);
  };

  /** 自定义词库入口：不切库，先把导入区打开并聚焦，避免打断当前词库的练习状态 */
  const openCustomBank = () => {
    if (phase === 'run' || storyBusy) return;
    if (bankId !== 'custom') changeBank('custom');
    setStoryOpen(false);
    setAsideTab('bank');
    setNotice('');
    setFocusImportKey((n) => n + 1);
  };

  const speakStory = () => {
    if (!story) return;
    if (!speakText(story.sentences.map((sentence) => sentence.en).join(' '))) {
      setStoryNotice('当前环境不支持语音朗读，可先复制文本到系统朗读工具。');
    }
  };

  const storyTargets = storyPicks.length ? storyPicks : weakPicks;
  const storyForms = useMemo(
    () => (story ? storySurfaceForms(story, storyTargets.map((pick) => pick.word)) : []),
    [story, storyTargets],
  );
  const storyMissing = useMemo(
    () => (story ? storyCoverage(story, storyTargets.map((pick) => pick.word)).missing : []),
    [story, storyTargets],
  );
  const visibleArchive = useMemo(() => {
    const query = archiveQuery.trim().toLowerCase();
    return archive.filter((entry) => {
      if (archivePinnedOnly && !entry.pinned) return false;
      if (!query) return true;
      return (
        entry.story.title.toLowerCase().includes(query)
        || entry.bankName.toLowerCase().includes(query)
        || entry.words.some((pick) => pick.word.en.toLowerCase().includes(query))
      );
    });
  }, [archive, archivePinnedOnly, archiveQuery]);

  const correctCount = answers.filter((a) => a.ok).length;
  const wrongAnswers = answers.filter((a) => !a.ok);
  const diff = pending ? diffChars(pending.given, pending.word.en) : null;

  return (
    <PanelOverlay tone="quiz" onClose={requestClose}>
      <div className="panel panel--full wd-panel" aria-label="单词工坊">
        <div className="panel__head wd-head">
          <h2 className="panel__title">单词工坊</h2>
          <span className="wd-head__meta">
            {bankId === 'custom' ? '我的词库' : bankStatus === 'ready' ? bank?.name : '词库加载中'} ·{' '}
            {words.length} 词 · 已掌握 {summary.mastered}
          </span>
          <button
            className="btn btn-small"
            type="button"
            aria-pressed={sound}
            title={sound ? '键盘音效：开' : '键盘音效：关'}
            onClick={toggleSound}
          >
            {sound ? '🔊 音效' : '🔇 静音'}
          </button>
          <button className="btn btn-small" type="button" onClick={requestClose}>
            关闭
          </button>
        </div>

        <div className={`wd-body${storyOpen ? ' wd-body--story' : ''}`}>
          <section className="wd-main" ref={mainRef}>
            <div className="wd-toolbar">
              <div className="wd-seg" role="group" aria-label="练习模式">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={m.id === mode ? 'is-on' : ''}
                    aria-pressed={m.id === mode}
                    title={m.tip}
                    onClick={() => changeMode(m.id)}
                    disabled={phase === 'run'}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <select
                className="wd-select"
                aria-label="词库"
                value={bankId}
                disabled={phase === 'run'}
                onChange={(e) => changeBank(e.target.value)}
              >
                {WORD_BANKS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}（{b.count}）
                  </option>
                ))}
                <option value="custom">我的词库（{customWords.length}）</option>
              </select>

              <button
                className="btn btn-small"
                type="button"
                title="粘贴自己的词表，导入后可切到「我的词库」练习"
                disabled={phase === 'run'}
                onClick={openCustomBank}
              >
                ＋ 自定义词库
              </button>

              <select
                className="wd-select"
                aria-label="每轮题量"
                value={size}
                disabled={phase === 'run'}
                onChange={(e) => changeSize(Number(e.target.value))}
              >
                {DRILL_SIZES.map((n) => (
                  <option key={n} value={n}>
                    每轮 {n} 词
                  </option>
                ))}
              </select>

              <button
                className="btn btn-primary"
                type="button"
                onClick={() => start('plan')}
                disabled={phase === 'run' || !bankReady}
              >
                {phase === 'idle' ? '开始练习' : '再练一轮'}
              </button>

              <button
                className="btn"
                type="button"
                aria-pressed={storyOpen}
                title="用当前词库最不熟练的约 20% 单词写一篇短文，并逐句拆搭配"
                disabled={phase === 'run' || !bankReady}
                onClick={() => {
                  const next = !storyOpen;
                  setStoryOpen(next);
                  setStoryError('');
                  setStoryNotice('');
                  // 从长结果页切进来时，主区可能还停在下方；回到顶部才看得到取词说明
                  if (next) {
                    requestAnimationFrame(() => {
                      const el = mainRef.current;
                      if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0 });
                    });
                  }
                }}
              >
                {storyOpen ? '返回练习' : '薄弱词成文'}
              </button>
            </div>

            {notice && <div className="wd-notice">{notice}</div>}
            {bankId !== 'custom' && bankStatus === 'error' && (
              <div className="wd-notice wd-notice--row">
                <span>词库加载失败：{bankError}（可切到「我的词库」或重试）</span>
                <button
                  className="btn btn-small"
                  type="button"
                  onClick={() => {
                    setBankError('');
                    setBankStatus('loading');
                    setBankReload((n) => n + 1);
                  }}
                >
                  重试
                </button>
              </div>
            )}

            {storyOpen && (
              <div className="wd-card wd-story">
                <div className="wd-story__head">
                  <div>
                    <div className="wd-idle__title">薄弱词成文</div>
                    <p className="wd-story__intro">
                      按错次、遗忘次数与 FSRS 难度排序，取当前词库最不熟练的约 20%，并控制在 8–20
                      个（练过的词不足 8 个则全取）。先写一篇 140–200 词的短文，再逐句拆值得背的固定搭配与高分词组；
                      生成结果会自动存到本机，最多保留 {STORY_ARCHIVE_LIMIT} 篇。
                    </p>
                  </div>
                  <button
                    className="btn btn-small"
                    type="button"
                    aria-expanded={archiveOpen}
                    onClick={() => setArchiveOpen((open) => !open)}
                  >
                    {archiveOpen ? '收起历史' : archive.length ? `历史短文（${archive.length}）` : '历史短文'}
                  </button>
                </div>

                {archiveOpen && (
                  <div className="wd-story__archive">
                    <div className="wd-story__archive-head">
                      <span>收藏优先，其余按生成时间倒序（最多 {STORY_ARCHIVE_LIMIT} 篇）</span>
                      {archive.length > 0 && (
                        <div className="wd-actions">
                          <button className="btn btn-small" type="button" onClick={exportAllArchive}>
                            导出全部
                          </button>
                          <button className="btn btn-small" type="button" onClick={clearArchive}>
                            清空
                          </button>
                        </div>
                      )}
                    </div>
                    {archive.length > 0 && (
                      <div className="wd-story__archive-tools">
                        <input
                          className="wd-archive__search"
                          value={archiveQuery}
                          spellCheck={false}
                          aria-label="搜索历史短文"
                          placeholder="搜标题 / 词库 / 目标词"
                          onChange={(e) => setArchiveQuery(e.target.value)}
                        />
                        <button
                          className={`btn btn-small${archivePinnedOnly ? ' is-on' : ''}`}
                          type="button"
                          aria-pressed={archivePinnedOnly}
                          onClick={() => setArchivePinnedOnly((value) => !value)}
                        >
                          只看收藏
                        </button>
                      </div>
                    )}
                    {archive.length === 0 ? (
                      <p className="wd-empty">还没有历史短文。生成一篇后会自动存在这里，关掉面板也不会丢。</p>
                    ) : visibleArchive.length === 0 ? (
                      <p className="wd-empty">没有匹配的历史短文。清空搜索或取消「只看收藏」再试。</p>
                    ) : (
                      <div className="wd-story__archive-list">
                        {visibleArchive.map((entry) => (
                          <div className={`wd-archive${entry.id === storyId ? ' is-on' : ''}`} key={entry.id}>
                            <button
                              className="wd-archive__open"
                              type="button"
                              onClick={() => openArchived(entry)}
                            >
                              <b>
                                {entry.pinned ? '★ ' : ''}
                                {entry.story.title}
                              </b>
                              <span>
                                {fmtStoryTime(entry.createdAt)} · {entry.bankName || '单词工坊'} · {entry.words.length} 词
                                {entry.analysis ? ` · ${entry.analysis.lines.length} 句精读` : ' · 精读待生成'}
                              </span>
                            </button>
                            <button
                              className={`wd-archive__act${entry.pinned ? ' is-on' : ''}`}
                              type="button"
                              aria-label={`${entry.pinned ? '取消收藏' : '收藏'}：${entry.story.title}`}
                              aria-pressed={entry.pinned === true}
                              title={entry.pinned ? '取消收藏' : '收藏并置顶'}
                              onClick={() => toggleStoryPin(entry)}
                            >
                              {entry.pinned ? '★' : '☆'}
                            </button>
                            <button
                              className="wd-archive__act"
                              type="button"
                              aria-label={`导出历史：${entry.story.title}`}
                              title="导出这份短文"
                              onClick={() => exportArchiveEntry(entry)}
                            >
                              导出
                            </button>
                            <button
                              className="wd-archive__x"
                              type="button"
                              aria-label={`删除历史：${entry.story.title}`}
                              title="删除这篇历史短文"
                              onClick={() => forgetStory(entry.id)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {storyTargets.length === 0 ? (
                  <p className="wd-empty">
                    还没有练习记录：先在工坊练一轮。取词只看「练过的词」，没学过的词不算薄弱词。
                  </p>
                ) : (
                  <>
                    {recite && !reciteAnswers ? (
                      <p className="wd-empty">
                        背诵模式：{storyTargets.length} 个目标词已收起，点「显示答案」恢复词表与精读。
                      </p>
                    ) : (
                      <div className="wd-story__picks">
                        <div className="wd-story__picks-head">
                          <span>本次目标词 {storyTargets.length} 个 · 序号越小越不熟</span>
                          <em>按错次 / 遗忘次数 / 难度排序</em>
                        </div>
                        <div className="wd-story__chips">
                          {storyTargets.map((pick, i) => (
                            <span
                              className="wd-chip"
                              key={pick.word.en}
                              title={`错 ${pick.record.wrong} 次 · 遗忘 ${pick.record.lapses} 次 · 难度 ${pick.record.difficulty.toFixed(1)}`}
                            >
                              <b>{i + 1}</b>
                              <span className="wd-chip__en">{pick.word.en}</span>
                              <i title={pick.word.zh}>{shortGloss(pick.word.zh)}</i>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="wd-actions wd-actions--story">
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={!!storyBusy}
                        onClick={() => void generateStory()}
                      >
                        {story ? '换一篇' : '生成短文'}
                      </button>
                      {story && (
                        <button className="btn" type="button" onClick={() => void copyStory()}>
                          复制全文
                        </button>
                      )}
                      {story && (
                        <button className="btn" type="button" onClick={exportStory}>
                          导出 .md
                        </button>
                      )}
                      {story && onSaveNote && (
                        <button
                          className="btn"
                          type="button"
                          disabled={savingNote || !!storyBusy}
                          onClick={() => void saveStoryNote()}
                        >
                          {savingNote ? '保存中…' : '存为笔记'}
                        </button>
                      )}
                    </div>
                  </>
                )}

                {!aiReady && storyTargets.length > 0 && (
                  <div className="wd-notice">
                    还没配置 AI：先到「AI 助手 → 设置」填接口地址、密钥与模型名，再回来生成。
                  </div>
                )}

                {storyBusy && (
                  <div className="wd-story__status" role="status">                    <i aria-hidden="true" />
                    {storyBusy === 'story'
                      ? '正在写短文：先保证句子地道，再照顾目标词'
                      : '正在逐句拆解固定搭配与高分词组'}
                    {storyChars > 0 ? ` · 已收到 ${storyChars} 字` : ''}
                  </div>
                )}

                {storyError && (
                  <div className="wd-notice wd-notice--row">
                    <span>{storyError}</span>
                    {story && (!analysis || analysis.lines.length < story.sentences.length) && (
                      <button
                        className="btn btn-small"
                        type="button"
                        disabled={!!storyBusy}
                        onClick={() => void generateAnalysis(story)}
                      >
                        重试精读
                      </button>
                    )}
                  </div>
                )}
                {storyNotice && <div className="wd-notice wd-story__notice">{storyNotice}</div>}

                {story && storyMissing.length > 0 && (
                  <div className="wd-notice wd-story__coverage">
                    有 {storyMissing.length} 个目标词未在原文中检出：
                    {storyMissing.slice(0, 6).map((word) => word.en).join('、')}
                    {storyMissing.length > 6 ? ' 等' : ''}。可换一篇，或人工确认是否用了不规则形态。
                  </div>
                )}

                {story && (
                  <div className="wd-story__studybar">
                    <button
                      className={`btn btn-small${recite ? ' is-on' : ''}`}
                      type="button"
                      aria-pressed={recite}
                      onClick={() => {
                        setRecite((value) => !value);
                        setReciteAnswers(false);
                      }}
                    >
                      {recite ? '退出背诵' : '背诵模式'}
                    </button>
                    {recite && (
                      <>
                        <button
                          className="btn btn-small"
                          type="button"
                          aria-pressed={reciteAnswers}
                          onClick={() => setReciteAnswers((value) => !value)}
                        >
                          {reciteAnswers ? '隐藏答案' : '显示答案'}
                        </button>
                        <button className="btn btn-small" type="button" onClick={speakStory}>
                          朗读短文
                        </button>
                        <span className="wd-story__studyhint">
                          {reciteAnswers ? '答案已展开' : '目标词已挖空，词表、译文与精读已隐藏'}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {story && (
                  <article className="wd-story__paper">
                    <h3 className="wd-story__title">{story.title}</h3>
                    {story.titleZh && <div className="wd-story__titlezh">{story.titleZh}</div>}
                    <p className="wd-story__text">
                      {story.sentences.map((sentence, i) => (
                        <span key={`${i}-${sentence.en}`}>
                          {recite && !reciteAnswers
                            ? maskedTargets(sentence.en, storyForms)
                            : highlightTargets(
                                sentence.en,
                                storyTargets.map((pick) => pick.word),
                                storyForms,
                              )}{' '}
                        </span>
                      ))}
                    </p>
                  </article>
                )}

                {story && recite && !reciteAnswers && (
                  <div className="wd-studyhint">
                    背诵模式：先自己回忆目标词与句意，点「显示答案」查看译文与逐句精读。
                  </div>
                )}

                {story && (!recite || reciteAnswers) && (
                  <section className="wd-story__analysis">
                    <div className="wd-story__analysis-head">
                      <h4>逐句精读</h4>
                      <span>
                        {analysis
                          ? `已拆 ${analysis.lines.length} 句`
                          : storyBusy === 'analysis'
                            ? '生成中…'
                            : '尚未生成'}
                      </span>
                    </div>
                    {analysis ? (
                      story.sentences.map((sentence, i) => {
                        const line = analysis.lines.find((item) => item.index === i + 1);
                        return (
                          <div className="wd-sent" key={`${i}-${sentence.en}`}>
                            <div className="wd-sent__no">{i + 1}</div>
                            <div className="wd-sent__body">
                              <p className="wd-sent__en">
                                {highlightTargets(
                                  sentence.en,
                                  storyTargets.map((pick) => pick.word),
                                  storyForms,
                                )}
                              </p>
                              {sentence.zh && <p className="wd-sent__zh">{sentence.zh}</p>}
                              {line?.grammar && <div className="wd-sent__grammar">句型 · {line.grammar}</div>}
                              {line?.points.length ? (
                                <ul className="wd-sent__points">
                                  {line.points.map((point, j) => (
                                    <li key={`${point.phrase}-${j}`}>
                                      <code>{point.phrase}</code>
                                      <span className="wd-sent__kind">{point.kind}</span>
                                      {point.zh && <span className="wd-sent__pointzh">{point.zh}</span>}
                                      {point.tip && <em>{point.tip}</em>}
                                    </li>
                                  ))}
                                </ul>
                              ) : !line ? (
                                <p className="wd-sent__plain">这一句以推进叙述为主，没有额外搭配要拆。</p>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="wd-story__analysis-empty">
                        <p className="wd-empty">
                          {storyBusy === 'analysis'
                            ? '短文已出，正在逐句拆搭配…'
                            : '这篇短文还没有精读结果，可以重试一次；短文本身不会重新生成。'}
                        </p>
                        {storyBusy !== 'analysis' && (
                          <button
                            className="btn btn-small"
                            type="button"
                            disabled={!!storyBusy}
                            onClick={() => void generateAnalysis(story)}
                          >
                            重试精读
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}

            {!storyOpen && phase === 'idle' && (
              <div className="wd-card wd-idle">
                <div className="wd-idle__title">选好模式，敲一轮</div>
                <p className="wd-idle__tip">{activeMode.tip}</p>
                <ul className="wd-idle__list">
                  <li>打错会停在原地，逐字对照你打的与正确写法，按 Enter 再继续。</li>
                  <li>
                    排期按 FSRS 思路：记住的间隔按稳定性拉长，忘了就回落重来；连续答对 5 次算掌握。
                  </li>
                  <li>
                    今天还剩 {plan.remainingNew} 个新词、{plan.remainingReview} 个到期复习；配额用完仍可「全部重练」。
                  </li>
                  <li>
                    当前词库：
                    {bankId === 'custom'
                      ? `我的词库 ${customWords.length} 词`
                      : `${bank?.name ?? ''} · ${words.length} 词（含音标 / 例句 / 词源）`}。
                  </li>
                </ul>
                <div className="wd-idle__actions">
                  <button className="btn" type="button" onClick={() => start('all')}>
                    全部重练
                  </button>
                  {wrong.length > 0 && (
                    <button className="btn" type="button" onClick={() => start('wrong')}>
                      只练错词（{wrong.length}）
                    </button>
                  )}
                </div>
              </div>
            )}

            {!storyOpen && phase === 'run' && current && (
              <div className="wd-card wd-card--run">
                <div className="wd-progress">
                  <span>
                    {index + 1} / {queue.length}
                  </span>
                  <div className="wd-dots" aria-hidden="true">
                    {queue.map((word, i) => (
                      <i
                        key={`${word.en}-${i}`}
                        className={
                          i < answers.length
                            ? answers[i]?.ok
                              ? 'is-ok'
                              : 'is-bad'
                            : i === index
                              ? 'is-now'
                              : ''
                        }
                      />
                    ))}
                  </div>
                  <span className="wd-progress__mode">{activeMode.label}</span>
                </div>

                {feedback && (
                  <div className={`wd-feedback is-${feedback.verdict}`}>
                    <b>{VERDICT_TEXT[feedback.verdict]}</b>
                    <span>
                      {feedback.word.en} · {feedback.word.zh}
                    </span>
                  </div>
                )}

                {/* 复盘态：停在当前词，逐字符对照，按 Enter 继续 */}
                {pending ? (
                  <div className="wd-review">
                    <div className="wd-review__head">
                      <span className={`wd-review__tag is-${pending.verdict}`}>
                        {VERDICT_TEXT[pending.verdict]}
                      </span>
                      <span className="wd-review__hint">按 Enter 继续</span>
                    </div>

                    <div className="wd-diff">
                      {mode !== 'recall' && (
                        <>
                          <div className="wd-diff__line">
                            <span className="wd-diff__label">你打的</span>
                            <span className="wd-diff__code">
                              {diff && diff.input.length > 0 ? (
                                diff.input.map((cell, i) => (
                                  <em key={i} className={cell.state === 'bad' ? 'is-bad' : ''}>
                                    {cell.ch}
                                  </em>
                                ))
                              ) : (
                                <i className="wd-diff__empty">（没打）</i>
                              )}
                            </span>
                          </div>
                          <div className="wd-diff__line">
                            <span className="wd-diff__label">正确</span>
                            <span className="wd-diff__code">
                              {diff?.target.map((cell, i) => (
                                <em key={i} className={cell.state === 'bad' ? 'is-missing' : ''}>
                                  {cell.ch}
                                </em>
                              ))}
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    <div className="wd-wordcard">
                      <div className="wd-wordcard__word">{pending.word.en}</div>
                      {pending.word.ipa && <div className="wd-ipa">{pending.word.ipa}</div>}
                      <div className="wd-wordcard__zh">{pending.word.zh}</div>
                      {pending.word.example && (
                        <p className="wd-example">{pending.word.example}</p>
                      )}
                      {pending.word.origin && <div className="wd-root">词源 · {pending.word.origin}</div>}
                    </div>

                    <div className="wd-actions">
                      <button
                        className="btn btn-primary"
                        type="button"
                        autoFocus
                        onClick={advance}
                        onKeyDown={(e) => {
                          // 显式接 Enter：部分环境下按钮的原生回车激活不稳定；
                          // preventDefault 同时避免真浏览器里「onKeyDown + 原生 click」各推进一次
                          if (e.key !== 'Enter' || e.repeat) return;
                          e.preventDefault();
                          advance();
                        }}
                      >
                        继续（Enter）
                      </button>
                      <button className="btn" type="button" onClick={() => speakWord(pending.word.en)}>
                        🔊 听一遍
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="wd-prompt">
                    {mode === 'copy' && (
                      <>
                        <div className="wd-word">{current.en}</div>
                        {current.ipa && <div className="wd-ipa">{current.ipa}</div>}
                        <div className="wd-zh">{current.zh}</div>
                        {current.example && <p className="wd-example wd-example--muted">{current.example}</p>}
                      </>
                    )}
                    {mode === 'dictation' && (
                      <>
                        <div className="wd-zh wd-zh--big">{current.zh}</div>
                        {current.example && <p className="wd-example">{maskWord(current.example, current.en)}</p>}
                        <div className="wd-actions">
                          <button className="btn btn-small" type="button" onClick={() => speakWord(current.en)}>
                            🔊 发音
                          </button>
                          <button
                            className="btn btn-small"
                            type="button"
                            onClick={giveHint}
                          >
                            给首字母
                          </button>
                        </div>
                      </>
                    )}
                    {mode === 'recall' && (
                      <>
                        <div className="wd-zh wd-zh--big">{current.zh}</div>
                        {revealed ? (
                          <>
                            <div className="wd-word wd-word--answer">{current.en}</div>
                            {current.ipa && <div className="wd-ipa">{current.ipa}</div>}
                            {current.example && <p className="wd-example">{current.example}</p>}
                            {current.origin && <div className="wd-root">词源 · {current.origin}</div>}
                            <div className="wd-actions">
                              <button className="btn btn-primary" type="button" onClick={() => answerRight(current)}>
                                记得
                              </button>
                              <button
                                className="btn"
                                type="button"
                                onClick={() => hold(current, 'wrong', '')}
                              >
                                忘了
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="wd-actions">
                            <button className="btn btn-primary" type="button" onClick={() => setRevealed(true)}>
                              显示答案
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {!pending && mode !== 'recall' && (
                  <>
                    <input
                      ref={inputRef}
                      className="wd-input"
                      value={input}
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      maxLength={64}
                      placeholder="输入英文后回车"
                      aria-label="拼写输入"
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={onKeyDown}
                      onCompositionStart={() => { composing.current = true; }}
                      onCompositionEnd={() => { composing.current = false; }}
                    />
                    <div className="wd-actions">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={submit}
                        disabled={!input.trim()}
                      >
                        提交（Enter）
                      </button>
                      <button className="btn" type="button" onClick={() => hold(current, 'wrong', input)}>
                        不会，看答案
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {!storyOpen && phase === 'done' && (
              <div className="wd-card wd-result">
                <div className="wd-result__score">
                  {correctCount}
                  <span> / {answers.length}</span>
                </div>
                <div className="wd-result__meta">
                  正确率 {answers.length ? Math.round((correctCount / answers.length) * 100) : 0}% · 用时{' '}
                  {fmtElapsed(elapsedMs)}
                </div>
                {wrongAnswers.length > 0 && (
                  <div className="wd-result__list">
                    {wrongAnswers.map((a) => (
                      <div key={a.word.en} className="wd-row">
                        <b>{a.word.en}</b>
                        <span>{a.word.zh}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="wd-actions">
                  <button className="btn btn-primary" type="button" onClick={() => start('plan')}>
                    再练一轮
                  </button>
                  {wrongAnswers.length > 0 && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => beginRun(wrongAnswers.map((a) => a.word))}
                    >
                      只练本轮错词（{wrongAnswers.length}）
                    </button>
                  )}
                  <button className="btn" type="button" onClick={() => beginRun(queue)}>
                    重练本轮
                  </button>
                  <button className="btn" type="button" onClick={() => start('all')}>
                    全部重练
                  </button>
                </div>
              </div>
            )}
          </section>

          <aside className="wd-side">
            <div className="wd-today">
              <div className="wd-today__head">
                <span>今日</span>
                <span className="wd-today__rate">
                  {plan.done.total > 0 ? Math.round((plan.done.correct / plan.done.total) * 100) : 0}% 正确
                </span>
              </div>
              <div className="wd-today__bars">
                <div className="wd-today__bar">
                  <span>新词</span>
                  <i>
                    <b style={{ width: `${Math.min(100, (plan.done.newWords / Math.max(1, plan.newLimit)) * 100)}%` }} />
                  </i>
                  <em>
                    {plan.done.newWords}/{plan.newLimit}
                  </em>
                </div>
                <div className="wd-today__bar">
                  <span>复习</span>
                  <i>
                    <b
                      style={{ width: `${Math.min(100, (plan.done.reviews / Math.max(1, plan.reviewLimit)) * 100)}%` }}
                    />
                  </i>
                  <em>
                    {plan.done.reviews}/{plan.reviewLimit}
                  </em>
                </div>
              </div>
              <div className="wd-today__limits">
                <label>
                  新词上限
                  <input
                    type="number"
                    min={1}
                    max={NEW_LIMIT_MAX}
                    value={newLimit}
                    disabled={phase === 'run'}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setNewLimit(Number.isFinite(n) ? Math.min(NEW_LIMIT_MAX, Math.max(1, Math.round(n))) : 1);
                    }}
                  />
                </label>
                <label>
                  复习上限
                  <input
                    type="number"
                    min={1}
                    max={REVIEW_LIMIT_MAX}
                    value={reviewLimit}
                    disabled={phase === 'run'}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setReviewLimit(Number.isFinite(n) ? Math.min(REVIEW_LIMIT_MAX, Math.max(1, Math.round(n))) : 1);
                    }}
                  />
                </label>
              </div>
              <Sparkline series={series} />
              <div className="wd-today__foot">最近 14 天正确率</div>
            </div>

            <div className="wd-stats">
              <div className="wd-stat">
                <b>{summary.tracked}</b>
                <span>练过的词</span>
              </div>
              <div className="wd-stat">
                <b>{summary.mastered}</b>
                <span>已掌握</span>
              </div>
              <div className="wd-stat">
                <b>{summary.dueNow}</b>
                <span>待复习</span>
              </div>
            </div>

            {concealAnswers ? (
              <div className="wd-side__body">
                <p className="wd-empty">
                  听写 / 自测进行中：词表暂时收起，避免在错词本或我的词库里看到当前词的拼写。答完本题后恢复。
                </p>
              </div>
            ) : (
              <>
            <div className="wd-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={asideTab === 'wrong'}
                className={asideTab === 'wrong' ? 'is-on' : ''}
                onClick={() => setAsideTab('wrong')}
              >
                错词本 {wrong.length > 0 ? `(${wrong.length})` : ''}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={asideTab === 'bank'}
                className={asideTab === 'bank' ? 'is-on' : ''}
                onClick={() => setAsideTab('bank')}
              >
                我的词库 {customWords.length > 0 ? `(${customWords.length})` : ''}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={asideTab === 'lookup'}
                className={asideTab === 'lookup' ? 'is-on' : ''}
                onClick={() => setAsideTab('lookup')}
              >
                查词
              </button>
            </div>

            {asideTab === 'wrong' && (
              <div className="wd-side__body">
                {wrong.length === 0 ? (
                  <p className="wd-empty">还没有错词。答错的词会自动落在这里（只统计当前词库）。</p>
                ) : (
                  <>
                    <button className="btn btn-small" type="button" onClick={() => start('wrong')}>
                      只练这些词
                    </button>
                    {wrong.map((word) => {
                      const rec = records[normWord(word.en)];
                      return (
                        <div key={word.en} className="wd-row wd-row--wrong">
                          <b>{word.en}</b>
                          <span>{word.zh}</span>
                          {rec && <em>错 {rec.wrong}</em>}
                          <button
                            className="btn btn-small"
                            type="button"
                            title="只练这一个词"
                            onClick={() => beginRun([word])}
                          >
                            练
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {asideTab === 'bank' && (
              <div className="wd-side__body">
                <p className="wd-empty">
                  每行一条：<code>word 释义</code>。支持空格 / 制表符 / 逗号 / <code>=</code> 分隔，重复词自动去重。
                  也可以选择 <code>.txt</code> / <code>.md</code> / <code>.csv</code> / <code>.json</code> 文件，先预览再导入。
                </p>
                <input
                  ref={fileRef}
                  className="wd-file"
                  type="file"
                  accept=".txt,.md,.csv,.json,text/plain,application/json"
                  aria-label="选择词库文件"
                  disabled={phase === 'run'}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void readBankFile(file);
                    e.target.value = '';
                  }}
                />
                {phase === 'run' && (
                  <p className="wd-empty">练习进行中：先练完这一轮，或关闭面板后再改词库。</p>
                )}
                <div className="wd-actions">
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={phase === 'run'}
                    onClick={() => fileRef.current?.click()}
                  >
                    选择文件…
                  </button>
                </div>
                {filePreview && (
                  <p className="wd-empty wd-file__preview">
                    已读取 <b>{filePreview.name}</b>：{filePreview.total} 条
                    {filePreview.duplicates > 0 ? `，${filePreview.duplicates} 条已存在` : ''}
                    {filePreview.skipped > 0 ? `，跳过 ${filePreview.skipped} 条` : ''}。
                    点下方「导入到我的词库」才会写入。
                  </p>
                )}
                <textarea
                  className="wd-import"
                  ref={importRef}
                  value={importText}
                  spellCheck={false}
                  disabled={phase === 'run'}
                  placeholder={'homeostasis 内环境稳态\naneurysm 动脉瘤'}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    setPendingFileWords(null);
                    setFilePreview(null);
                  }}
                />
                <div className="wd-actions">
                  <button
                    className="btn btn-primary wd-import__go"
                    type="button"
                    disabled={phase === 'run'}
                    onClick={importWords}
                  >
                    导入到我的词库
                  </button>
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={customWords.length === 0 || phase === 'run'}
                    onClick={() => {
                      if (!window.confirm('清空我的词库？已导入的词会全部删除，练习记录会保留。')) return;
                      setCustomWords([]);
                      saveCustomWords([]);
                      changeBank('cet6');
                      setNotice('已清空我的词库。');
                    }}
                  >
                    清空
                  </button>
                </div>
                {customWords.length > 0 && (
                  <div className="wd-side__list">
                    {customWords.map((word) => (
                      <div key={word.en} className="wd-row wd-row--bank">
                        <b>{word.en}</b>
                        <span>{word.zh}</span>
                        <button
                          className="wd-row__x"
                          type="button"
                          aria-label={`删除 ${word.en}`}
                          title="从我的词库移除"
                          onClick={() => {
                            const next = customWords.filter((w) => normWord(w.en) !== normWord(word.en));
                            setCustomWords(next);
                            saveCustomWords(next);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {asideTab === 'lookup' && (
              <div className="wd-side__body">
                <input
                  className="wd-lookup"
                  value={lookupQuery}
                  spellCheck={false}
                  aria-label="在当前词库中查找单词"
                  placeholder="搜英文或中文，如 abandon / 废除"
                  onChange={(e) => setLookupQuery(e.target.value)}
                />
                {!lookupQuery.trim() ? (
                  <p className="wd-empty">在当前词库（{words.length} 词）里查词，查到的可以直接单练。</p>
                ) : hits.length === 0 ? (
                  <p className="wd-empty">没找到。换个拼写或中文关键词试试。</p>
                ) : (
                  <>
                    <div className="wd-lookup__count">
                      命中 {hits.length} 条{hits.length >= 60 ? '（只显示前 60）' : ''}
                    </div>
                    <div className="wd-side__list">
                      {hits.map((word) => {
                        const state = wordState(records[normWord(word.en)]);
                        return (
                          <div key={word.en} className="wd-row wd-row--lookup">
                            <b>{word.en}</b>
                            {word.ipa && <i>{word.ipa}</i>}
                            <span>{word.zh}</span>
                            <em className={`wd-state wd-state--${state}`}>{STATE_LABEL[state]}</em>
                            <button
                              className="btn btn-small"
                              type="button"
                              onClick={() => beginRun([word])}
                              title="只练这一个词"
                            >
                              练
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
              </>
            )}
          </aside>
        </div>
      </div>
    </PanelOverlay>
  );
}
