/**
 * 三栏主界面（M1~M3）：章节树 | 编辑器 | 预览 + 反链面板 + Ctrl+K 快速搜索。
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useVault } from '../core/vault';
import { isTauri } from '../storage/tauriEnv';
import { noteTemplate, parseFrontmatterCached, type NoteType } from '../core/parser';
import { appendExcerpt } from '../core/noteGen';
import { loadCards, noteStatus, srsStats } from '../core/srs';
import { parseOutline } from '../core/outline';
import OutlinePanel from './OutlinePanel';
// 音频条 + 字幕轨：打开笔记就可能用到，依赖很小（core/subtitle + icons），不单独拆 chunk
import MediaTrack from './MediaTrack';
import { buildCards } from '../core/srsCards';
import { getMistake, loadMistakes, reasonCounts } from '../core/mistakes';
import { loadBanks } from '../core/qbank';
import { loadStats } from '../core/qbankStats';
import { calibrationSummary } from '../core/qbankCalib';
// 学习报告聚合是纯函数（core/studyReport）：数据由调用方喂，模块自己不读存储，见其文件头
import { buildStudyReport, rangeOfPreset, type StudyReport, type StudyReportRangePreset } from '../core/studyReport';
import {
  loadAnatomyManifest,
  loadZhDict,
  sideOf,
  systemZhName,
  zhOrganName,
  type ManifestOrgan,
  type AnatomyManifest,
} from '../core/anatomy';
import { ANATOMY_REVIEW_DIR, ANATOMY_REVIEW_TITLE, anatomySection, hasSection, upsertSection } from '../core/cardSnippets';
// 笔记级音频/字幕的挂载映射（localStorage；为什么不写 frontmatter 见 core/noteMedia 顶部）
import {
  clearNoteMedia,
  getNoteMedia,
  pickMediaAttachments,
  saveNoteMedia,
  type NoteMedia,
} from '../core/noteMedia';
// 字幕解析与挖空：与 MediaTrack 内的「转成复习卡」用的是同一套纯函数
import { parseSubtitle, subtitleToCardText } from '../core/subtitle';
import { examplePack, parseKnowledgePack, planPackInstall, serializeKnowledgePack } from '../core/knowledgePack';
import { daysUntilExam, loadPlan } from '../core/reviewPlan';
import { loadReminder, markFired, reminderBody, sendSystemNotify, shouldFire } from '../core/reminder';
import ChapterTree from './ChapterTree';
import Preview from './Preview';
import { useEsc } from './useEsc';
// 编辑器（CodeMirror ~400KB）与其余弹层视图全部懒加载：首屏只加载目录 + 预览，
// 打开笔记/对应功能时才下载各自 chunk
const Editor = lazy(() => import('./Editor'));
const QuickSearch = lazy(() => import('./QuickSearch'));
const ReviewView = lazy(() => import('./ReviewView'));
const MistakeBook = lazy(() => import('./MistakeBook'));
const AnatomyBrowser = lazy(() => import('./AnatomyBrowser'));
// 结构笔记卡片：点结构后在光标旁浮现笔记正文（与 3D 舞台同层，不额外开面板）
import AnatomyNoteCard from './AnatomyNoteCard';
// 3D 视图懒加载：three.js（~1MB）拆成独立 chunk，打开解剖图谱时才加载
const AnatomyViewer3D = lazy(() => import('./AnatomyViewer3D'));
const BrainAtlasView = lazy(() => import('./BrainAtlasView'));
// 思维导图懒加载（mind-elixir 依赖较大，打开时才加载）
const MindMapView = lazy(() => import('./MindMapView'));
// 重依赖视图懒加载：force-graph / mammoth+xlsx / react-pdf-viewer+pdfjs 都很大，按需加载
const GraphView = lazy(() => import('./GraphView'));
const QuizView = lazy(() => import('./QuizView'));
const ExamCenter = lazy(() => import('./ExamCenter'));
const PdfSplitView = lazy(() => import('./PdfSplitView'));
// 格式转换懒加载：mammoth + turndown + pdfjs 都较大，打开面板时才加载
const ConvertView = lazy(() => import('./ConvertView'));
// 统一导入面板：懒加载（内部按需引入 mammoth / SheetJS / jszip 等重依赖）
const ImportView = lazy(() => import('./ImportView'));
// 历史版本面板：快照读取/恢复
const HistoryPanel = lazy(() => import('./HistoryPanel'));
import AiPanel from './AiPanel';
import AiAgentPanel, { type QuoteSelection } from './AiAgentPanel';
import DraftGen from './DraftGen';
import TodoView from './TodoView';
import TagBrowser from './TagBrowser';
import Dashboard from './Dashboard';
import SafetyNotice from './SafetyNotice';
// 学习报告面板：小面板（无重依赖），与 Dashboard / SafetyNotice 一样直接静态引入
import StudyReportPanel from './StudyReportPanel';
import MedicalPathwayBuilder from './MedicalPathwayBuilder';
import {
  IconSave, IconTrash, IconChevron, IconBack, IconFwd, IconSearch,
  IconFolder, IconLink, IconClose, IconPlay, IconChart,
} from './icons';
import Rail from './Rail';
import { clickable } from './a11y';
import { toast, confirmBox } from '../core/feedback';
import { morphFrom, MORPH } from '../core/viewMorph';

const RECENTS_KEY = 'knowlattice-recents';

/** 字幕复习卡落进当前笔记的小节标题：`## 字幕复习卡` 就是一张卡，卡键 = `<笔记路径>#字幕复习卡`
 *  （core/srsCards 的规则）——所以「写一个小节」等于自动进复习队列/统计/Anki 导出，不需要
 *  第二种卡片存储。同名小节由 upsertSection 覆盖，不会每点一次就多一张。 */
const SUBTITLE_REVIEW_TITLE = '字幕复习卡';

/** 已废弃的旧行内格式键位（Ctrl/⌘+B/I/H）。只消费、不动作，见 Workspace 内的守卫 effect。 */
const RETIRED_FORMAT_KEYS = ['b', 'i', 'h'];

function loadRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export default function Workspace() {
  const vault = useVault();
  const [draft, setDraft] = useState<string | null>(null); // 编辑中内容（未保存）
  const [dirty, setDirty] = useState(false);
  const [showBacklinks, setShowBacklinks] = useState(() => window.matchMedia?.('(max-width: 980px)').matches !== true);
  const [mindOpen, setMindOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [anatomyOpen, setAnatomyOpen] = useState(false);
  const [brainOpen, setBrainOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  /** 统一导入面板关闭后自增：题库练习面板据此重读题库列表。
   *  统一入口可以从「题库练习」里打开，导入的题库必须在那块面板上立刻出现。 */
  const [qbankRefresh, setQbankRefresh] = useState(0);
  const [examOpen, setExamOpen] = useState(false);
  /** 从题库列表点「模拟考试」进来时的预选题库 */
  const [examBank, setExamBank] = useState<string | undefined>(undefined);
  const [todoOpen, setTodoOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  /** 编辑器「问 AI」桥接：选段暂存，面板打开后由 quote prop 交给 AiAgentPanel 消费 */
  const [agentQuote, setAgentQuote] = useState<QuoteSelection | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [pdfOpen, setPdfOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  /** 统一导入面板：自动识别格式 + 批量 */
  const [importOpen, setImportOpen] = useState(false);
  const [pathwayOpen, setPathwayOpen] = useState(false);
  const pathwayInsertRef = useRef<((markdown: string) => void) | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  /** 目录卡片显隐（导航轨「目录」按钮切换，窄屏可收起给正文让位） */
  const [treeOpen, setTreeOpen] = useState(() => window.matchMedia?.('(max-width: 700px)').matches !== true);
  const [anatomyManifest, setAnatomyManifest] = useState<AnatomyManifest | null>(null);
  const [anatomySelected, setAnatomySelected] = useState<ManifestOrgan | null>(null);
  /** 结构笔记卡片：点击点（视口坐标；null = 从列表选中 → 停靠）+ 本次选择是否已被手动关掉 */
  const [anatomyCardAt, setAnatomyCardAt] = useState<{ x: number; y: number } | null>(null);
  const [anatomyCardClosed, setAnatomyCardClosed] = useState(false);
  /** 3D 舞台元素（回调 ref 存 state：卡片定位要用它，挂载完成的时机得能触发一次渲染） */
  const [anatomyStageEl, setAnatomyStageEl] = useState<HTMLDivElement | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  /** 保存成功闪现反馈 */
  const [savedFlash, setSavedFlash] = useState(false);
  /** 上一次保存失败（用于节流提示）与失败后的自动重试次数 */
  const saveErrRef = useRef<{ msg: string; at: number } | null>(null);
  const saveRetryRef = useRef(0);
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  /** 笔记导航历史（后退/前进） */
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: [], idx: -1 });
  /** 本页目录：随草稿实时解析（打字即更新）；activeHeading = 光标所在小节的标题行号 */
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  /** 编辑器注册的「跳转到行」实现（本页目录点击用），模式同 pathwayInsertRef */
  const outlineJumpRef = useRef<((line: number) => void) | null>(null);
  /** 根节点：右侧 AI 面板让位时要量导航轨实际宽度（见下面的 ResizeObserver） */
  const appRef = useRef<HTMLDivElement>(null);

  /** 让位宽度要扣掉导航轨：轨宽由 Rail 自己的展开偏好决定（66 / 208px），这里直接量
   *  实际宽度写进 --rail-w，比 :has() 选择器可靠，也不依赖浏览器对 :has 的支持。
   *  用 useLayoutEffect：首帧绘制前就写好，避免「先按 66px 算、再跳一下」的闪烁；
   *  必须放在加载/错误页的早返回之前（Hook 不能条件调用）。
   *  jsdom 没有 ResizeObserver，测试环境跳过（CSS 里的 66px 兜底仍然生效）。 */
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app || typeof ResizeObserver === 'undefined') return;
    const rail = app.querySelector('.rail');
    if (!rail) return;
    const sync = () => app.style.setProperty('--rail-w', `${Math.round(rail.getBoundingClientRect().width)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(rail);
    return () => ro.disconnect();
    // 依赖 loaded：加载页/错误页的 .app 里没有导航轨，那时早退；进入主界面后要重新挂观察
  }, [vault.loaded]);

  // 稳定引用：让 saveCurrent / openNoteCore 等 useCallback 不随渲染链失效，
  // 也避免下游（如 GraphView）因回调身份变化而整个重建
  const editRef = useRef({ vault, draft, dirty, recents });
  editRef.current = { vault, draft, dirty, recents };

  // Ctrl+K 全局唤起快速搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 编辑器里的 Mod-<键> 绑定会先 preventDefault：全局快捷键只认「正好是 Ctrl+K」，
      // 不抢已被处理的按键，避免编辑器里的快捷键被这里顺手当成搜索。
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 废弃的旧行内格式键位（Ctrl/⌘+B 加粗、+I 斜体、+H 高亮）在应用层统一消费，不产生任何副作用。
  // 键位本身已搬到 Alt 系（见 core/mdFormat.ts）；这里兜的是「没人管」的后果：Chrome 会拿
  // Ctrl+H 打开历史记录页，正在写笔记的用户会被直接带走；Ctrl+B/I 在 contenteditable 里还有
  // 触发浏览器原生格式的风险。焦点落在编辑器、预览、目录树还是题库都一样被拦。
  // 注：macOS 的 ⌘+H 是系统级「隐藏应用」，网页拦不住，这一条实际只在 Windows / Linux 生效。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && RETIRED_FORMAT_KEYS.includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /** 立即保存当前笔记；manual=false 时不弹「已保存」反馈（自动保存用）。两条纪律：
   *  ①写失败就不清脏点、不显示「已保存」：若写失败仍清脏点并报「已保存」，
   *    用户会在「应用说存住了」的前提下丢稿；②只清「这次真正写下去的那一份」的脏标记：
   *    await 期间用户切了笔记或又输入了新内容，就不能替它们清脏。 */
  const saveCurrent = useCallback(async (manual = true) => {
    const { vault: v, draft: d } = editRef.current;
    if (!v.currentPath || d === null) return;
    const path = v.currentPath;
    const content = d;
    try {
      await v.save(path, content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('保存失败：', path, e);
      // 自动保存每 800ms 就会重试一次，同一条错误 5 秒内只提示一次，避免刷屏
      const last = saveErrRef.current;
      const now = Date.now();
      if (manual || !last || last.msg !== msg || now - last.at > 5000) {
        saveErrRef.current = { msg, at: now };
        toast(`保存失败：${msg}。内容还在编辑器里，可重试或先「备份到 .json」`, 'err');
      }
      // 脏点保留；再自动重试有限次（写失败往往是一过性的，例如另一个标签页正占着库）
      if (saveRetryRef.current < 5) {
        saveRetryRef.current += 1;
        setSaveRetryTick((t) => t + 1);
      }
      return;
    }
    saveErrRef.current = null;
    saveRetryRef.current = 0;
    // 落盘的是这一份（path + content）才算数：期间切走笔记或又改了内容，交给下一轮
    const cur = editRef.current;
    if (cur.vault.currentPath !== path || cur.draft !== content) return;
    setDirty(false);
    if (manual) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1400);
    }
  }, []);

  /** 把未保存的修改立刻落盘（切换笔记/离开页面前调用，防丢稿） */
  const flushDraft = useCallback(() => {
    if (editRef.current.dirty) void saveCurrent(false);
  }, [saveCurrent]);

  /** 最近打开：置顶 path，去重，最多保留 10 条（各入口共用，避免重复逻辑） */
  const pushRecent = useCallback((path: string) => {
    const next = [path, ...editRef.current.recents.filter((p) => p !== path)].slice(0, 10);
    setRecents(next);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  }, []);

  /** 从搜索打开笔记时的高亮词；nonce 递增 = 新的一次搜索（见 Editor 的 highlight 说明） */
  const [highlight, setHighlight] = useState<{ query: string; nonce: number } | null>(null);

  /** 只切换内容（草稿 + 当前路径 + 最近打开），不动导航历史 */
  const openNoteCore = useCallback(
    (path: string) => {
      flushDraft(); // 切走前先落盘未保存修改
      setDraft(editRef.current.vault.docs.get(path) ?? '');
      setDirty(false);
      editRef.current.vault.setCurrentPath(path);
      pushRecent(path);
    },
    [flushDraft, pushRecent]
  );

  // 自动保存：停止输入 800ms 后落盘（本地优先应用，用户不该需要记得 Ctrl+S）
  useEffect(() => {
    if (!dirty || !vault.currentPath || draft === null) return;
    const t = setTimeout(() => void saveCurrent(false), 800);
    return () => clearTimeout(t);
  }, [draft, dirty, vault.currentPath, saveCurrent]);

  // 保存失败后的自动重试：最多 5 次、每次间隔 3 秒（成功即清零，见 saveCurrent）
  useEffect(() => {
    if (!saveRetryTick) return;
    const t = setTimeout(() => void saveCurrent(false), 3000);
    return () => clearTimeout(t);
  }, [saveRetryTick, saveCurrent]);

  // 关闭/刷新页面前尽力落盘未保存修改（自动保存的正常窗口只有 0.8s，此处兜底）
  useEffect(() => {
    const h = () => flushDraft();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [flushDraft]);

  // 切到后台标签页时也 flush 一次，比 beforeunload 更早更可靠（移动端/平板常见）
  useEffect(() => {
    const h = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [flushDraft]);

  /** 打开笔记并记入导航历史。第二个参数只有快速搜索会传（命中词，用于跳转+高亮）；
   *  用 typeof 挡一道——别的入口若把事件对象当第二参传进来，不至于被当成搜索词。 */
  const openNote = useCallback(
    (path: string, highlightQuery?: string, origin?: Element | null) => {
      const q = typeof highlightQuery === 'string' ? highlightQuery.trim() : '';
      const commit = () => {
        setHighlight((h) => (q ? { query: q, nonce: (h?.nonce ?? 0) + 1 } : null));
        openNoteCore(path);
        setNav((n) => {
          const stack = n.stack.slice(0, n.idx + 1);
          if (stack[n.idx] === path) return n;
          stack.push(path);
          return { stack, idx: stack.length - 1 };
        });
      };
      // 带来源元素时做共享元素转场（第 3 项）：被点的卡片收进工具栏的笔记标题。
      // flushSync 是必需的：View Transitions 的回调必须同步改完 DOM，
      // 否则新快照等于旧快照，浏览器认为「什么都没变」，转场看不出来。
      if (origin) morphFrom(origin, MORPH.noteTitle, '.note-path', () => flushSync(commit));
      else commit();
    },
    [openNoteCore]
  );

  const canBack = nav.idx > 0;
  const canFwd = nav.idx < nav.stack.length - 1;
  const goBack = useCallback(() => {
    if (!canBack) return;
    openNoteCore(nav.stack[nav.idx - 1]);
    setNav((n) => ({ ...n, idx: n.idx - 1 }));
  }, [canBack, nav, openNoteCore]);
  const goForward = useCallback(() => {
    if (!canFwd) return;
    openNoteCore(nav.stack[nav.idx + 1]);
    setNav((n) => ({ ...n, idx: n.idx + 1 }));
  }, [canFwd, nav, openNoteCore]);

  // Alt+← / Alt+→ 后退前进（与 Esc 无关，留在 window 上）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goBack, goForward]);

  // 解剖图谱 / 脑图谱的 Esc 分层退出。走全局 Esc 栈：本层在应用启动时就入栈（栈底），
  // 所以任何面板打开时 Esc 先归那个面板——不会再出现「一次 Esc 同时关掉搜索框和整个图谱」。
  useEsc(() => {
    if (brainOpen) { setBrainOpen(false); return; }
    if (anatomyOpen) {
      // 先关笔记卡片，再关整个图谱面板：一次 Esc 只退一层，不会把 3D 一起带走
      if (anatomySelected && !anatomyCardClosed) { setAnatomyCardClosed(true); return; }
      setAnatomyOpen(false);
    }
  });

  /** 点击双链：存在则跳转；不存在则提示创建占位笔记（M3 灰色占位逻辑） */
  const handleOpenLink = useCallback(
    async (name: string) => {
      const resolved = vault.resolveLink(name);
      if (resolved) {
        openNote(resolved);
        return;
      }
      if (await confirmBox({
        title: `创建「${name}」？`,
        detail: '这个双链还没有对应的笔记',
        okText: '创建',
      })) {
        void handleCreate('', name);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, openNote]
  );

  /** 打开 3D 解剖图谱（首次打开时才加载 manifest，避免启动就拉大文件） */
  const openAnatomy = useCallback(async () => {
    setAnatomyOpen(true);
    // 重开时卡片先收起：上次的选中结构仍在（3D 高亮保留），但不该一进来就弹卡片
    setAnatomyCardClosed(true);
    if (!anatomyManifest) {
      try {
        setAnatomyManifest(await loadAnatomyManifest());
      } catch (e) {
        toast(`解剖图谱加载失败：${(e as Error).message}`, 'err');
        setAnatomyOpen(false);
      }
    }
  }, [anatomyManifest]);

  /** 打开「智能草稿」（每次进入都清空上次残留文本） */
  const openDraft = useCallback(() => {
    setDraftText('');
    setDraftOpen(true);
  }, []);

  /** 回到主界面（欢迎页）：先把未保存改动落盘，再清空当前笔记。
   *  医学通路工作区会整屏替换三栏布局，必须一并退出，否则点了按钮界面纹丝不动。 */
  const goHome = useCallback(() => {
    flushDraft();
    setDraft(null);
    setDirty(false);
    setPathwayOpen(false);
    vault.setCurrentPath(null);
  }, [flushDraft, vault]);

  const handleChange = useCallback((v: string) => {
    setDraft(v);
    setDirty(true);
  }, []);

  // Ctrl+S / Cmd+S 保存
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveCurrent();
    }
  };

  /** 解剖结构 → 打开/创建笔记（章节按系统自动分类） */
  const handleAnatomyOpenNote = useCallback(
    async (organ: ManifestOrgan) => {
      const existing = vault.resolveLink(organ.name_en) ?? vault.resolveLink(organ.organ_id);
      if (existing) {
        openNote(existing);
        setAnatomyOpen(false);
        return;
      }
      const zh = systemZhName(organ.system);
      const dir = `08-解剖学/${zh}`;
      // 先落盘当前笔记：下面 createNote 会把 currentPath 切到新笔记（内部 setCurrentPath），
      // 而自动保存窗口有 800ms——不先 flush，用户在这段时间里的改动会既不落盘、又可能被
      // 当成新笔记的草稿写进去。openNoteCore 走的是 flushDraft，这条创建分支同样要先 flushDraft。
      flushDraft();
      // 汉化：笔记标题/文件名优先用中文结构名（词典缺失或与已有笔记重名时回退英文）
      const zhDict = await loadZhDict();
      const zhName = zhOrganName(organ.name_en, zhDict.organs);
      // 成对结构（左右对称）共享一篇笔记：标题用无侧别名（「踇展肌」而非「踇展肌(左)」），
      // 3D 两侧都挂到这一篇。单侧结构行为不变。
      const side = sideOf(organ.name_en);
      const otherOrgan = side
        ? { nameEn: side.other, zhName: zhOrganName(side.other, zhDict.organs) }
        : null;
      const sharedTitleZh = side && zhName ? zhName.replace(/（[左右]）$/, '') : null;
      const sharedTitleEn = side ? side.base : null;
      // 共享标题优先；被占用（如已有一篇恰好同名的其它笔记）则退回本侧精确名
      const sharedTitle = sharedTitleZh ?? sharedTitleEn;
      const sharedFree = sharedTitle != null && !vault.docs.has(`${dir}/${sharedTitle}.md`);
      const title = sharedFree
        ? sharedTitle!
        : zhName && !vault.docs.has(`${dir}/${zhName}.md`) ? zhName : organ.name_en;
      // aliases 只收无侧别英文名:分侧精确名（本侧/对侧英文、双侧中文）不能进共享篇的
      // aliases——nameIndex 先到先得，共享篇一旦占用 'Abductor hallucis (left)'，
      // 之后建的（或既有的）分侧笔记就会被它抢走解析，破坏「分侧笔记优先」。
      // 中文共享名靠文件名命中（zhBase 候选），无需 alias。
      const aliases = side ? [side.base] : [organ.name_en];
      const layerLabel = side
        ? `${organ.path.join(' > ') || '(系统根结构)'}（左右对称，本篇共享：${sharedFree ? '左右' : '本篇为 ' + title}）`
        : organ.path.join(' > ') || '(系统根结构)';
      const lines = [
        '---',
        `aliases: [${aliases.join(', ')}]`,
        'tags: [解剖]',
        `chapter: 解剖学/${zh}`,
        `source: Anatria-3D ${organ.mesh_file}`,
        `created: ${new Date().toISOString().slice(0, 10)}`,
        '---',
        '',
        `# ${title}`,
        '',
        `- 层级: ${layerLabel}`,
        `- 系统: ${zh} (${organ.system})`,
        `- 结构ID: ${organ.organ_id}${otherOrgan ? ` / ${side!.other}` : ''}`,
        `- 英文名: ${organ.name_en}${otherOrgan?.zhName ? ` / ${otherOrgan.zhName}` : ''}`,
        '',
        '- 定义: ',
        '- 临床意义: ',
        '- 相关结构: ',
        '- 我的理解: ',
      ];
      let path: string;
      try {
        path = await vault.createNote(dir, title, lines.join('\n'));
      } catch (err) {
        toast((err as Error).message, 'err');
        return;
      }
      setDraft(lines.join('\n'));
      setDirty(false);
      vault.setCurrentPath(path);
      pushRecent(path);
      setAnatomyOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, openNote, flushDraft]
  );

  /**
   * 3D/列表单击 → 选中高亮 + 浮现该结构的笔记卡片（不打开笔记；null = 取消选中）。
   * at 是 3D 点击点在视口中的坐标，卡片贴着光标浮现；从右侧列表选中时没有点击点，卡片停靠左上角。
   */
  const handleAnatomySelect = useCallback(
    (organ: ManifestOrgan | null, at?: { x: number; y: number }) => {
      setAnatomySelected(organ);
      setAnatomyCardAt(at ?? null);
      setAnatomyCardClosed(false); // 每次选择都重新弹卡片（手动关过也一样）
    },
    []
  );

  /**
   * 解剖结构 → 复习卡：把结构写进「解剖复习卡」这篇笔记的一个 `##` 小节。
   *
   * 为什么不另建一套"手工卡"存储：core/srsCards.ts 的规则是「`##` 小节 = 一张卡」，
   * 卡键 = `<路径>#<小节标题>`。写进小节之后，FSRS 调度、卡片编辑/删除、统计面板的
   * 今日到期、整包备份、Markdown 导出全都**一行都不用改**就自动生效
   * （完整取舍见 core/cardSnippets.ts 顶部）。
   *
   * 幂等：同标题小节已存在时替换内容而不是追加（upsertSection），连点两次不会得到两张一样的卡。
   */
  const handleAnatomyMakeCard = useCallback(
    async (organ: ManifestOrgan) => {
      const zhDict = await loadZhDict();
      const zhName = zhOrganName(organ.name_en, zhDict.organs);
      // 关联笔记（如果建过）：卡片属性里给一条 [[双链]]，复习时能直接跳回去
      const notePath = vault.resolveLink(organ.name_en) ?? vault.resolveLink(organ.organ_id);
      const noteTitle = notePath
        ? parseFrontmatterCached(notePath, vault.docs.get(notePath) ?? '').title ||
          notePath.replace(/\.md$/, '').split('/').pop() ||
          ''
        : '';
      const section = anatomySection({
        zhName: zhName ?? organ.name_en,
        enName: organ.name_en,
        system: systemZhName(organ.system),
        noteTitle,
      });
      const path = `${ANATOMY_REVIEW_DIR}/${ANATOMY_REVIEW_TITLE}.md`;
      // 这篇笔记可能还不存在：先按空模板建出来，并把模板本身当作写入基底。
      // 不能在 createNote 之后再读 vault.docs —— 那是本次渲染的闭包快照，
      // 刚建的笔记在里面仍是 undefined，会把它当成空文件写掉（标题与 frontmatter 一起丢）。
      const template = noteTemplate(ANATOMY_REVIEW_TITLE, '解剖学/复习卡', 'blank');
      const base = vault.docs.get(path) ?? template;
      if (!vault.docs.has(path)) {
        try {
          await vault.createNote(ANATOMY_REVIEW_DIR, ANATOMY_REVIEW_TITLE, template);
        } catch (err) {
          toast((err as Error).message, 'err');
          return;
        }
      }
      const existed = hasSection(base, section.title);
      await vault.save(path, upsertSection(base, section.title, section.body));
      toast(existed ? `已更新「${section.title}」的复习卡。` : `已把「${section.title}」写成复习卡，会进复习队列。`, 'ok');
    },
    [vault]
  );

  /**
   * 导入知识包：只新建、**绝不覆盖**同名笔记（逐条把跳过原因回报给界面）。
   * 写盘复用既有的「导入 md 文件」通道（写多篇 + 格式修正 + 失败逐条回报），
   * 不新造一套写盘路径；已存在的路径在 planPackInstall 里就被剔除了，
   * 所以这里碰不到用户自己已有的笔记。
   */
  const handleImportPack = useCallback(
    async (text: string) => {
      const plan = planPackInstall(parseKnowledgePack(text), (p) => vault.docs.has(p));
      if (plan.toCreate.length === 0) return { created: 0, skipped: plan.skipped };
      const r = await vault.importMdFiles(plan.toCreate.map((e) => ({ path: e.path, content: e.content })));
      const skipped = [...plan.skipped];
      if (r.failed) {
        skipped.push({ path: '（部分失败）', title: '', reason: `${r.failed} 篇写入失败，可能是存储空间不足` });
      }
      return { created: r.ok, skipped };
    },
    [vault]
  );

  /** 下载自带示例知识包：不含任何医学结论，只演示知识包格式与 `{{挖空}}` 用法 */
  const handleDownloadExamplePack = useCallback(() => {
    // 不走 core/anki 的 downloadFile：那会把导出相关的依赖拖进主包，
    // 而这里只需要这几行下载（与 ReviewView 的导出同一个理由）。
    const blob = new Blob([serializeKnowledgePack(examplePack())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'knowlattice-示例知识包.json';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /** vault 路径 → 可渲染内容：.md 返回文本，附件返回 Blob 对象 URL（由 vault 统一解析） */
  const readFile = vault.readFile;

  /** 从复习卡 / 错题本 / 题库「问 AI」：把那段内容作为引用交给 AI 笔记面板。
   *  来源面板**不关闭** —— AI 面板拿到引用后会抬到浮层之上（.agent-panel.has-quote），
   *  复习、练习到一半不被打断；引用一发出面板就落回原层级。 */
  const askAgent = useCallback((quote: { text: string; path: string | null; ask?: string }) => {
    setAgentQuote(quote);
    setAiOpen(false); // 与 AI 助手面板互斥（共用同一块让位空间）
    setAgentOpen(true);
  }, []);

  const handleCreate = useCallback(
    async (dir: string, title: string, type: NoteType = 'concept') => {
      try {
        // 与解剖图谱的创建分支同理：createNote 内部会 setCurrentPath 切走当前笔记，
        // 不先落盘的话，自动保存窗口（800ms）内的输入会被下面 setDraft(template) 直接覆盖。
        flushDraft();
        const template = noteTemplate(title, dir || '未分类', type);
        const path = await vault.createNote(dir, title, template);
        // 直接用模板内容填充草稿，避免读到更新前的旧 docs 缓存
        setDraft(template);
        setDirty(false);
        vault.setCurrentPath(path);
        pushRecent(path);
      } catch (err) {
        toast((err as Error).message, 'err');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, pushRecent, flushDraft]
  );

  // 路径数组改由 vault 提供：它只在增删笔记时换引用，改正文的自动保存不会重建它
  const notePaths = vault.notePaths;
  /** PDF 对照的笔记目标列表。**只在面板真的打开时才算**：它对全库逐篇解析 frontmatter
   *  并新建等量对象，而面板关着的时候这个列表没有任何消费者。 */
  const noteTargets = useMemo(
    () =>
      pdfOpen
        ? notePaths.map((path) => {
            const parsed = parseFrontmatterCached(path, vault.structureDocs.get(path) ?? '');
            return {
              path,
              title: parsed.title || path.replace(/\.md$/, '').split('/').pop() || path,
              chapter: parsed.meta.chapter,
            };
          })
        : [],
    [pdfOpen, notePaths, vault.structureDocs]
  );
  const noteCount = notePaths.length;
  /** 现存路径集合（历史面板判断「已删除」快照用；memoized 防止面板 effect 重载） */
  const existingPathSet = useMemo(() => new Set(notePaths), [notePaths]);
  const wordCount = useMemo(
    () => (draft ? draft.replace(/\s/g, '').length : 0),
    [draft]
  );

  // 复习状态按「卡」看：一篇笔记可能切成多节，这里显示最紧的那张 + 已排程节数。
  // 必须 memo：编辑器每敲一个字就渲染一次；它读的是 vault.docs
  // （已落盘内容）而不是草稿，所以按键根本不会改变结果，按保存/切换重算就够了。
  // 位置必须在这里——下面还有「未加载」「加载失败」两处提前 return，hook 不能放在其后。
  const activePath = vault.currentPath;
  const activeStatus = useMemo(
    () => (activePath ? noteStatus(buildCards([activePath], vault.docs), activePath) : null),
    [activePath, vault.docs]
  );
  // 本页目录：读草稿（未保存内容）而不是 docs——打字时目录即时跟上。
  // 无标题的笔记返回空数组，大纲区整个不渲染。
  const outline = useMemo(() => parseOutline(draft ?? ''), [draft]);

  /* ── 笔记级音频 + 字幕（I1）────────────────────────────────────────────
   * 放在这里而不是文件顶部：要用到 activePath（上面）与 readFile（上面的 `const readFile = vault.readFile`），又必须在下两处
   * 「未加载 / 加载失败」提前 return 之前——Hook 不能条件调用。
   * 挂载关系只存 localStorage（core/noteMedia），**不写进笔记 frontmatter**：写 frontmatter 会让
   * 每一篇老笔记在下次保存时都被重写一遍，等于强制迁移全部历史数据（见 core/noteMedia 顶部）。
   */
  /** 当前笔记挂的音频/字幕。连笔记路径一起存：切笔记的瞬间就能判定这份挂载属不属于当前笔记，
   *  不会先闪一帧上一篇笔记的音频条（effect 要等这次渲染提交之后才跑）。 */
  const [activeMedia, setActiveMedia] = useState<{ path: string; media: NoteMedia } | null>(null);
  /** 字幕原文（异步读附件得到）；null = 还没读到：读字幕不阻塞笔记正文与音频条 */
  const [mediaSubtitleText, setMediaSubtitleText] = useState<string | null>(null);
  /** 隐藏的文件选择框：工具栏「音频/字幕」入口点它（原生选择器，桌面与移动端都能多选） */
  const mediaInputRef = useRef<HTMLInputElement>(null);
  /** readFile 的身份每次自动保存都会换（docs 换引用）；用 ref 取最新实现，
   *  免得下面的字幕 effect 每 800ms 重读同一个附件一遍。 */
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;

  /** 本次渲染要显示的挂载：只认属于当前打开笔记的那一份 */
  const media = activeMedia?.path === activePath ? activeMedia.media : null;
  /** 音频地址：vault.readFile 对附件返回 blob 对象 URL（惰性创建并缓存，见 vault.ts）；
   *  附件缺失时返回 undefined —— 这时不渲染播放器，走下面「只给一行说明」的兜底分支。 */
  const mediaAudioSrc = media?.audio ? readFile(media.audio) : undefined;

  // 切笔记即换挂载：读 localStorage 里的映射，不是笔记正文
  useEffect(() => {
    if (!activePath) {
      setActiveMedia(null);
      return;
    }
    const m = getNoteMedia(activePath);
    setActiveMedia(m ? { path: activePath, media: m } : null);
  }, [activePath]);

  /**
   * 读字幕文本。
   *
   * 为什么是 `fetch(vault.readFile(...)).then(r => r.text())`：readFile 对附件**只返回 blob 对象 URL**
   * （它按「可渲染内容」设计，给 <img>/<audio> 用），没有「读附件原文」的出口，而字幕是文本。
   * 另一条路是在 vault.ts 的 readFile 里加「按后缀返回文本」的分支，但那个返回值被 Preview /
   * Editor / 题库 / 预览等多处共同依赖——为一个新功能改它的语义会波及其它调用方。
   * 所以就地再读一次：blob: URL 的 fetch 是同源内存读（不发网络请求、离线可用），代价只有一次拷贝。
   *
   * 竞态：切笔记或换字幕时 cleanup 把这一轮的 cancelled 置真，旧笔记的字幕绝不会写进新笔记的状态；
   * 读到之前 mediaSubtitleText 为 null，界面只显示音频条（MediaTrack 收到空字幕就不渲染字幕列表）。
   */
  useEffect(() => {
    const subtitlePath = activeMedia?.path === activePath ? activeMedia.media.subtitle : undefined;
    setMediaSubtitleText(null);
    if (!subtitlePath) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = readFileRef.current(subtitlePath);
        if (!url) throw new Error(`读不到字幕附件：${subtitlePath}`);
        const text = await fetch(url).then((r) => r.text());
        if (!cancelled) setMediaSubtitleText(text);
      } catch (e) {
        if (!cancelled) toast(`字幕读取失败：${(e as Error).message}`, 'err');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeMedia]);

  /**
   * 挂接音频/字幕：一次可多选，按文件名分类后逐面落库（_attachments/），再记本地挂载。
   * 先写附件、写成功才记映射：附件写失败直接报错返回，**不留「界面说挂上了、其实读不到文件」的假成功**。
   */
  const handlePickMediaFiles = useCallback(async (files: File[]) => {
    const v = editRef.current.vault;
    const path = v.currentPath;
    if (!path || !files.length) return;
    // 分类只看文件名（core/noteMedia 的判据，与上面 accept 一致）。同类多选时取第一个：
    // pickMediaAttachments 按路径升序返回，同一次选择结果稳定；另一侧照常挂上，
    // 不因为用户顺手多选了两个音频就整批放弃。
    const byName = new Map(files.map((f) => [f.name, f]));
    const picked = pickMediaAttachments([...byName.keys()]);
    const audioName = picked.audio[0];
    const subtitleName = picked.subtitle[0];
    if (!audioName && !subtitleName) {
      toast('没认出音频或字幕文件（音频 .mp3/.m4a/.wav/.ogg/.webm，字幕 .srt/.vtt）', 'info');
      return;
    }
    const patch: NoteMedia = {};
    try {
      if (audioName) patch.audio = await v.saveAttachment(audioName, byName.get(audioName)!);
      if (subtitleName) patch.subtitle = await v.saveAttachment(subtitleName, byName.get(subtitleName)!);
    } catch (e) {
      toast(`挂载失败：${(e as Error).message}`, 'err');
      return;
    }
    saveNoteMedia(path, patch);
    const label = [audioName ? '音频' : '', subtitleName ? '字幕' : ''].filter(Boolean).join(' + ');
    // await 期间用户可能已经切走：映射照样存下了（键是原路径），但不能再往界面写新笔记的状态
    if (editRef.current.vault.currentPath !== path) {
      toast(`已给「${path.replace(/\.md$/, '')}」挂上${label}`, 'info');
      return;
    }
    setActiveMedia({ path, media: getNoteMedia(path) ?? patch });
    toast(`已挂上${label}（挂载只记在本机，不写进笔记正文）`, 'ok');
  }, []);

  /** 卸载当前笔记的音频/字幕：只摘挂载，_attachments/ 里的文件留着，随时能再挂一次 */
  const handleMediaClose = useCallback(() => {
    const path = editRef.current.vault.currentPath;
    if (!path) return;
    clearNoteMedia(path);
    setActiveMedia(null);
    setMediaSubtitleText(null);
    toast('已卸载这篇笔记的音频/字幕（附件文件仍留在库里）', 'info');
  }, []);

  /**
   * 字幕 → 复习卡：写进当前笔记的 `## 字幕复习卡` 小节，与 handleAnatomyMakeCard 同一套做法
   * （同一个 upsertSection + vault.save）。
   *
   * 为什么覆盖同名小节而不是再追加一份：`##` 小节 = 一张卡，卡键 = `<笔记路径>#<小节标题>`
   * （core/srsCards）。追加第二份同名小节会让复习队列里出现两张几乎一样的卡、各算一套 FSRS
   * 调度——用户连点两次「转成复习卡」就多一张。upsertSection 是幂等的（同标题替换内容）。
   */
  const handleMediaMakeCards = useCallback(async (cardText: string) => {
    const { vault: v, draft } = editRef.current;
    const path = v.currentPath;
    if (!path || !cardText.trim()) return;
    // 基底取**编辑器草稿**而不是 docs（已落盘内容）：草稿才是用户此刻看到的正文，
    // 拿 docs 当基底会把还在自动保存窗口里的输入抹掉。
    const base = draft ?? v.docs.get(path) ?? '';
    const next = upsertSection(base, SUBTITLE_REVIEW_TITLE, cardText);
    // 先把带卡的正文交给编辑器并标脏：这样即使这次写盘失败，自动保存也会把它补上；
    // 只 setDraft 不标脏的话，写失败后这张卡只存在于内存缓冲区里，切走就没了。
    setDraft(next);
    setDirty(true);
    try {
      await v.save(path, next);
    } catch (e) {
      toast(`复习卡写入失败：${(e as Error).message}`, 'err');
      return;
    }
    // 只清「刚写下去的这份」的脏点：await 期间用户又敲了字，脏点得留着（同 saveCurrent 的纪律）
    if (editRef.current.draft === next) setDirty(false);
    toast('已生成复习卡，可在复习页看到', 'ok');
  }, []);

  /**
   * 每日复习提醒：每分钟对一次表，到点且今天还有到期卡时提醒一次。
   *
   * 为什么用轮询而不是到点 setTimeout：用户在提醒时刻之前关掉应用、之后又打开，
   * setTimeout 那套会整个错过（与 core/pomodoro.ts「用时间戳现算、不靠累加计数」同一理由）。
   * 60s 间隔 + 纯函数判定（shouldFire，用 >= 比较）意味着错过的那一分钟不会造成漏提醒。
   *
   * 开销：**默认关闭时这个心跳几乎零成本**——先读配置，未开启就直接返回，
   * 连 buildCards 都不跑（那是全库切卡，5000 篇规模下几十毫秒）。
   * 数据用 ref 取最新值，定时器本身不随 docs 变化重建；否则每次自动保存
   * （停手 800ms）都会重跑一次全库切卡，打字就会周期性卡顿。
   *
   * 发送路径：先试系统通知，不可用就退回应用内 toast —— Tauri 的 WebView2 对
   * Web Notification 的支持不保证，两条路都必须能用（见 core/reminder.ts 顶部说明）。
   * 无论走哪条，markFired 都要落盘，否则 60 秒后又会提醒一次。
   */
  const reminderDataRef = useRef({ paths: notePaths, docs: vault.docs });
  useEffect(() => {
    reminderDataRef.current = { paths: notePaths, docs: vault.docs };
  }, [notePaths, vault.docs]);
  useEffect(() => {
    if (!vault.loaded) return;
    const check = () => {
      const cfg = loadReminder();
      if (!cfg.enabled) return;
      const { paths, docs } = reminderDataRef.current;
      const dueNow = srsStats(buildCards(paths, docs)).dueNow;
      if (!shouldFire(cfg, new Date(), dueNow)) return;
      const text = reminderBody(dueNow, daysUntilExam(loadPlan().examDate));
      markFired(cfg);
      if (!sendSystemNotify('该复习了 · 晶格', text)) toast(text, 'info', 6000);
    };
    check(); // 启动时立刻对一次表：错过了设定时刻也要在当天补上提醒
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, [vault.loaded]);

  /* ── 学习报告（P3）─────────────────────────────────────────────────────
   * 为什么数据在**点开时**才聚合（openStudyReport）而不是放渲染路径里：buildCards 要全库切卡、
   *   chapterMastery / bankProgress 要遍历全部题库，5000 篇笔记的规模下是几十毫秒——放进 render
   *   等于每次自动保存（停手 800ms）都白跑一遍（与上面每日提醒那段同一理由）。
   *
   * 各数据源一律走**既有出口**，不新造加载路径：
   *   题库 core/qbank.loadBanks（唯一异步源：题库在 IndexedDB）、逐题记录 core/qbankStats.loadStats、
   *   复习卡 buildCards(vault.notePaths, vault.docs)、调度 core/srs.loadCards、
   *   复习计划 core/reviewPlan.loadPlan、错题 core/mistakes.loadMistakes、
   *   错因 core/mistakes.reasonCounts、把握度校准 core/qbankCalib.calibrationSummary。
   * 时间范围：面板上那排「全部（累计）/ 近 7 天 / 近 30 天」只把**档位**交给这里，由这里重算
   *   （面板自己不读存储，见 StudyReportPanel 文件头）。为什么选这一侧：重算要 loadBanks / buildCards /
   *   一批 localStorage，全是**这里已有的数据线**；搬进展示层等于把面板那条「props 驱动、自包含」自己破掉，
   *   面板也就不能再被导出/备份路径复用。默认档 'all' 由 rangeOfPreset 返回 undefined（= 完全不传 range），
   *   于是报告输出与加时间范围之前**逐字一致** —— 这是本项目的硬要求。
   */
  const [reportOpen, setReportOpen] = useState(false);
  /** 报告数据；null = 还没生成成功过（面板只在 reportOpen && report 时渲染） */
  const [report, setReport] = useState<StudyReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  /**
   * 面板里选中的范围档位。默认 'all' = 累计口径 = 改动前的行为。
   * 放在 Workspace 而不是面板：它决定「用哪份输入去聚合」，属于数据侧状态（理由见上）。
   */
  const [reportRange, setReportRange] = useState<StudyReportRangePreset>('all');

  /** 按给定档位聚合一次报告。**调用者必须在事件里调用**（理由见上面那段：不能放 render）。 */
  const buildReportFor = useCallback(async (preset: StudyReportRangePreset) => {
    // 用 editRef 取最新的 vault（它每次渲染都刷新）：docs / notePaths 与界面同步，
    // 不像闭包里的 vault 会停在回调创建那一刻
    const v = editRef.current.vault;
    const banks = await loadBanks(); // 唯一异步源：题库存在 IndexedDB，其余都是同步 localStorage 读
    return buildStudyReport({
      banks,
      stats: loadStats(),
      cards: buildCards(v.notePaths, v.docs),
      schedules: loadCards(),
      plan: loadPlan(),
      mistakes: loadMistakes(),
      calibration: calibrationSummary(),
      mistakeReasons: reasonCounts(),
      // 'all' → undefined：与「根本不传 range」完全是同一条代码路径（buildStudyReport 只判 !== undefined）
      range: rangeOfPreset(preset),
      title: '本次学习报告',
    });
  }, []);

  /** 点入口时再跑聚合；失败要如实报错，不能静默弹出一个空报告 */
  const openStudyReport = useCallback(async () => {
    if (reportBusy) return; // 聚合期间按钮已 disabled，这里再挡一次双击
    setReportBusy(true);
    try {
      setReport(await buildReportFor(reportRange));
      setReportOpen(true);
    } catch (e) {
      toast(`学习报告生成失败：${(e as Error).message}`, 'err');
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, reportRange, buildReportFor]);

  /**
   * 面板里切换时间范围：重算同样在**事件里**跑（与 openStudyReport 同一理由，
   * 放 render 会被每 800ms 的一次自动保存拖着白跑全库聚合）。
   * 只有算成功才更新档位：否则面板会高亮「近 7 天」而正文还是累计口径，用户看到的是假状态。
   * 切回「全部（累计）」是重新按累计口径算一遍，输出仍与改动前逐字一致。
   */
  const changeReportRange = useCallback(async (preset: StudyReportRangePreset) => {
    if (preset === reportRange || reportBusy) return; // 点的是当前档位，或正在聚合：不必再跑一次
    setReportBusy(true);
    try {
      setReport(await buildReportFor(preset));
      setReportRange(preset);
    } catch (e) {
      toast(`学习报告生成失败：${(e as Error).message}`, 'err');
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, reportRange, buildReportFor]);

  /** 复制报告 Markdown：提供 onCopy 后面板就不再自己提示（见 StudyReportPanel 的 props 注释），
   *  所以这里必须把「成功 / 失败」都报出来，免得用户以为复制成功了。 */
  const handleCopyReport = useCallback(async (markdown: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板');
      await navigator.clipboard.writeText(markdown);
      toast('已复制报告 Markdown', 'ok');
    } catch (e) {
      toast(`复制失败：${(e as Error).message}，可手动全选复制`, 'err');
    }
  }, []);

  if (!vault.loaded) {
    return <div className="loading">加载知识库…</div>;
  }

  // 库没读出来时停在错误页，**不进入可写状态**：此时内存里一篇笔记都没有，
  // 放行进去会让「新建/查重」以「磁盘上没有这篇」为前提行事，把真实笔记覆盖掉。
  if (vault.loadError) {
    return (
      <div className="app">
        <div className="load-error" role="alert">
          <h2>知识库加载失败</h2>
          <p className="load-error-msg">{vault.loadError}</p>
          <p className="muted">
            为避免把已有笔记当成新笔记覆盖，已停用编辑。数据仍在浏览器本地存储里，重试即可。
          </p>
          <button className="btn-primary" onClick={vault.retryLoad}>重试</button>
        </div>
      </div>
    );
  }

  const activeCard = activeStatus?.card ?? null;
  // 单条直查（loadMistakes 的整表浅拷贝是给 setState 用的，这里在渲染体内、每键一次，走 O(1) 读取）
  const activeMistake = activePath ? getMistake(activePath) : null;
  const activeExam = activePath
    ? parseFrontmatterCached(activePath, vault.docs.get(activePath) ?? '').meta.exam
        : null;
  const activeSections = activeStatus && activeStatus.total > 1 ? ` · ${activeStatus.learned}/${activeStatus.total} 节` : '';
  const activeDueText = activeCard
    ? (activeStatus!.dueNow
        ? '到期待复习'
        : `${activeCard.reps} 次 · 下次 ${new Date(activeCard.due).toLocaleDateString('zh-CN')}`) + activeSections
    : null;
  const activeRailItem = pathwayOpen ? 'pathway'
    : searchOpen ? 'search'
    : pdfOpen ? 'pdf'
      : anatomyOpen ? 'anatomy'
        : brainOpen ? 'brain'
          : graphOpen ? 'graph'
            : reviewOpen ? 'review'
              : mistakeOpen ? 'mistake'
                : quizOpen ? 'quiz'
                  : todoOpen ? 'todo'
                    : tagOpen ? 'tag'
                      : dashOpen ? 'dashboard'
                        : aiOpen ? 'ai'
                          : agentOpen ? 'agent'
                            : draftOpen ? 'draft'
                              : historyOpen ? 'history'
                                : convertOpen ? 'convert'
                                  : importOpen ? 'import'
                                    : null;

  // 右侧 AI 面板打开时把主区挤窄，避免面板压住笔记（见 index.css 的 .app.ai-open / .agent-open）。
  // 面板自身是 position: fixed，不受这里的 padding 影响，只是把左侧内容让出等宽空间。
  const sidePanelClass = agentOpen ? ' agent-open' : aiOpen ? ' ai-open' : '';

  return (
    <div className={`app${sidePanelClass}`} ref={appRef} onKeyDown={onKeyDown} tabIndex={-1}>
      {/* 左侧导航轨：功能入口 + 字体/主题切换（见 Rail.tsx） */}
      <Rail
        activeItem={activeRailItem}
        treeOpen={treeOpen}
        onToggleTree={() => { setPathwayOpen(false); setTreeOpen((v) => !v); }}
        onPathway={() => setPathwayOpen((v) => !v)}
        onHome={goHome}
        onSearch={() => setSearchOpen(true)}
        onHistory={() => setHistoryOpen(true)}
        onAnatomy={() => void openAnatomy()}
        onBrain={() => setBrainOpen(true)}
        onGraph={() => setGraphOpen(true)}
        onReview={() => setReviewOpen(true)}
        onMistake={() => setMistakeOpen(true)}
        onQuiz={() => setQuizOpen(true)}
        onTodo={() => setTodoOpen(true)}
        onTag={() => setTagOpen(true)}
        onDash={() => setDashOpen(true)}
        // 两个右侧面板共用同一块让位空间，同时打开会互相压住，故互斥
        onAi={() => { setAiOpen((v) => !v); setAgentOpen(false); }}
        onAgent={() => { setAgentOpen((v) => !v); setAiOpen(false); }}
        onDraft={openDraft}
        onPdf={() => setPdfOpen(true)}
        onConvert={() => setConvertOpen(true)}
        onImport={() => setImportOpen(true)}
        onNotice={() => setNoticeOpen(true)}
      />

      {pathwayOpen ? (
        <div className="pathway-workspace-host">
          <MedicalPathwayBuilder
            onClose={() => setPathwayOpen(false)}
            onInsert={(markdown) => {
              if (!vault.currentPath) { toast('请先打开一篇笔记，再插入通路图', 'info'); return false; }
              if (pathwayInsertRef.current) { pathwayInsertRef.current(markdown); return true; }
              toast('编辑器还在加载，请稍后再插入', 'info'); return false;
            }}
          />
        </div>
      ) : (
      <div className={`deck${treeOpen ? ' with-tree' : ''}`}>
        {/* 目录卡片常驻（未打开笔记时也要能选笔记），由导航轨的「目录」按钮折叠 */}
        {treeOpen && (
          <div className="card c-tree">
            <div className="card-head">
              <IconFolder size={15} />
              <span>章节目录</span>
              <span className="spacer" />
              <span className="card-head-note">{noteCount} 篇</span>
            </div>
            {/* Markdown 格式修复已改成「打开库时自动跑」（vault.autoRepair）：
                这里只把自动修正过的明细交给目录面板显示，不再有「点一下才扫描」的入口。 */}
            <ChapterTree
              tree={vault.tree}
              currentPath={vault.currentPath}
              onOpen={(path) => {
                openNote(path);
                if (window.matchMedia?.('(max-width: 700px)').matches) setTreeOpen(false);
              }}
              onCreate={handleCreate}
              onExport={() => vault.exportAll()}
              onExportFolder={() => vault.exportMdFolder()}
              onImport={(t) => vault.importBackup(t)}
              onImportMd={(files) => vault.importMdFiles(files)}
              autoRepairReport={vault.autoRepair}
              onImportPack={handleImportPack}
              onUnifiedImport={() => setImportOpen(true)}
              onDownloadExamplePack={handleDownloadExamplePack}
              onMigrateFromBrowser={isTauri() ? () => vault.migrateFromBrowser() : undefined}
              onChangeVaultFolder={isTauri() ? () => vault.changeVaultFolder() : undefined}
              vaultDir={vault.vaultDir}
              onRemove={(paths) => {
                if (vault.currentPath && paths.includes(vault.currentPath)) {
                  setDraft(null);
                  setDirty(false);
                }
                void vault.removeMany(paths).then((failed) => {
                  // 删失败的会留在目录里（内存只删真正删成功的），必须说清，否则用户以为删掉了
                  if (failed.length) toast(`${failed.length} 篇删除失败，已留在目录里`, 'err');
                });
              }}
              onFindOrphanAttachments={() => vault.findOrphanAttachments()}
              onRemoveAttachments={(paths) => vault.removeAttachments(paths)}
            />
          </div>
        )}

        {vault.currentPath ? (
          <>
            <div className="card c-edit">
              <div className="editor-toolbar">
                <button className="btn-icon" disabled={!canBack} onClick={goBack} data-tip="后退（Alt+←）" aria-label="后退">
                  <IconBack />
                </button>
                <button className="btn-icon" disabled={!canFwd} onClick={goForward} data-tip="前进（Alt+→）" aria-label="前进">
                  <IconFwd />
                </button>
                <div className="toolbar-divider" />
                <span className="note-path">
                  {vault.currentPath.replace(/\.md$/, '')}
                  {dirty && <em className="dirty-dot" title="未保存">●</em>}
                </span>
                <span className="muted word-count">{wordCount} 字</span>
                <div className="toolbar-divider" />
                <button
                  className="toolbar-search"
                  onClick={(e) => {
                    // 窄屏下搜索是底部抽屉（第 5 项），它自带「从底部滑上来」的入场；
                    // 再叠一层「从工具栏胶囊形变过去」就是两套运动打架，这里直接走抽屉。
                    if (window.matchMedia?.('(max-width: 700px)').matches) {
                      setSearchOpen(true);
                      return;
                    }
                    morphFrom(e.currentTarget, MORPH.search, '.qs-modal', () => flushSync(() => setSearchOpen(true)));
                  }}
                  data-tip="快速搜索笔记 / 全文（Ctrl+K）"
                >
                  <IconSearch />
                  <span>搜索</span>
                  <kbd>Ctrl K</kbd>
                </button>
                <div className="toolbar-divider" />
                <button className={`btn-small ${savedFlash ? 'saved' : ''}`} onClick={() => void saveCurrent()}>
                  <IconSave /> {savedFlash ? '已保存 ✓' : <>保存 <kbd>Ctrl S</kbd></>}
                </button>
                <div className="toolbar-divider" />
                <button
                  className="btn-small"
                  onClick={() => setShowBacklinks(!showBacklinks)}
                  title="关联面板：反链 / 复习 / 错题 / 真题"
                  aria-expanded={showBacklinks}
                  aria-controls="backlinks-panel"
                >
                  关联 <IconChevron open={showBacklinks} />
                </button>
                <button
                  className="btn-small"
                  onClick={() => setMindOpen(true)}
                  title="把当前笔记自动生成思维导图"
                >
                  思维导图
                </button>
                {/* 笔记级音频 + 字幕：按钮只负责唤醒隐藏的文件选择框（原生选择器支持多选） */}
                <button
                  className="btn-icon"
                  onClick={() => mediaInputRef.current?.click()}
                  data-tip="给当前笔记挂音频/字幕（可多选：.mp3/.m4a/.wav/.ogg/.webm + .srt/.vtt）"
                  aria-label="给当前笔记挂音频或字幕"
                >
                  <IconPlay />
                </button>
                <input
                  ref={mediaInputRef}
                  type="file"
                  multiple
                  accept=".mp3,.m4a,.wav,.ogg,.oga,.webm,.aac,.flac,.srt,.vtt"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    // 先把 FileList 拷成数组再清 value：files 是活的，清空 input 之后就取不到了
                    // （清 value 是为了同一个文件还能再选一次）
                    const files = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = '';
                    void handlePickMediaFiles(files);
                  }}
                />
                {/* 学习报告：与上面的音频入口相邻（同一排工具栏）。聚合在点开时才跑，
                    见 openStudyReport；这里只是个 btn-icon，不改动任何既有按钮的顺序与语义。 */}
                <button
                  className="btn-icon"
                  disabled={reportBusy}
                  onClick={() => void openStudyReport()}
                  data-tip="生成本次学习报告"
                  aria-label="生成本次学习报告"
                >
                  <IconChart />
                </button>
                <button
                  className="btn-small danger"
                  onClick={() => {
                    void confirmBox({
                      title: `删除「${vault.currentPath?.replace(/\.md$/, '')}」？`,
                      detail: '笔记将从知识库中移除；最近的历史快照仍可在「历史版本」中找回。',
                      danger: true,
                      okText: '删除',
                    }).then(async (ok) => {
                      if (!ok) return;
                      const path = vault.currentPath;
                      if (!path) return;
                      try {
                        await vault.remove(path);
                      } catch (e) {
                        toast(`删除失败：${(e as Error).message}`, 'err');
                        return; // 没删掉就不清草稿：笔记还在，界面保持原样
                      }
                      setDraft(null); // 清空草稿，避免删除后残留旧内容
                      setDirty(false);
                      toast('已删除（可在「历史版本」中恢复）', 'ok');
                    });
                  }}
                  aria-label="删除笔记"
                  title="删除当前笔记（可在「历史版本」中找回）"
                >
                  <IconTrash />
                </button>
              </div>
              {/* 当前笔记的音频条 + 逐句字幕：紧贴工具栏下方、正文上方（不动编辑器的位置）。
                  挂载只记在本机 localStorage（core/noteMedia），所以这段只在「这篇笔记挂过」时出现。 */}
              {media && (
                <div className="media-track-wrap">
                  {media.audio && mediaAudioSrc ? (
                    <MediaTrack
                      audioSrc={mediaAudioSrc}
                      subtitleText={mediaSubtitleText ?? ''}
                      onMakeCards={(cardText) => void handleMediaMakeCards(cardText)}
                      onClose={handleMediaClose}
                    />
                  ) : (
                    /* 没有可播放音频时（没挂音频，或音频附件已读不到）**不渲染 MediaTrack**：
                       <audio src=""> 会去加载「当前文档地址」，控制台报错、界面上还多一个永远
                       播不了的播放器。这一支只给一行说明；字幕仍可按 core/subtitle 挖空转成卡。 */
                    <div className="media-hint">
                      <span className="muted">
                        {media.audio ? `音频附件读不到：${media.audio}` : '这篇笔记只挂了字幕（没有音频）'}
                      </span>
                      {media.subtitle && mediaSubtitleText && (
                        <button
                          type="button"
                          className="btn-small"
                          onClick={() => void handleMediaMakeCards(subtitleToCardText(parseSubtitle(mediaSubtitleText)))}
                        >
                          转成复习卡
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label="卸载当前笔记的音频/字幕"
                        onClick={handleMediaClose}
                      >
                        <IconClose />
                      </button>
                    </div>
                  )}
                </div>
              )}

              <Suspense fallback={<div className="editor-fallback">编辑器加载中…</div>}>
                <Editor
                  value={draft ?? ''}
                  onChange={handleChange}
                  linkNames={vault.allLinkNames}
                  onOpenLink={handleOpenLink}
                  onAttach={(name, blob) => vault.saveAttachment(name, blob)}
                  onDraft={(text) => { setDraftText(text); setDraftOpen(true); }}
                  onAskAi={(text) => {
                    // 选段带上当前笔记路径：模型能知道这段话出自哪篇笔记
                    setAgentQuote({ text, path: vault.currentPath });
                    setAiOpen(false); // 与 AI 助手面板互斥（共用同一块让位空间）
                    setAgentOpen(true);
                  }}
                  onPathwayReady={(insert) => { pathwayInsertRef.current = insert; }}
                  headingLines={outline.map((o) => o.line)}
                  onActiveHeading={setActiveHeading}
                  onJumpReady={(jump) => { outlineJumpRef.current = jump; }}
                  readFile={readFile}
                  highlight={highlight}
                />
              </Suspense>
            </div>

            {showBacklinks && (
              <div className="card c-insp" id="backlinks-panel">
                <div className="card-head">
                  <IconLink size={15} />
                  <span>关联 · {vault.currentBacklinks.length}</span>
                  <span className="spacer" />
                  {/* 关联卡片是唯一「可关闭」的常驻卡片：窄屏它浮在编辑区之上，
                      会盖住工具栏里的「关联」开关，所以卡片自己必须能关。 */}
                  <button className="btn-icon" onClick={() => setShowBacklinks(false)} aria-label="关闭关联面板">
                    <IconClose />
                  </button>
                </div>
                <div className="card-body">
                  {outline.length > 0 && (
                    <OutlinePanel
                      outline={outline}
                      activeLine={activeHeading}
                      onJump={(line) => outlineJumpRef.current?.(line)}
                    />
                  )}
                  <div className="learning-panel">
                    <div className="lp-status">
                      {!activeCard && <div className="lp-status-row"><b>复习</b><span className="muted">未学习</span></div>}
                      {activeCard && <div className="lp-status-row"><b>复习</b><span>{activeDueText}</span></div>}
                      {activeMistake && <div className="lp-status-row"><b>错题</b><span className="badge-bad">错 {activeMistake.count} 次</span></div>}
                      {Array.isArray(activeExam) && activeExam.length > 0 && <div className="lp-status-row"><b>真题</b><span className="badge-exam">{activeExam.join('、')}</span></div>}
                    </div>
                  </div>
                  {vault.currentBacklinks.length === 0 && (
                    <p className="muted">暂无笔记引用当前笔记。在其他笔记里输入 [[笔记名]] 即可建立链接。</p>
                  )}
                  {vault.currentBacklinks.map((p) => {
                    const c = vault.docs.get(p) ?? '';
                    const { title } = parseFrontmatterCached(p, c);
                    const label = title || p.replace(/\.md$/, '').split('/').pop() || p;
                    return (
                      <div key={p} className="backlink-item" onClick={(e) => openNote(p, undefined, e.currentTarget)} {...clickable(`打开反向链接笔记：${label}`)}>
                        {label}
                        <span className="muted"> · {p}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          /* 欢迎页不套卡片：直接落在背景上，并按整片工作区居中（不被左侧目录卡片挤偏）。
             pointer-events 交给内层内容，保证目录卡片仍可点击。 */
          <div className="welcome-stage">
            <Preview
              content={null}
              resolve={vault.resolveLink}
              onOpenLink={handleOpenLink}
              readFile={readFile}
              onSearch={() => setSearchOpen(true)}
              onGraph={() => setGraphOpen(true)}
            />
          </div>
        )}
      </div>
      )}
      {searchOpen && (
        <Suspense fallback={null}>
          <QuickSearch
            open={searchOpen}
            docs={vault.docs}
            recents={recents}
            onClose={() => setSearchOpen(false)}
            onOpenPath={openNote}
          />
        </Suspense>
      )}
      {reviewOpen && (
        <ReviewView
          paths={notePaths}
          docs={vault.docs}
          resolve={vault.resolveLink}
          onOpenLink={handleOpenLink}
          onClose={() => setReviewOpen(false)}
          onAskAi={askAgent}
          onOpenPath={(p) => {
            setReviewOpen(false);
            openNote(p);
          }}
        />
      )}
      {mistakeOpen && (
        <MistakeBook
          onOpenPath={(p) => {
            setMistakeOpen(false);
            openNote(p);
          }}
          onClose={() => setMistakeOpen(false)}
          onAskAi={askAgent}
        />
      )}
      {graphOpen && (
        <Suspense fallback={<div className="loading">图谱加载中…</div>}>
          <GraphView
            docs={vault.docs}
            linkIndex={vault.linkIndex}
            resolveLink={vault.resolveLink}
            onOpenPath={(p) => {
              setGraphOpen(false);
              openNote(p);
            }}
            onClose={() => setGraphOpen(false)}
          />
        </Suspense>
      )}
      {mindOpen && vault.currentPath && (
        <Suspense fallback={<div className="loading">思维导图加载中…</div>}>
          <MindMapView
            content={draft ?? ''}
            title={vault.currentPath.replace(/\.md$/, '').split('/').pop()!}
            noteKey={vault.currentPath}
            onAskAi={askAgent}
            onClose={() => setMindOpen(false)}
            onOpenWiki={handleOpenLink}
            onSaveNote={(md) => {
              const path = vault.currentPath;
              if (!path) return;
              setDraft(md);
              // 写成功才清脏点：写失败时脏点留着，自动保存会继续重试
              void vault.save(path, md)
                .then(() => setDirty(false))
                .catch((e) => toast(`思维导图保存失败：${(e as Error).message}`, 'err'));
            }}
          />
        </Suspense>
      )}
      {quizOpen && (
        <Suspense fallback={<div className="loading">题库加载中…</div>}>
          <QuizView
            docs={vault.docs}
            resolveLink={vault.resolveLink}          onOpenPath={(p) => openNote(p)}
            onClose={() => setQuizOpen(false)}
            onAskAi={askAgent}
            onOpenExam={(name) => { setExamBank(name); setExamOpen(true); }}
            resolveAsset={readFile}
            onUnifiedImport={() => setImportOpen(true)}
            refreshToken={qbankRefresh}
          />
        </Suspense>
      )}
      {examOpen && (
        <Suspense fallback={<div className="loading">考试中心加载中…</div>}>
          <ExamCenter
            initialBank={examBank}
            onClose={() => { setExamOpen(false); setExamBank(undefined); }}
          />
        </Suspense>
      )}
      {todoOpen && (
        <TodoView
          onClose={() => setTodoOpen(false)}
          docs={vault.docs}
          onOpenPath={(p) => { setTodoOpen(false); openNote(p); }}
          onSaveNote={(path, content) => vault.save(path, content)}
        />
      )}
      {tagOpen && <TagBrowser docs={vault.docs} onOpenPath={(p) => { setTagOpen(false); openNote(p); }} onClose={() => setTagOpen(false)} />}
      {dashOpen && (
        <Dashboard
          docs={vault.docs}
          onClose={() => setDashOpen(false)}
          onOpenReview={() => { setDashOpen(false); setReviewOpen(true); }}
          onOpenQuiz={() => { setDashOpen(false); setQuizOpen(true); }}
          onOpenExam={() => { setDashOpen(false); setExamBank(undefined); setExamOpen(true); }}
        />
      )}
      {/* 学习报告：模态面板，遮罩与 Dashboard / 错题本同一套（面板自己渲染 .panel-backdrop）。
          report 为空时不渲染——还没点过入口或上次聚合失败都不该弹空壳。
          范围切换走 changeReportRange（事件里重算），busy 时按钮 disabled。 */}
      {reportOpen && report && (
        <StudyReportPanel
          report={report}
          range={reportRange}
          busy={reportBusy}
          onRangeChange={changeReportRange}
          onClose={() => setReportOpen(false)}
          onCopy={handleCopyReport}
        />
      )}
      {aiOpen && <AiPanel onClose={() => setAiOpen(false)} />}
      {agentOpen && (
        <AiAgentPanel
          onClose={() => setAgentOpen(false)}
          docs={vault.docs}
          onSave={async (path, content) => {
            await vault.save(path, content);
            // AI 改的就是当前打开的这篇：编辑器缓冲必须跟着换。
            // 不换的后果实测过（浏览器里可复现）：编辑器仍显示旧正文，用户随后随便敲一个字，
            // 0.8s 的自动保存就把 AI 刚写进去的整段改动顶回旧内容——AI 的版本只能去「历史版本」里找。
            // 缓冲是脏的（用户正在手打）就不动它：那是用户正在写的东西，改成提示一句，
            // 让他自己决定是丢掉手改还是先另存（AI 的版本已经在历史版本里）。
            const cur = editRef.current;
            if (cur.vault.currentPath !== path) return;
            if (!cur.dirty) setDraft(content);
            else toast('这篇笔记刚被 AI 改写；编辑器里还有未保存的手改，保存后会覆盖 AI 的版本（可在「历史版本」找回）', 'info');
          }}
          onOpenPath={(p) => openNote(p)}
          currentPath={vault.currentPath}
          resolveLink={vault.resolveLink}
          quote={agentQuote}
          onQuoteConsumed={() => setAgentQuote(null)}
        />
      )}
      {noticeOpen && <SafetyNotice onClose={() => setNoticeOpen(false)} />}
      {draftOpen && (
        <DraftGen
          initialText={draftText}
          onSave={async (dir, title, content) => {
            const path = dir ? `${dir}/${title}.md` : `${title}.md`;
            await vault.save(path, content);
            openNote(path);
            return path;
          }}
          onClose={() => { setDraftOpen(false); setDraftText(''); }}
        />
      )}
      {pdfOpen && (
        <Suspense fallback={<div className="loading">PDF 加载中…</div>}>
          <PdfSplitView
            noteTargets={noteTargets}
            onSave={async (dir, title, content) => {
              const path = dir ? `${dir}/${title}.md` : `${title}.md`;
              await vault.save(path, content);
              openNote(path);
              return path;
            }}
            onAppend={async (path, excerpt) => {
              const existing = vault.docs.get(path);
              if (existing === undefined) throw new Error('目标笔记不存在，可能已被删除');
              await vault.save(path, appendExcerpt(existing, excerpt));
              openNote(path);
              return path;
            }}
            onClose={() => setPdfOpen(false)}
          />
        </Suspense>
      )}
      {historyOpen && (
        <Suspense fallback={<div className="loading">快照加载中…</div>}>
          <HistoryPanel
            currentPath={vault.currentPath}
            existingPaths={existingPathSet}
            onRestore={async (path, content) => {
              await vault.save(path, content);
              openNote(path);
            }}
            onClose={() => setHistoryOpen(false)}
          />
        </Suspense>
      )}
      {convertOpen && (
        <Suspense fallback={<div className="loading">转换器加载中…</div>}>
          {/* onAttach：内嵌图片落库走与编辑器贴图同一个入口（vault.saveAttachment → _attachments/），
              笔记正文里的 ![](_attachments/…) 才能被 readFile 解析成可渲染的图。 */}
          <ConvertView
            onAttach={vault.saveAttachment}
            onSave={async (dir, title, content) => {
              const path = dir ? `${dir}/${title}.md` : `${title}.md`;
              await vault.save(path, content);
              openNote(path);
              return path;
            }}
            onClose={() => setConvertOpen(false)}
          />
        </Suspense>
      )}
      {importOpen && (
        <Suspense fallback={<div className="loading">导入面板加载中…</div>}>
          {/* 统一导入：一个入口吃掉笔记备份 / 知识包 / 题库 / 数据集 / Anki / Word·PDF / Excel。
              四条回调全部转发到**既有**通道（vault.importBackup / importMdFiles / handleImportPack /
              saveAttachment），不新开写盘路径，联动与老入口完全一致。 */}
          <ImportView
            onImportBackup={(t) => vault.importBackup(t)}
            onImportMd={(files) => vault.importMdFiles(files)}
            onImportPack={handleImportPack}
            onAttach={vault.saveAttachment}
            onClose={() => { setImportOpen(false); setQbankRefresh((n) => n + 1); }}
          />
        </Suspense>
      )}
      {brainOpen && (
        <Suspense fallback={<div className="loading">脑图谱加载中…</div>}>
          <BrainAtlasView onClose={() => setBrainOpen(false)} />
        </Suspense>
      )}
      {anatomyOpen && (
        <div className="panel panel--full anatomy-overlay">
          <div className="panel__head anatomy-topbar">
            <button className="btn-small" onClick={() => setAnatomyOpen(false)}>← 返回</button>
            <span className="panel__title">3D 解剖图谱</span>
            <span className="panel__actions muted">{anatomyManifest ? anatomyManifest.organs.length : 0} 结构</span>
          </div>
          <div className="anatomy-stage" ref={setAnatomyStageEl}>
            {anatomyManifest ? (
              <Suspense fallback={<div className="anatomy-empty">3D 视口加载中…</div>}>
                <AnatomyViewer3D
                  manifest={anatomyManifest}
                  selectedId={anatomySelected?.organ_id ?? null}
                  onSelect={handleAnatomySelect}
                />
              </Suspense>
            ) : (
              <div className="anatomy-empty">3D 视口 · 数据加载中…</div>
            )}
            {anatomySelected && !anatomyCardClosed && (
              <AnatomyNoteCard
                organ={anatomySelected}
                anchor={anatomyCardAt}
                stage={anatomyStageEl}
                resolve={vault.resolveLink}
                readFile={readFile}
                onOpenNote={handleAnatomyOpenNote}
                onMakeCard={(organ) => void handleAnatomyMakeCard(organ)}
                onOpenLink={handleOpenLink}
                onClose={() => setAnatomyCardClosed(true)}
              />
            )}
          </div>
          <Suspense fallback={<div className="anatomy-empty">结构列表加载中…</div>}>
            <AnatomyBrowser
              manifest={anatomyManifest}
              selectedId={anatomySelected?.organ_id ?? null}
              onSelectStructure={handleAnatomySelect}
              onOpenNote={handleAnatomyOpenNote}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
