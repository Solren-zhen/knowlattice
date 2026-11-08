/**
 * 三栏主界面（M1~M3）：章节树 | 编辑器 | 预览 + 反链面板 + Ctrl+K 快速搜索。
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useVault } from '../core/vault';
import { getBindings, matchesBinding } from '../core/keybindings';
import { isTauri } from '../storage/tauriEnv';
import { noteTemplate, parseFrontmatterCached, type NoteType } from '../core/parser';
import type { CourseOutline, CourseVideoTarget } from '../core/courseNotes';
import { appendExcerpt } from '../core/noteGen';
import { loadCards, noteStatus, srsStats } from '../core/srs';
import { parseOutline, splitHeadingAnchor, headingLineByAnchor } from '../core/outline';
import { splitBlockTarget } from '../core/blockAnchor';
import { isImagePath } from '../core/imageRef';
import { imageEntries } from '../core/imageLib';
import OutlinePanel from './OutlinePanel';
// 题目批注条：题库里写的选项批注，落到对应章节笔记上显示（见 core/qbankAnnotations.ts）
import ChapterAnnotations from './ChapterAnnotations';
// 音频条 + 字幕轨：打开笔记就可能用到，依赖很小（core/subtitle + icons），不单独拆 chunk
import MediaTrack from './MediaTrack';
import VideoNoteView from './VideoNoteView';
import { mediaKeyOf, parseBilibili, parseVideoSource, withStart } from '../core/videoSource';
import { buildCards } from '../core/srsCards';
import { getMistake, loadMistakes, reasonCounts } from '../core/mistakes';
import { loadBanks } from '../core/qbank';
import { loadCursor } from '../core/quizCursor';
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
import HomeView from './HomeView';
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
const MedRefView = lazy(() => import('./MedRefView'));
const CourseWorkshopView = lazy(() => import('./CourseWorkshopView'));
// 资料生成：素材 → AI 大纲 → 分节讲义（anydoc/ mammoth / pdfjs 都懒加载在 core 内部）
const MatGenView = lazy(() => import('./MatGenView'));
const WordDrillView = lazy(() => import('./WordDrillView'));
// 思维导图懒加载（mind-elixir 依赖较大，打开时才加载）
const MindMapView = lazy(() => import('./MindMapView'));
// 重依赖视图懒加载：force-graph / mammoth+xlsx / PDF.js 都很大，按需加载
const GraphView = lazy(() => import('./GraphView'));
const QuizView = lazy(() => import('./QuizView'));
const ExamCenter = lazy(() => import('./ExamCenter'));
const PdfSplitView = lazy(() => import('./PdfSplitView'));
// 格式转换懒加载：mammoth + turndown + pdfjs 都较大，打开面板时才加载
const ConvertView = lazy(() => import('./ConvertView'));
// 图片库：轻量（只有一个面板），但也保持与其他面板一致的懒加载口径
const ImageLibrary = lazy(() => import('./ImageLibrary'));
/** 数据自检是低频维护入口：按需加载，不占首屏主包 */
const IntegrityView = lazy(() => import('./IntegrityView'));
// 统一导入面板：懒加载（内部按需引入 mammoth / SheetJS / jszip 等重依赖）
const ImportView = lazy(() => import('./ImportView'));
// 历史版本面板：快照读取/恢复
const HistoryPanel = lazy(() => import('./HistoryPanel'));
import AiPanel from './AiPanel';
import type { QuoteSelection } from './agentChat';
// AI 笔记（pi-agent-core）与智能草稿（pdfjs + OCR，近 1MB）都很大：静态引入会把它们塞进首屏包。
// 与其余面板同一口径：打开时才下载各自 chunk。
const AiAgentPanel = lazy(() => import('./AiAgentPanel'));
const DraftGen = lazy(() => import('./DraftGen'));
// 待办与学习统计是两块大面板（TodoView 含专注/统计子视图，Dashboard 含雷达图与周报），
// 静态引入会把它们塞进首屏主包；改成按需加载后主包体积回到预算内。
const TodoView = lazy(() => import('./TodoView'));
const Dashboard = lazy(() => import('./Dashboard'));
import TagBrowser from './TagBrowser';
import SafetyNotice from './SafetyNotice';
// 学习报告面板：小面板（无重依赖），与 Dashboard / SafetyNotice 一样直接静态引入
import StudyReportPanel from './StudyReportPanel';
// 命令面板与生词本都是轻量面板（无重依赖），静态引入：Ctrl+Shift+P 要零延迟
import CommandPalette, { type PaletteCommand } from './CommandPalette';
import VocabView from './VocabView';
import ReciteView from './ReciteView';
import {
  IconSave, IconTrash, IconChevron, IconBack, IconFwd, IconSearch,
  IconFolder, IconLink, IconClose, IconPlay, IconChart, IconImage,
} from './icons';
import Rail from './Rail';
import { prefetchIdle, prefetchPanel } from './panelPrefetch';
import { RAIL_INDEX, RAIL_PRIMARY_KEYS, type RailKey } from './railCatalog';
import {
  RAIL_MODAL,
  activeRailOf,
  buildRailOrder,
  loadRecentFeatures,
  pushRecentFeature,
  saveRecentFeatures,
} from './featureRouting';
import SettingsPanel from './SettingsPanel';
import { useDockSplit, type DockSplit } from './useDockSplit';
import { usePanelState } from './usePanelState';
import { MODAL_IDS } from './panelRegistry';
import { usePanelDrag } from './usePanelDrag';
import { useDeckSplit } from './useDeckSplit';
import { clickable } from './a11y';
import { toast, confirmBox } from '../core/feedback';
import { printMarkdown } from '../core/printDoc';
import { lastReciteOf, recordRecite, type ReciteSession } from '../core/reciteLog';
import { morphFrom, MORPH } from '../core/viewMorph';
import Pet from './Pet';
import PetCustomizer from './PetCustomizer';

const RECENTS_KEY = 'knowlattice-recents';

/** 命令面板的动作清单：顺序就是面板里的默认顺序（重要的先露脸）。
 *  只放「打开某个面板」这类无需参数的动作——需要选中内容才能执行的动作进编辑器右键菜单。 */
function PALETTE_COMMANDS(a: Record<
  'search' | 'importOpen' | 'quiz' | 'exam' | 'review' | 'mistakes' | 'dashboard' | 'tags'
  | 'todos' | 'mind' | 'graph' | 'brain' | 'anatomy' | 'medref' | 'pdf' | 'convert' | 'vocab' | 'notice'
  | 'save' | 'backup' | 'video' | 'split' | 'images' | 'print'
  | 'history' | 'ai' | 'agent' | 'draft' | 'matgen',
  () => void
>): PaletteCommand[] {
  return [
    { id: 'search', title: '搜索笔记 / 全文', group: '笔记', aliases: ['查找', 'search', 'ctrl+k'], run: a.search },
    { id: 'save', title: '保存当前笔记', group: '笔记', aliases: ['save', '存盘', 'ctrl+s'], run: a.save },
    { id: 'print', title: '打印当前笔记 / 存为 PDF', group: '笔记', aliases: ['print', '打印', 'pdf', '导出'], run: a.print },
    { id: 'backup', title: '备份到 .json（整包）', group: '工具', aliases: ['backup', '导出备份', '换设备'], run: a.backup },
    { id: 'import', title: '导入（统一入口）', group: '工具', aliases: ['import', '导入内容包', '备份'], run: a.importOpen },
    { id: 'quiz', title: '题库练习', group: '题库', aliases: ['刷题', 'quiz'], run: a.quiz },
    { id: 'exam', title: '模拟考试', group: '题库', aliases: ['exam', '考试'], run: a.exam },
    { id: 'mistakes', title: '错题本', group: '题库', aliases: ['错题', 'wrong'], run: a.mistakes },
    { id: 'review', title: '间隔复习', group: '题库', aliases: ['复习', 'srs', 'memory'], run: a.review },
    { id: 'vocab', title: '生词本', group: '题库', aliases: ['单词', 'vocab', '术语'], run: a.vocab },
    { id: 'dashboard', title: '学习报告', group: '面板', aliases: ['统计', '仪表盘', 'dashboard'], run: a.dashboard },
    { id: 'tags', title: '标签浏览', group: '面板', aliases: ['tag'], run: a.tags },
    { id: 'todos', title: '待办', group: '面板', aliases: ['todo', '任务'], run: a.todos },
    { id: 'mind', title: '思维导图', group: '资料', aliases: ['mindmap', '脑图'], run: a.mind },
    { id: 'graph', title: '知识图谱', group: '资料', aliases: ['graph', '关系图'], run: a.graph },
    { id: 'brain', title: '脑图谱', group: '资料', aliases: ['brain', '神经'], run: a.brain },
    { id: 'anatomy', title: '3D 解剖', group: '资料', aliases: ['anatomy', '解剖'], run: a.anatomy },
    { id: 'medref', title: '医学速查', group: '资料', aliases: ['medref', '速查', '术语', '症状', '口诀'], run: a.medref },
    { id: 'matgen', title: '资料生成（素材 → 复习讲义）', group: '资料', aliases: ['matgen', '讲义', '资料生成', '复习资料'], run: a.matgen },
    { id: 'images', title: '图片库（附件里的图片）', group: '资料', aliases: ['image', '图片', '插图', '附件'], run: a.images },
    { id: 'video', title: '视频笔记（时间点 / 复读 / 收藏）', group: '工具', aliases: ['video', '视频', '时间点', '锚点', '复读'], run: a.video },
    { id: 'split', title: '右侧分屏：编辑与预览并排', group: '面板', aliases: ['split', '分屏', '对照', '预览'], run: a.split },
    { id: 'pdf', title: 'PDF 对照', group: '工具', aliases: ['pdf', '拆分', '对照'], run: a.pdf },
    { id: 'convert', title: '格式转换', group: '工具', aliases: ['convert', 'docx', 'xlsx'], run: a.convert },
    { id: 'history', title: '历史版本', group: '笔记', aliases: ['history', '版本', '回溯'], run: a.history },
    { id: 'ai', title: 'AI 问答', group: '工具', aliases: ['ai', '问答'], run: a.ai },
    { id: 'agent', title: 'AI 笔记', group: '工具', aliases: ['agent', '笔记助手'], run: a.agent },
    { id: 'draft', title: '智能草稿', group: '工具', aliases: ['draft', '草稿', '续写'], run: a.draft },
    { id: 'notice', title: '安全与隐私说明', group: '工具', aliases: ['notice', '隐私'], run: a.notice },
  ];
}


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

/**
 * 整栏的分隔条：两块同开时夹在视频与 AI 笔记之间（上下拖 = 两块按总高互换），
 * 只开一块时贴在该块的上沿（上下拖 = 直接改这一块的高度）。方向由 useDockSplit 按实际位置量。
 */
function DockSplitHandle({ dockSplit }: { dockSplit: DockSplit }) {
  return (
    <div
      className="dock-col__split"
      role="separator"
      aria-orientation="horizontal"
      tabIndex={0}
      aria-label="上下拖动调整高度（方向键微调，双击复位）"
      title="上下拖动调整高度；双击复位"
      onPointerDown={dockSplit.onSplitDown}
      onPointerMove={dockSplit.onMove}
      onPointerUp={dockSplit.onUp}
      onPointerCancel={dockSplit.onUp}
      onKeyDown={dockSplit.onKeyDown('h')}
      onDoubleClick={dockSplit.reset}
    />
  );
}

export default function Workspace() {
  const vault = useVault();
  /** 面板开关的唯一状态容器（28 个开关收在一处，见 usePanelState） */
  const panels = usePanelState();
  /**
   * 写操作的稳定引用。`panels` 对象本身每帧都是新的（`is` 依赖当前集合），
   * 直接把它放进 `useCallback` / `useEffect` 的依赖数组会让回调每次失效；
   * 这两个函数引用永久稳定，可以安全入依赖。
   */
  const openPanel = panels.open;
  const closePanel = panels.close;
  const [draft, setDraft] = useState<string | null>(null); // 编辑中内容（未保存）
  const [dirty, setDirty] = useState(false);
  const [showBacklinks, setShowBacklinks] = useState(() => window.matchMedia?.('(max-width: 980px)').matches !== true);
  /** 统一导入面板关闭后自增：题库练习面板据此重读题库列表。
   *  统一入口可以从「题库练习」里打开，导入的题库必须在那块面板上立刻出现。 */
  const [qbankRefresh, setQbankRefresh] = useState(0);
  /** 从题库列表点「模拟考试」进来时的预选题库 */
  const [examBank, setExamBank] = useState<string | undefined>(undefined);
  /** 从错题本「重做本组」进来时要重做的笔记路径集合；非空 = 考试中心直接开一场错题重练 */
  const [examSeed, setExamSeed] = useState<string[] | undefined>(undefined);
  /** 全局搜索 → 题库的联动参数：带入关键词，题库打开即显示搜题结果 */
  const [quizSeed, setQuizSeed] = useState('');
  /** 从视频笔记「返回课程工坊」时带入的 BV；导轨直接打开时清空 */
  const [courseInitialBvid, setCourseInitialBvid] = useState<string | undefined>(undefined);
  /** 已读取过的课程大纲（按 bvid）：关掉工坊后视频笔记仍能显示课程名/分P名 */
  const [courseMetas, setCourseMetas] = useState<Record<string, CourseOutline>>({});
  const rememberCourse = useCallback((meta: CourseOutline) => {
    setCourseMetas((prev) => {
      const cur = prev[meta.bvid];
      if (
        cur &&
        cur.title === meta.title &&
        cur.parts.length === meta.parts.length &&
        cur.parts.every((p, i) => p.page === meta.parts[i]?.page && p.part === meta.parts[i]?.part)
      ) {
        return prev;
      }
      return { ...prev, [meta.bvid]: meta };
    });
  }, []);
  /** 编辑器「问 AI」桥接：选段暂存，面板打开后由 quote prop 交给 AiAgentPanel 消费 */
  const [agentQuote, setAgentQuote] = useState<QuoteSelection | null>(null);
  /** 一键导师：首页「导师陪练」把开场白交给面板，面板消费后清空（与 agentQuote 同一套桥接） */
  const [agentSeed, setAgentSeed] = useState<{ text?: string; tutor: boolean } | null>(null);
  const [draftText, setDraftText] = useState('');
  /**
   * 「视频是被 AI 问答面板临时挤掉的」标记：AI 问答（.ai-panel）与这一栏都贴右边缘，
   * 同时开会完全重叠，所以打开它就先把视频收起；但它一关（含切到 AI 笔记）要原样还回来——
   * 否则用户从「AI 助手 → 笔记助手」进来，视频窗口就永久消失了（用户实测反馈）。
   */
  const videoHiddenByAi = useRef(false);
  /** 视频 + AI 笔记共用一栏的尺寸：整栏宽度 & 视频那块的高度（见 useDockSplit） */
  const dockSplit = useDockSplit();
  /** 整栏可移动：拖视频标题栏挪位置（位置持久化，双击标题栏复位） */
  const dockDrag = usePanelDrag('dock-col');
  /** 工作区三列宽度：目录 / 编辑 / 关联（见 useDeckSplit，宽度持久化） */
  const deckSplit = useDeckSplit();
  // 稳定引用：usePanelDrag 的 reset 是 useCallback，不会每帧换
  const resetDockPos = dockDrag.reset;
  /**
   * 存下来的位移可能来自更宽的窗口、或更早一次拖动：首帧若整栏几乎跑出视口就复位。
   * 否则会出现「面板贴在编辑区中间、又找不到抓手」的状态（用户实测反馈过）。
   */
  /** 右侧那一栏（视频 / AI 笔记）当前是否可见：effect 的依赖必须是可静态检查的值 */
  const dockVisible = panels.is('video') || panels.is('agent');
  useEffect(() => {
    if (!dockVisible) return;
    const el = document.querySelector<HTMLElement>('.dock-col');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const outside = r.right < 80 || r.left > window.innerWidth - 80
      || r.bottom < 80 || r.top > window.innerHeight - 80;
    if (outside) resetDockPos();
  }, [dockVisible, resetDockPos]);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoMedia, setVideoMedia] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [videoSeek, setVideoSeek] = useState<number | null>(null);
  /** 视频栏打开着且是 B 站：解析出 bvid + 分P，供课程联动用 */
  const videoOpen = panels.is('video');
  const videoBiliRef = useMemo(
    () => (videoOpen && videoSrc ? parseBilibili(videoSrc) : null),
    [videoOpen, videoSrc],
  );
  /**
   * 当前视频对应的课程笔记。课程笔记的 frontmatter 里 `source` 就是
   * `https://www.bilibili.com/video/BV...`（buildCourseFrontmatter 写的），
   * 用 source 反解 bvid，不要求笔记里另存一个 bvid 字段。
   */
  const courseNoteByBvid = useMemo(() => {
    const bvid = videoBiliRef?.bvid;
    if (!bvid) return null;
    for (const [path, content] of vault.docs) {
      if (!path.endsWith('.md')) continue;
      const parsed = parseFrontmatterCached(path, content);
      if (!parsed.meta.source) continue;
      if (parseBilibili(parsed.meta.source)?.bvid === bvid) {
        return {
          path,
          title: parsed.title || path.replace(/\.md$/, '').split('/').pop() || path,
        };
      }
    }
    return null;
  }, [videoBiliRef, vault.docs]);
  /** 传给视频笔记的课程上下文：有名册（本次会话读过）或已保存的课程笔记才显示 */
  const videoCourse = useMemo(() => {
    const bvid = videoBiliRef?.bvid;
    if (!bvid) return null;
    const note = courseNoteByBvid;
    const outline = courseMetas[bvid];
    if (!note && !outline) return null;
    const page = videoBiliRef.page;
    return {
      bvid,
      page,
      courseTitle: outline?.title || note?.title || '',
      part: outline?.parts.find((p) => p.page === page)?.part,
      notePath: note?.path,
      noteTitle: note?.title,
    };
  }, [videoBiliRef, courseNoteByBvid, courseMetas]);
  const videoInputRef = useRef<HTMLInputElement>(null);
  /** 外部来源（B站/抖音/网盘）的原始页地址，锚点靠它在浏览器里定位 */
  const videoPageRef = useRef<string | null>(null);
  /**
   * 当前 blob 地址。必须自己记账：`URL.createObjectURL` 的句柄不会随 state 消失而回收，
   * 一个视频几十到几百 MB。之前只在「再选一个本地文件」时释放上一个，
   * 选完本地文件再粘一个 B 站链接就把旧的漏掉了（那条路径直接 setVideoSrc 覆盖）。
   */
  const videoBlobRef = useRef<string | null>(null);
  const releaseVideoBlob = useCallback(() => {
    const prev = videoBlobRef.current;
    videoBlobRef.current = null;
    if (prev) URL.revokeObjectURL(prev);
  }, []);
  // 卸载时收尾（整库重载 / 关窗）：留着也没人再读它了
  useEffect(() => () => releaseVideoBlob(), [releaseVideoBlob]);

  /**
   * 打开视频面板。给了 file 就换成 blob 地址（本地文件不走网络）；
   * 不给则只把面板叫出来，让用户点「换视频」。
   */
  const openVideo = (file?: File) => {
    if (file) {
      releaseVideoBlob();
      const url = URL.createObjectURL(file);
      videoBlobRef.current = url;
      setVideoSrc(url);
      videoPageRef.current = null;
      // 片段归属键：浏览器 file API 拿不到真实路径，只用文件名会让两个目录下同名、
      // 内容不同的视频共用同一份片段清单（点进去跳到另一个视频）。
      // 加上大小与修改时间后碰撞概率接近零，同一次选同一个文件仍然稳定。
      setVideoMedia(`${file.name}|${file.size}|${file.lastModified}`);
      setVideoTitle(file.name);
      setVideoSeek(null);
    }
    panels.open('video');
  };

  /**
   * 打开一个视频链接（B站 / 抖音 / 网盘 / 直链）。识别结果决定面板怎么放它：
   * 能内嵌的给播放器，不能的把原页地址记下来（锚点靠它开浏览器定位）。
   */
  const openVideoUrl = (url: string, opts: { title?: string; seekTo?: number | null } = {}) => {
    const source = parseVideoSource(url);
    videoPageRef.current = source.pageUrl;
    releaseVideoBlob();
    setVideoSrc(source.playUrl ?? source.pageUrl ?? url);
    setVideoMedia(mediaKeyOf(source, url));
    setVideoTitle(opts.title || source.title);
    setVideoSeek(opts.seekTo ?? null);
    panels.open('video');
    if (source.note) toast(source.note, 'info', 6000);
  };

  /** 课程工坊的分P「▶」/ 课程笔记里的 `#cw=`：关掉工坊，在视频栏打开对应分P */
  const openCourseVideo = (target: CourseVideoTarget): boolean => {
    const url = `https://www.bilibili.com/video/${encodeURIComponent(target.bvid)}?p=${target.page}`;
    const title = [target.courseTitle, `P${target.page}${target.part ? ` ${target.part}` : ''}`]
      .filter(Boolean)
      .join(' · ');
    panels.close('course');
    openVideoUrl(url, { title: title || undefined, seekTo: target.seconds ?? null });
    return true;
  };

  /** 视频笔记「返回课程工坊」：带 bvid，工坊优先用内存会话恢复；没有会话再重新读取 */
  const openCourseFromVideo = (bvid: string) => {
    panels.close('video');
    setCourseInitialBvid(bvid);
    panels.open('course');
  };

  /**
   * 点笔记里的锚点：能读进度的直接跳；B站在面板里重载 iframe；抖音/网盘开浏览器定位。
   * 什么都没选中时只把面板叫出来——此时点锚点不该悄悄开一个新标签页。
   */
  const jumpVideoAnchor = (seconds: number): boolean => {
    const source = parseVideoSource(videoSrc ?? '');
    if (videoSrc && (source.seekable || source.kind === 'bilibili')) {
      setVideoSeek(seconds);
      panels.open('video');
      return true;
    }
    const page = videoPageRef.current ?? source.pageUrl;
    if (page) {
      window.open(withStart(page, seconds), '_blank', 'noopener');
      return true;
    }
    openVideo();
    toast('已打开视频面板（锚点 ' + seconds + ' 秒）：先选视频或粘贴链接', 'info', 5200);
    return true;
  };
  /** 编辑器注册的「在光标处插入 Markdown」句柄（PDF 摘录与「插入图片」共用；
   *  插入时会自动补前后空行，见 Editor 里注册的那段） */
  const editorInsertRef = useRef<((markdown: string) => void) | null>(null);
  /** 从磁盘插入图片用的文件选择框 */
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** 目录卡片显隐（导航轨「目录」按钮切换，窄屏可收起给正文让位） */
  const [treeOpen, setTreeOpen] = useState(() => window.matchMedia?.('(max-width: 700px)').matches !== true);
  /**
   * 目录卡片「收起成窄条」：与 treeOpen 是两件事——treeOpen 是整张卡片在不在，
   * 这个是卡片在、但只留一条 44px 宽的边（点一下展开）。收起时宽度只改 --tree-w，
   * 首页/正文的让位偏移与所有断点规则都跟着那一个变量走，不需要另写一套。
   */
  const [treeCollapsed, setTreeCollapsed] = useState(() => {
    try { return localStorage.getItem('knowlattice.tree.collapsed') === '1'; } catch { return false; }
  });
  const setTreeCollapsedPersist = useCallback((v: boolean) => {
    setTreeCollapsed(v);
    try { localStorage.setItem('knowlattice.tree.collapsed', v ? '1' : '0'); } catch { /* 隐私模式：本次会话内仍生效 */ }
  }, []);
  /** 首页「新建笔记」快捷入口的触发信号：自增一次，目录卡片里的新建表单打开一次 */
  const [newNoteSignal, setNewNoteSignal] = useState(0);
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
  /** 编辑器注册的「跳转到行」实现（本页目录点击用），模式同 editorInsertRef */
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

  /**
   * 打印当前笔记（在系统对话框里选「另存为 PDF」就是导出）。
   * 走 editRef 而不是闭包里的 vault/draft：Ctrl+P 的监听只挂一次，
   * 用闭包会一直打印「注册监听那一刻的那篇笔记」。
   */
  const printCurrentNote = useCallback(() => {
    const { vault: v, draft: d } = editRef.current;
    if (!v.currentPath || d === null) {
      toast('先打开一篇笔记，再点打印', 'info', 4000);
      return;
    }
    const name = v.currentPath.replace(/^.*\//, '').replace(/\.md$/i, '');
    // 图片是 vault 相对路径，打印用的 iframe 没有基址 → 先换成可显示地址
    void printMarkdown(name, d, { resolveImage: (src) => v.readFile(src) }).then((ok) => {
      if (!ok) toast('这个环境不支持打印：请用桌面版，或允许浏览器打印', 'err', 6000);
    });
  }, []);

  /**
   * 把一道题写成笔记：建在「题库笔记/<题库>/」下。
   * 同名不是覆盖而是另存带时间的副本——那篇很可能是用户已经改过的，
   * 静默覆盖等于把笔记正文扔掉，是这里唯一不可逆的操作。
   */
  const saveQuestionNote = useCallback(async (path: string, markdown: string) => {
    const v = editRef.current.vault;
    const cut = path.lastIndexOf('/');
    const dir = cut > 0 ? path.slice(0, cut) : '';
    const title = path.slice(cut + 1).replace(/.md$/i, '');
    const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
    try {
      const made = await v.createNote(dir, title, markdown);
      toast(`已写成笔记：${made}`, 'ok', 4000);
    } catch {
      try {
        const made = await v.createNote(dir, `${title} ${stamp}`, markdown);
        toast(`同名笔记已存在，另存为：${made}`, 'ok', 5000);
      } catch (e2) {
        toast(`写成笔记失败：${(e2 as Error).message}`, 'err', 6000);
      }
    }
  }, []);

  // 全局快捷键：键位来自 core/keybindings（设置页可改），事件发生时现读一次，改完立即生效
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 编辑器里的 Mod-<键> 绑定会先 preventDefault：全局快捷键只认「正好命中」，
      // 不抢已被处理的按键，避免编辑器里的快捷键被这里顺手当成搜索。
      if (e.defaultPrevented) return;
      const keys = getBindings();
      if (matchesBinding(e, keys.search)) {
        e.preventDefault();
        openPanel('search');
        return;
      }
      if (matchesBinding(e, keys.palette)) {
        e.preventDefault();
        openPanel('palette');
        return;
      }
      if (matchesBinding(e, keys.print)) {
        e.preventDefault();
        printCurrentNote();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openPanel, printCurrentNote]);

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

  // Alt+← / Alt+→ 后退前进（键位可在设置里改；仍在 window 上）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const keys = getBindings();
      if (matchesBinding(e, keys.back)) { e.preventDefault(); goBack(); }
      if (matchesBinding(e, keys.forward)) { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goBack, goForward]);

  // 解剖图谱 / 脑图谱的 Esc 分层退出。走全局 Esc 栈：本层在应用启动时就入栈（栈底），
  // 所以任何面板打开时 Esc 先归那个面板——不会再出现「一次 Esc 同时关掉搜索框和整个图谱」。
  useEsc(() => {
    if (panels.is('brain')) { panels.close('brain'); return; }
    if (panels.is('anatomy')) {
      // 先关笔记卡片，再关整个图谱面板：一次 Esc 只退一层，不会把 3D 一起带走
      if (anatomySelected && !anatomyCardClosed) { setAnatomyCardClosed(true); return; }
      panels.close('anatomy');
    }
  });

  /** 点击双链：存在则跳转；不存在则提示创建占位笔记（M3 灰色占位逻辑）。
   *  `[[笔记#小节]]` 还能定位：先按目标打开笔记，等大纲就绪后跳到那一节（见 pendingAnchor）。 */
  const handleOpenLink = useCallback(
    async (name: string) => {
      // 块引用 ：名字部分查笔记，id 部分交给 pendingBlock 去编辑器里定位那一行
      const { name: blockName, block } = splitBlockTarget(name);
      const { target, anchor } = splitHeadingAnchor(blockName);
      const resolved = vault.resolveLink(target);
      if (resolved) {
        openNote(resolved);
        if (block) setPendingBlock({ path: resolved, block });
        // 锚点统一交给 pendingAnchor：同一篇笔记时它下一帧就跳，跨笔记时等目标笔记的大纲就绪再跳
        else if (anchor) setPendingAnchor({ path: resolved, anchor });
        return;
      }
      if (await confirmBox({
        title: `创建「${target}」？`,
        detail: '这个双链还没有对应的笔记',
        okText: '创建',
      })) {
        void handleCreate('', target);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, openNote]
  );

  /** 打开 3D 解剖图谱（首次打开时才加载 manifest，避免启动就拉大文件） */
  const openAnatomy = useCallback(async () => {
    openPanel('anatomy');
    // 重开时卡片先收起：上次的选中结构仍在（3D 高亮保留），但不该一进来就弹卡片
    setAnatomyCardClosed(true);
    if (!anatomyManifest) {
      try {
        setAnatomyManifest(await loadAnatomyManifest());
      } catch (e) {
        toast(`解剖图谱加载失败：${(e as Error).message}`, 'err');
        closePanel('anatomy');
      }
    }
  }, [anatomyManifest, closePanel, openPanel]);

  /** 打开「智能草稿」（每次进入都清空上次残留文本） */
  const openDraft = useCallback(() => {
    setDraftText('');
    openPanel('draft');
  }, [openPanel]);

  /**
   * 从磁盘插入图片：先落进 `_attachments/`（保留原文件名，与挂音频/字幕同一口径），
   * 再在光标处插入 `![](路径)`。粘贴/拖拽之外的第二条路——手里已经有一张图、
   * 或者想批量插几张时，不必先去截图或拖窗口。
   *
   * 同名附件自动让位（`图.png` → `图-1.png`），不静默覆盖用户已有的图；
   * 避开换成任何后缀都不撞名的极端情况时宁可报错，也不回退成覆盖。
   */
  /** 附件里的图片条目：笔记目录的计数与图片库共用同一份，避免两处各算一遍 */
  const attachmentImages = useMemo(() => imageEntries(vault.attachmentPaths), [vault.attachmentPaths]);

  const insertImages = useCallback(async (files: File[]) => {
    if (!vault.currentPath) { toast('请先打开一篇笔记，再插入图片', 'info'); return; }
    // 编辑器未就绪就整批不做：落盘后却插不进正文，等于凭空多出几张没人引用的附件。
    // 收进局部常量：await 之后 ref.current 的类型守卫失效，直接调用会被 TS 判为可能为 null。
    const insert = editorInsertRef.current;
    if (!insert) { toast('编辑器还在加载，请稍后再插入图片', 'info'); return; }
    let ok = 0;
    for (const file of files) {
      // 认扩展名也认 MIME：部分系统（尤其 Linux/老旧浏览器）对 .webp/.avif 给的是空 type
      if (!file.type.startsWith('image/') && !isImagePath(file.name)) continue;
      // 附件名只用文件名本身：路径分隔符会破坏 vault 路径，前导点会变成隐藏文件
      const raw = file.name.replace(/[/\\]/g, '_').replace(/^\.+/, '_').trim();
      const ext = file.type.split('/')[1] || 'png';
      let name = raw || `image-${Date.now()}.${ext}`;
      if (vault.hasAttachment(`_attachments/${name}`)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const tail = dot > 0 ? name.slice(dot) : '';
        const free = Array.from({ length: 200 }, (_, i) => `${stem}-${i + 1}${tail}`)
          .find((cand) => !vault.hasAttachment(`_attachments/${cand}`));
        if (!free) { toast(`插入图片失败：${name} 的同名文件太多，请先改个名字`, 'err'); continue; }
        name = free;
      }
      try {
        const path = await vault.saveAttachment(name, file);
        insert(`![](${path})`);
        ok += 1;
      } catch (err) {
        toast(`插入图片失败：${(err as Error).message}`, 'err');
      }
    }
    if (ok > 1) toast(`已插入 ${ok} 张图片`, 'ok');
  }, [vault]);

  /** 回到主界面（欢迎页）：先把未保存改动落盘，再清空当前笔记。 */
  const goHome = useCallback(() => {
    flushDraft();
    setDraft(null);
    setDirty(false);
    vault.setCurrentPath(null);
  }, [flushDraft, vault]);

  const handleChange = useCallback((v: string) => {
    setDraft(v);
    setDirty(true);
  }, []);

  // 保存键（默认 Ctrl+S / Cmd+S，可在设置里改）
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (matchesBinding(e.nativeEvent, getBindings().save)) {
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
        panels.close('anatomy');
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
      panels.close('anatomy');
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
    closePanel('ai'); // 与 AI 助手面板互斥（共用同一块让位空间）
    openPanel('agent');
  }, [closePanel, openPanel]);

  /** 一键导师：首页点一下就开面板并直接开始（不用先开面板、再点芯片、再打字）。
   *  开场白由面板自己拼（reviewPlanPrompt 在 AI 那条懒加载链里），
   *  若在这里 import 会把 qbank/srs/mistakes 整条学习聚合拖进主包。 */
  const startTutor = useCallback(() => {
    setAgentSeed({ tutor: true });
    closePanel('ai');
    openPanel('agent');
  }, [closePanel, openPanel]);

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
  const pdfPanelOpen = panels.is('pdf');
  const noteTargets = useMemo(
    () =>
      pdfPanelOpen
        ? notePaths.map((path) => {
            const parsed = parseFrontmatterCached(path, vault.structureDocs.get(path) ?? '');
            return {
              path,
              title: parsed.title || path.replace(/\.md$/, '').split('/').pop() || path,
              chapter: parsed.meta.chapter,
            };
          })
        : [],
    [pdfPanelOpen, notePaths, vault.structureDocs]
  );
  const noteCount = notePaths.length;

  /* ── 首页的数据 ────────────────────────────────────────────────────────────
   * 首页只在「没有打开笔记」时出现，此时不在打字路径上：
   *   - 最近 3 篇直接从 vault.docs 取，过滤掉已删除的路径；
   *   - 到期卡数只在这一屏算一次（buildCards 要全库切卡，不能跟着每次按键跑）；
   *   - 错题数直接读 localStorage：同屏没有编辑器，不存在「每键一次」的问题。
   */
  const homeRecents = useMemo(
    () => recents
      .filter((path) => vault.docs.has(path))
      .slice(0, 3)
      .map((path) => {
        const { title } = parseFrontmatterCached(path, vault.docs.get(path) ?? '');
        return { path, title: title || path.replace(/\.md$/, '').split('/').pop() || path };
      }),
    [recents, vault.docs],
  );
  const homeDueCount = useMemo(
    () => (vault.currentPath ? 0 : srsStats(buildCards(notePaths, vault.docs)).dueNow),
    [vault.currentPath, notePaths, vault.docs],
  );
  const homeMistakeCount = vault.currentPath ? 0 : Object.keys(loadMistakes()).length;
  /** 首页「最近使用」：读回即初值；写入在 touchFeature */
  const [recentFeatures, setRecentFeatures] = useState<RailKey[]>(loadRecentFeatures);
  // 空闲预取三块最常用的重面板：只排一次、失败静默（见 panelPrefetch.ts）
  useEffect(() => {
    prefetchIdle();
  }, []);
  /** 首页「继续刷题」刚点的标记：传给 QuizView 让它挂载后自动接上一轮，处理完自己清掉 */
  const [quizAutoResume, setQuizAutoResume] = useState(false);

  /** 去处表：键与 Rail 的 RailKey 一一对应，漏一个会编译失败。
   *  导航轨与首页「最近使用」共用这一张表——同一个开关只写一遍，也只有这一个记录点。 */
  const openFeature: Record<RailKey, () => void> = {
    // 从「收起成窄条」状态重新打开时顺手展开整张卡片：否则点了「目录」只看到一条边
    tree: () => { if (!treeOpen) setTreeCollapsedPersist(false); setTreeOpen((v) => !v); },
    search: () => panels.open('search'),
    quiz: () => panels.open('quiz'),
    review: () => panels.open('review'),
    mistakes: () => panels.open('mistakes'),
    report: () => panels.open('dash'),
    todos: () => panels.open('todos'),
    // 视频笔记是浮层而非全屏面板：轨上当开关用，再点一次收起。
    // 关掉 AI 问答面板：两者都锚在右侧（.ai-panel 与 .dock-col），同时打开会完全重叠。
    // 用户自己开关视频时清掉「被 AI 临时收起」的标记：之后关掉 AI 面板不该再替他打开。
    video: () => { videoHiddenByAi.current = false; panels.toggle('video'); panels.close('ai'); },
    graph: () => panels.open('graph'),
    anatomy: () => void openAnatomy(),
    brain: () => panels.open('brain'),
    mind: () => panels.open('mind'),
    tags: () => panels.open('tags'),
    medref: () => panels.open('medref'),
    import: () => panels.open('import'),
    pdf: () => panels.open('pdf'),
    convert: () => panels.open('convert'),
    course: () => { setCourseInitialBvid(undefined); panels.open('course'); },
    matgen: () => panels.open('matgen'),
    words: () => panels.open('words'),
    history: () => panels.open('history'),
    notice: () => panels.open('notice'),
    ai: () => {
      if (panels.is('ai') || panels.is('agent') || panels.is('draft')) { panels.close('ai'); panels.close('agent'); panels.close('draft'); return; }
      panels.open('ai');
      // AI 问答与「视频 + AI 笔记」栏都锚在右侧，同时打开会互相遮挡。
      // 只临时收起视频并记下，面板关闭/切到 AI 笔记时由下面的 effect 原样还回来。
      if (panels.is('video')) { videoHiddenByAi.current = true; panels.close('video'); }
    },
    settings: () => panels.open('settings'),
  };

  /** AI 问答面板关掉（包括切到「AI 笔记」）后，把被它临时收起的视频窗口原样还回来 */
  const aiPanelOpen = panels.is('ai');
  useEffect(() => {
    if (aiPanelOpen || !videoHiddenByAi.current) return;
    videoHiddenByAi.current = false;
    panels.open('video');
  }, [aiPanelOpen, panels]);

  /** 记一次使用（LRU，最多 8 条）。第一项就是它时不写盘——避免每次点同一个按钮都落一次 localStorage。
   *  先在事件里算好 next 再 setState：副作用不放进 updater（jsdom 会执行 updater，真浏览器对
   *  「返回同一引用」直接跳过，写盘会随环境漂移）。 */
  const touchFeature = useCallback((key: RailKey) => {
    const next = pushRecentFeature(recentFeatures, key);
    if (next === recentFeatures) return;
    saveRecentFeatures(next);
    setRecentFeatures(next);
  }, [recentFeatures]);

  /**
   * 关掉除 keep 以外的全部整屏面板。
   *
   * 每个整屏面板都盖一层 position:fixed inset:0 的遮罩（走 `PanelOverlay`，
   * 少数几块自带容器：解剖/脑图谱、SafetyNotice），同一时刻只该存在一个。
   * 两个同时打开时后渲染的盖住先渲染的，关掉上面那个才会露出下面那个——
   * 用户看到的是「点了新功能没反应」，或者「关掉题库，冒出个错题本」。
   *
   * 遍历范围来自注册表（`MODAL_IDS`），不再是手写的 24 行 `modalClosers` 表：
   * 那张表每加一个面板就要记得登记一次。`modal: false` 的（目录侧栏 / AI 浮层 / 视频小窗）
   * 不在遍历范围里，它们本来就该与内容共存。
   * 关闭本来关着的面板是空操作（`withValue` 返回同一引用 → React 跳过渲染）。
   */
  const closeModals = (keep: string) => {
    for (const id of MODAL_IDS) {
      if (id === keep) continue;
      panels.close(id);
      // 考试面板带参数（预选题库 / 错题重练范围）：关掉时一并清空，否则下次从别处进考试会带着旧参数
      if (id === 'exam') { setExamBank(undefined); setExamSeed(undefined); }
    }
  };

  /** 导轨入口 → 它打开的全屏面板（表在 featureRouting：tree / ai 不在表里，
   *  目录侧栏与右侧浮层要能跟内容共存） */
  const railActions = {} as Record<RailKey, () => void>;
  for (const key of Object.keys(openFeature) as RailKey[]) {
    railActions[key] = () => {
      touchFeature(key);
      const modal = RAIL_MODAL[key];
      if (modal) closeModals(modal);
      openFeature[key]();
    };
  }

  /** 首页那一排：最近用过的去处；一条记录都没有时退回轨上的 8 个常驻项。
   *  已下架的轨道项（思维导图）在 RAIL_INDEX 里没有条目，这里直接跳过，
   *  而不是让首页为一条历史记录崩掉。 */
  const homeFeatures = (recentFeatures.length > 0 ? recentFeatures : RAIL_PRIMARY_KEYS)
    .flatMap((key) => {
      const entry = RAIL_INDEX[key];
      return entry ? [{ key, label: entry.label, icon: entry.icon }] : [];
    });
  /**
   * 首页「继续刷题」要显示的那一轮。只在欢迎页现读：编辑器每敲一个字都会重渲染，
   * 那里没必要碰 localStorage；而首页每次渲染都读一遍，练完/续完回来自然就没有了，
   * 不用再去同步一份状态。
   */
  const homeCursor = vault.currentPath ? null : loadCursor();
  const homeQuizResume = homeCursor
    ? { bank: homeCursor.bank, position: homeCursor.idx + 1, total: homeCursor.qids.length }
    : null;
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

  /** `[[笔记#小节]]` 待跳转的锚点：笔记打开后正文是异步进来的，等大纲（读草稿）就绪再跳一次 */
  const [pendingAnchor, setPendingAnchor] = useState<{ path: string; anchor: string } | null>(null);
  useEffect(() => {
    if (!pendingAnchor) return;
    if (pendingAnchor.path !== activePath || outline.length === 0) return;
    // 锚点找不到（标题被改过、或 `^块引用` 我们没有块级索引）就只打开笔记，不猜一行跳
    const line = headingLineByAnchor(outline, pendingAnchor.anchor);
    if (line !== null) outlineJumpRef.current?.(line);
    setPendingAnchor(null);
  }, [pendingAnchor, activePath, outline]);

  /** `[[笔记#^id]]` 待跳的块：等目标笔记的草稿就绪后，在编辑器里定位到含 `^id` 的那一行。
   *  不做块级索引：块 id 就写在行尾，扫一遍草稿比维护一份索引更不容易和正文脱节。 */
  const [pendingBlock, setPendingBlock] = useState<{ path: string; block: string } | null>(null);
  /** 右侧分屏：同一篇笔记的编辑与预览并排（Obsidian 的「源码 + 预览」对照） */
  const [splitPreview, setSplitPreview] = useState(false);
  /** 背诵模式：预览里把 `{{挖空}}` 盖住，点一下揭开 */
  const [recite, setRecite] = useState(false);
  /** 分屏背诵里已揭开的挖空序号（React 状态是唯一事实，DOM 属性只是渲染结果） */
  const [reciteRevealed, setReciteRevealed] = useState<number[]>([]);
  /** 本轮挖空进度（Preview 上报），退出背诵时用来留痕 */
  const [reciteProgress, setReciteProgress] = useState({ revealed: 0, total: 0 });
  /** 本轮开始时刻；null = 当前没在背 */
  const reciteStartedAt = useRef<number | null>(null);
  /** 当前笔记上一次背诵结果 */
  const [lastRecite, setLastRecite] = useState<ReciteSession | null>(null);
  useEffect(() => {
    setLastRecite(lastReciteOf(vault.currentPath ?? ''));
  }, [vault.currentPath]);
  useEffect(() => {
    if (!pendingBlock) return;
    if (pendingBlock.path !== activePath || !draft) return;
    const idx = draft.split('\n').findIndex((l) => new RegExp(`\\^${pendingBlock.block}\\s*$`).test(l));
    if (idx >= 0) outlineJumpRef.current?.(idx);
    else toast(`这段内容里没找到块 ^${pendingBlock.block}（可能已被改写）`, 'info');
    setPendingBlock(null);
  }, [pendingBlock, activePath, draft]);

  /**
   * 结束一轮背诵并留痕。
   * 只记事实（条数 / 揭开数 / 时长），**不写 FSRS 评分**：用「点了几次揭晓」去改调度，
   * 等于拿猜测覆盖用户的复习节奏，评分该由复习面板里的显式操作产生。
   */
  const commitRecite = useCallback(() => {
    const start = reciteStartedAt.current;
    reciteStartedAt.current = null;
    if (!start) return;
    const path = vault.currentPath;
    if (!path) return;
    const { revealed, total } = reciteProgress;
    if (!total) return;
    const session: ReciteSession = {
      path,
      total,
      revealed,
      ms: Math.min(Date.now() - start, 6 * 3600_000),
      at: Date.now(),
    };
    recordRecite(session);
    setLastRecite(session);
    toast(`本轮背诵：${revealed}/${total} 条揭开`, 'info');
  }, [reciteProgress, vault.currentPath]);

  /** 分屏里的「背诵」开关：开时计时，关时结算 */
  const toggleRecite = useCallback(() => {
    if (recite) {
      commitRecite();
      setRecite(false);
      return;
    }
    if (!splitPreview) setSplitPreview(true);
    reciteStartedAt.current = Date.now();
    recitePathRef.current = vault.currentPath; // 钉住这轮属于哪篇：切笔记时按它结算
    setReciteProgress({ revealed: 0, total: 0 });
    setReciteRevealed([]);
    setRecite(true);
  }, [recite, splitPreview, commitRecite, vault.currentPath]);

  /** 工具栏「背」：直接进全屏背诵——不开分屏（用户反馈「存在两个页面」），整屏只有这篇笔记与遮罩 */
  const openToolbarRecite = useCallback(() => {
    reciteStartedAt.current = null;
    openPanel('recite');
  }, [openPanel]);

  /** 全屏背诵：它自己记一轮，避免和分屏那轮重复计数 */
  const openFullRecite = useCallback(() => {
    setRecite(false);
    reciteStartedAt.current = null;
    openPanel('recite');
  }, [openPanel]);

  /**
   * 切笔记时结束当前背诵轮：背诵绑定的是「这一篇」，跨笔记把时间与进度记到另一篇头上
   * 是错账。留痕按**背诵开始那篇**记账（此刻 vault.currentPath 已经是新笔记，所以开始时
   * 先把路径钉进 ref，结算用它）；然后把背诵整个退掉——新笔记想背就重新开一轮。
   */
  const recitePathRef = useRef<string | null>(null);
  const toggleReciteRef = useRef(toggleRecite);
  toggleReciteRef.current = toggleRecite;
  useEffect(() => {
    if (!recite) return;
    if (activePath === recitePathRef.current) return;
    // 新笔记上的错账不能记：把 total 清零让 commitRecite 直接空转，单独按旧路径补一条留痕
    setReciteProgress({ revealed: 0, total: 0 });
    const start = reciteStartedAt.current;
    reciteStartedAt.current = null;
    const pathOfRound = recitePathRef.current;
    recitePathRef.current = null;
    if (start && pathOfRound && reciteProgress.total) {
      const session: ReciteSession = {
        path: pathOfRound,
        total: reciteProgress.total,
        revealed: reciteProgress.revealed,
        ms: Math.min(Date.now() - start, 6 * 3600_000),
        at: Date.now(),
      };
      recordRecite(session);
      if (pathOfRound === activePath) setLastRecite(session);
      toast(`本轮背诵：${reciteProgress.revealed}/${reciteProgress.total} 条揭开`, 'info');
    }
    toggleReciteRef.current(); // recite 为 true 的分支：结算（已被上面清零）+ setRecite(false)
  }, [activePath, recite, reciteProgress]);

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
  /** 报告数据；null = 还没生成成功过（面板只在 panels.is('report') && report 时渲染） */
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
      openPanel('report');
    } catch (e) {
      toast(`学习报告生成失败：${(e as Error).message}`, 'err');
    } finally {
      setReportBusy(false);
    }
  }, [openPanel, reportBusy, reportRange, buildReportFor]);

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
  /** 轨上高亮哪一处：按「谁盖在上面」排优先级（优先级表在 featureRouting） */
  const railOrder = buildRailOrder({
    search: panels.is('search'), pdf: panels.is('pdf'), anatomy: panels.is('anatomy'),
    brain: panels.is('brain'), graph: panels.is('graph'), review: panels.is('review'), mistakes: panels.is('mistakes'),
    quiz: panels.is('quiz'), todos: panels.is('todos'), tags: panels.is('tags'), report: panels.is('dash'),
    ai: panels.is('ai') || panels.is('agent') || panels.is('draft'), history: panels.is('history'), convert: panels.is('convert'),
    course: panels.is('course'),
    matgen: panels.is('matgen'),
    words: panels.is('words'),
    video: panels.is('video'),
    import: panels.is('import'), mind: panels.is('mind'), medref: panels.is('medref'), notice: panels.is('notice'),
  });
  const activeRailItem = activeRailOf(railOrder);

  // 右侧 AI 面板打开时把主区挤窄，避免面板压住笔记（见 index.css 的 .app.ai-open / .agent-open）。
  // 面板自身是 position: fixed，不受这里的 padding 影响，只是把左侧内容让出等宽空间。
  const sidePanelClass = panels.is('agent') ? ' agent-open' : panels.is('ai') ? ' ai-open' : '';

  // 命令面板只是快捷键层：每个功能都有自己的常驻入口（导航轨 / 笔记工具条 / 设置），
  // 面板不承担「唯一入口」的职责，否则不知道快捷键的人永远找不到功能。
  // 与导轨同一口径：全屏面板先关掉其余的；保存/打印/备份/视频/分屏/AI 这几项不是面板，原样执行。
  // 备份导出：超大附件不进 JSON（见 vault.exportAll），跳过时要让用户知道去哪找它们
  const exportBackup = async () => {
    const r = await vault.exportAll();
    const skipped = [
      r.skippedAttachments > 0 ? `${r.skippedAttachments} 个大附件` : '',
      r.skippedPdfs > 0 ? `${r.skippedPdfs} 本大 PDF` : '',
    ].filter(Boolean).join('、');
    if (skipped) {
      toast(`备份已导出，但跳过 ${skipped}（单件 >20MB 或合计 >80MB）：请保留原文件或改用文件夹备份`, 'info', 9000);
    }
  };
  const openOnly = (keep: string, open: () => void) => { closeModals(keep); open(); };
  const paletteCommands = PALETTE_COMMANDS({
              search: () => openOnly('search', () => panels.open('search')),
              save: () => void saveCurrent(),
              print: printCurrentNote,
              backup: () => exportBackup(),
              importOpen: () => openOnly('import', () => panels.open('import')),
              quiz: () => openOnly('quiz', () => panels.open('quiz')),
              exam: () => openOnly('exam', () => panels.open('exam')),
              review: () => openOnly('review', () => panels.open('review')),
              mistakes: () => openOnly('mistakes', () => panels.open('mistakes')),
              dashboard: () => openOnly('dash', () => panels.open('dash')),
              tags: () => openOnly('tags', () => panels.open('tags')),
              todos: () => openOnly('todos', () => panels.open('todos')),
              mind: () => openOnly('mind', () => panels.open('mind')),
              graph: () => openOnly('graph', () => panels.open('graph')),
              brain: () => openOnly('brain', () => panels.open('brain')),
              anatomy: () => openOnly('anatomy', () => void openAnatomy()),
              medref: () => openOnly('medref', () => panels.open('medref')),
              matgen: () => openOnly('matgen', () => panels.open('matgen')),
              pdf: () => openOnly('pdf', () => panels.open('pdf')),
              // 与导航轨一致：再执行一次就是收起（命令面板只开不收的话，收起只有鼠标一条路）
              video: () => { videoHiddenByAi.current = false; panels.toggle('video'); panels.close('ai'); },
              images: () => openOnly('imageLib', () => panels.open('imageLib')),
              split: () => setSplitPreview((v) => !v),
              convert: () => openOnly('convert', () => panels.open('convert')),
              vocab: () => openOnly('vocab', () => panels.open('vocab')),
              notice: () => openOnly('notice', () => panels.open('notice')),
              history: () => openOnly('history', () => panels.open('history')),
              ai: () => {
                panels.close('agent');
                if (!panels.is('ai') && panels.is('video')) { videoHiddenByAi.current = true; panels.close('video'); }
                panels.toggle('ai');
              },
              agent: () => { panels.toggle('agent'); panels.close('ai'); },
              draft: openDraft,
            });
  return (
    <div
      className={`app${sidePanelClass}${!vault.currentPath ? ' app--home' : ''}`}
      ref={appRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      /* 让位宽度按功能栏的真实宽度算（见 index.css 的 .app.agent-open）：
         拖宽整栏后主区跟着多让，拖窄后不多占。没拖过就不写，用 CSS 默认值。 */
      style={dockSplit.width != null ? { ['--dock-w' as string]: `${dockSplit.width}px` } : undefined}
    >
      {/* 左侧导航轨：功能入口 + 字体/主题切换（见 Rail.tsx） */}
      <Rail activeItem={activeRailItem} treeOpen={treeOpen} onHome={goHome} actions={railActions} onPrefetch={prefetchPanel} />

      <div
        className={`deck${treeOpen ? ' with-tree' : ''}${treeOpen && treeCollapsed ? ' tree-collapsed' : ''}`}
        style={treeOpen && treeCollapsed
          ? { ...deckSplit.style, ['--tree-w' as string]: '44px' }
          : deckSplit.style}
      >
        {/* 目录卡片常驻（未打开笔记时也要能选笔记），由导航轨的「目录」按钮折叠 */}
        {treeOpen && (treeCollapsed ? (
          /* 收起态：只留一条窄边，点一下展开。--tree-w 已被上面的 style 改成 44px，
             所以首页/正文的让位偏移和各断点规则都跟着收窄，不用另写一套。 */
          <div className="card c-tree is-collapsed">
            <button
              type="button"
              className="tree-expand"
              onClick={() => setTreeCollapsedPersist(false)}
              title="展开章节目录"
              aria-label="展开章节目录"
            >
              <IconFolder size={16} />
              <span className="tree-expand__label">章节目录</span>
            </button>
          </div>
        ) : (
          <div className="card c-tree">
            <div className="card-head">
              <IconFolder size={15} />
              <span>章节目录</span>
              <span className="spacer" />
              <span className="card-head-note">{noteCount} 篇</span>
              <button
                type="button"
                className="btn-icon tree-collapse"
                onClick={() => setTreeCollapsedPersist(true)}
                title="收起章节目录（收成左侧窄条）"
                aria-label="收起章节目录"
              >
                <IconBack size={14} />
              </button>
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
              onExport={exportBackup}
              onExportFolder={() => vault.exportMdFolder()}
              onImport={(t) => vault.importBackup(t)}
              onImportMd={(files) => vault.importMdFiles(files)}
              autoRepairReport={vault.autoRepair}
              onImportPack={handleImportPack}
              onUnifiedImport={() => panels.open('import')}
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
              newNoteSignal={newNoteSignal}
            />
          </div>
        ))}

        {/* 目录 │ 编辑 的拖宽抓手（宽度存 knowlattice.deck.split）；收起成窄条时没有可拖的宽度 */}
        {treeOpen && !treeCollapsed && (
          <button
            type="button"
            className="deck-split"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整目录宽度（← → 微调，双击复位）"
            title="拖动调整目录宽度（双击复位）"
            onPointerDown={deckSplit.onTreeDown}
            onKeyDown={deckSplit.onKeyDown('tree')}
            onDoubleClick={deckSplit.reset}
          />
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
                      panels.open('search');
                      return;
                    }
                    morphFrom(e.currentTarget, MORPH.search, '.qs-modal', () => flushSync(() => panels.open('search')));
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
                  onClick={() => panels.open('mind')}
                  title="把当前笔记自动生成思维导图"
                >
                  思维导图
                </button>
                {/* 插入图片：从磁盘选，落进 _attachments/ 后插到光标处 */}
                <button
                  className="btn-icon"
                  onClick={() => imageInputRef.current?.click()}
                  data-tip="插入图片（从磁盘选，存进本库 _attachments/）"
                  aria-label="插入图片"
                >
                  <IconImage />
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    void insertImages([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
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

              <ChapterAnnotations path={vault.currentPath} refreshToken={qbankRefresh} />

              <div className={splitPreview ? 'note-split note-split--on' : 'note-split'}>
              <Suspense fallback={<div className="editor-fallback">编辑器加载中…</div>}>
                <Editor
                  value={draft ?? ''}
                  onChange={handleChange}
                  linkNames={vault.allLinkNames}
                  onOpenLink={handleOpenLink}
                  onAttach={(name, blob) => vault.saveAttachment(name, blob)}
                  onDraft={(text) => { setDraftText(text); panels.open('draft'); }}
                  onAskAi={(text) => {
                    // 选段带上当前笔记路径：模型能知道这段话出自哪篇笔记
                    setAgentQuote({ text, path: vault.currentPath });
                    panels.close('ai'); // 与 AI 助手面板互斥（共用同一块让位空间）
                    panels.open('agent');
                  }}
                  onInsertReady={(insert) => { editorInsertRef.current = insert; }}
                  headingLines={outline.map((o) => o.line)}
                  onActiveHeading={setActiveHeading}
                  onJumpReady={(jump) => { outlineJumpRef.current = jump; }}
                  readFile={readFile}
                  highlight={highlight}
                  onJumpAnchor={jumpVideoAnchor}
                  onJumpCourse={openCourseVideo}
                  onPrint={printCurrentNote}
                  onHistory={() => panels.open('history')}
                  onVideo={() => panels.open('video')}
                  onRecite={openToolbarRecite}
                />
              </Suspense>
              {splitPreview && (
                <aside className="note-split__pane" aria-label="分屏预览">
                  <div className="note-split__head">
                    <span>预览</span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className={`btn-icon note-split__recite${recite ? ' on' : ''}`}
                      aria-pressed={recite}
                      aria-label={recite ? '退出背诵模式' : '进入背诵模式：遮住所有挖空'}
                      title={recite ? '退出背诵（挖空全部显示）' : '背诵：遮住 {{挖空}}，点一下揭开'}
                      onClick={toggleRecite}
                    >
                      背诵
                    </button>
                    {recite && (
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label="重新盖住全部已揭开的挖空"
                        title="全部重新盖住（再做一遍）"
                        onClick={() => setReciteRevealed([])}
                      >
                        全盖
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label="全屏背诵"
                      title="全屏背诵（空格逐条揭，Esc 结束）"
                      onClick={openFullRecite}
                    >
                      全屏
                    </button>
                    <button className="btn-icon" onClick={() => setSplitPreview(false)} aria-label="关闭分屏">✕</button>
                  </div>
                  {recite && (
                    <div className="note-split__recite-bar" aria-live="polite">
                      本轮 {reciteProgress.revealed}/{reciteProgress.total} 条
                      {lastRecite && (
                        <>
                          <span className="note-split__dot">·</span>
                          上次 {lastRecite.revealed}/{lastRecite.total}
                        </>
                      )}
                    </div>
                  )}
                  <div className="note-split__body">
                    <Preview
                      content={draft ?? ''}
                      resolve={vault.resolveLink}
                      onOpenLink={handleOpenLink}
                      onJumpAnchor={jumpVideoAnchor}
                      onJumpCourse={openCourseVideo}
                      readFile={readFile}
                      focusBlock={pendingBlock?.block ?? null}
                      recite={recite}
                      revealed={reciteRevealed}
                      onToggleCloze={(index) =>
                        setReciteRevealed((prev) =>
                          prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index],
                        )
                      }
                      onReciteChange={(revealedCount, total) => setReciteProgress({ revealed: revealedCount, total })}
                    />
                  </div>
                </aside>
              )}
              </div>
            </div>

            {/* 编辑 │ 关联 的拖宽抓手（关联在右侧，往左拖变宽） */}
            {showBacklinks && (
              <button
                type="button"
                className="deck-split"
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调整关联栏宽度（← → 微调，双击复位）"
                onPointerDown={deckSplit.onInspDown}
                onKeyDown={deckSplit.onKeyDown('insp')}
                onDoubleClick={deckSplit.reset}
              />
            )}

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
                  {vault.backlinkHits.length === 0 && (
                    <p className="muted">暂无笔记引用当前笔记。在其他笔记里输入 [[笔记名]] 即可建立链接。</p>
                  )}
                  {vault.backlinkHits.map((hit) => {
                    const label = hit.label || hit.fromPath.replace(/\.md$/, '').split('/').pop() || hit.fromPath;
                    return (
                      <div
                        key={hit.fromPath + '#' + hit.index}
                        className="backlink-item"
                        onClick={(e) => openNote(hit.fromPath, undefined, e.currentTarget)}
                        {...clickable(`打开反向链接笔记：${label}（第 ${hit.line} 行）`)}
                      >
                        {hit.kind === 'unresolved' && <span className="backlink-flag">可能失效</span>}
                        {label}
                        <span className="muted"> · {hit.fromPath} · 第 {hit.line} 行</span>
                        <span className="backlink-excerpt">
                          {hit.excerpt.before}
                          <b>{hit.excerpt.match}</b>
                          {hit.excerpt.after}
                        </span>
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
            <HomeView
              features={homeFeatures}
              featuresTitle={recentFeatures.length > 0 ? '最近使用' : '常用入口'}
              recents={homeRecents}
              dueCount={homeDueCount}
              mistakeCount={homeMistakeCount}
              quizResume={homeQuizResume}
              onFeature={(key) => railActions[key as RailKey]()}
              onOpenRecent={openNote}
              onReview={railActions.review}
              onStartTutor={startTutor}
              onMistake={railActions.mistakes}
              onResumeQuiz={() => { touchFeature('quiz'); closeModals('quiz'); setQuizAutoResume(true); panels.open('quiz'); }}
              onSearch={railActions.search}
              // 工作台快捷操作：新建要先把目录卡片展开，再给 ChapterTree 一个自增信号打开表单
              onNewNote={() => {
                setTreeOpen(true);
                setTreeCollapsedPersist(false);
                setNewNoteSignal((n) => n + 1);
              }}
              onImport={railActions.import}
              onVideo={railActions.video}
              onOpenTodos={railActions.todos}
              onOpenReport={railActions.report}
            />
          </div>
        )}
      </div>
      {panels.is('search') && (
        <Suspense fallback={null}>
          <QuickSearch
            open={panels.is('search')}
            docs={vault.docs}
            recents={recents}
            onClose={() => panels.close('search')}
            onOpenPath={openNote}
            onOpenQuiz={(q) => {
              panels.close('search');
              setQuizSeed(q);
              panels.open('quiz');
            }}
            onOpenMistakes={() => {
              panels.close('search');
              panels.open('mistakes');
            }}
          />
        </Suspense>
      )}
      {panels.is('review') && (
        <ReviewView
          paths={notePaths}
          docs={vault.docs}
          resolve={vault.resolveLink}
          onOpenLink={handleOpenLink}
          readFile={readFile}
          onClose={() => panels.close('review')}
          onAskAi={askAgent}
          onOpenQuiz={() => {
            panels.close('review');
            panels.open('quiz');
          }}
          onOpenPath={(p) => {
            panels.close('review');
            openNote(p);
          }}
          imageEntries={attachmentImages}
          resolveAsset={readFile}
        />
      )}
      {panels.is('mistakes') && (
        <MistakeBook
          onOpenPath={(p) => {
            panels.close('mistakes');
            openNote(p);
          }}
          onClose={() => panels.close('mistakes')}
          onAskAi={askAgent}
          docs={vault.docs}
          onRedoChapters={(paths) => {
            // 错题本 → 考试中心：直接开一场只考本组笔记的错题重练
            panels.close('mistakes');
            setExamBank(undefined);
            setExamSeed(paths);
            panels.open('exam');
          }}
        />
      )}
      {panels.is('graph') && (
        <Suspense fallback={<div className="loading">图谱加载中…</div>}>
          <GraphView
            docs={vault.docs}
            linkIndex={vault.linkIndex}
            resolveLink={vault.resolveLink}
            onOpenPath={(p) => {
              panels.close('graph');
              openNote(p);
            }}
            onClose={() => panels.close('graph')}
          />
        </Suspense>
      )}
      {panels.is('mind') && vault.currentPath && (
        <Suspense fallback={<div className="loading">思维导图加载中…</div>}>
          <MindMapView
            content={draft ?? ''}
            title={vault.currentPath.replace(/\.md$/, '').split('/').pop()!}
            noteKey={vault.currentPath}
            onAskAi={askAgent}
            onClose={() => panels.close('mind')}
            onOpenWiki={handleOpenLink}
            onImageEntries={attachmentImages}
            resolveAsset={readFile}
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
      {panels.is('quiz') && (
        <Suspense fallback={<div className="loading">题库加载中…</div>}>
          <QuizView
            docs={vault.docs}
            resolveLink={vault.resolveLink}          onOpenPath={(p) => openNote(p)}
            onClose={() => { panels.close('quiz'); setQuizSeed(''); }}
            onAskAi={askAgent}
            onOpenExam={(name) => { setExamBank(name); panels.open('exam'); }}
            resolveAsset={readFile}
            onUnifiedImport={() => panels.open('import')}
            onSaveNote={(path: string, markdown: string) => void saveQuestionNote(path, markdown)}
            onUpdateNote={(path, content) => vault.save(path, content)}
            onImageEntries={attachmentImages}
            refreshToken={qbankRefresh}
            autoResume={quizAutoResume}
            onAutoResumeDone={() => setQuizAutoResume(false)}
            initialSearch={quizSeed}
          />
        </Suspense>
      )}
      {panels.is('exam') && (
        <Suspense fallback={<div className="loading">考试中心加载中…</div>}>
          <ExamCenter
            initialBank={examBank}
            docs={vault.docs}
            initialMode={examSeed !== undefined ? 'wrong' : undefined}
            seedPaths={examSeed}
            onClose={() => { panels.close('exam'); setExamBank(undefined); setExamSeed(undefined); }}
          />
        </Suspense>
      )}
      {panels.is('todos') && (
        <Suspense fallback={<div className="loading">待办加载中…</div>}>
          <TodoView
            onClose={() => panels.close('todos')}
            docs={vault.docs}
            onOpenPath={(p) => { panels.close('todos'); openNote(p); }}
            onSaveNote={(path, content) => vault.save(path, content)}
          />
        </Suspense>
      )}
      {panels.is('tags') && <TagBrowser docs={vault.docs} onOpenPath={(p) => { panels.close('tags'); openNote(p); }} onClose={() => panels.close('tags')} />}
      {panels.is('dash') && (
        <Suspense fallback={<div className="loading">学习统计加载中…</div>}>
          <Dashboard
            docs={vault.docs}
            onClose={() => panels.close('dash')}
            onOpenReview={() => { panels.close('dash'); panels.open('review'); }}
            onOpenQuiz={() => { panels.close('dash'); panels.open('quiz'); }}
            onOpenMistakes={() => { panels.close('dash'); panels.open('mistakes'); }}
            onOpenExam={() => { panels.close('dash'); setExamBank(undefined); panels.open('exam'); }}
          />
        </Suspense>
      )}
      {/* 学习报告：模态面板，遮罩与 Dashboard / 错题本同一套（面板自己渲染 .panel-backdrop）。
          report 为空时不渲染——还没点过入口或上次聚合失败都不该弹空壳。
          范围切换走 changeReportRange（事件里重算），busy 时按钮 disabled。 */}
      {panels.is('report') && report && (
        <StudyReportPanel
          report={report}
          range={reportRange}
          busy={reportBusy}
          onRangeChange={changeReportRange}
          onClose={() => panels.close('report')}
          onCopy={handleCopyReport}
        />
      )}
      {panels.is('ai') && (
        <AiPanel
          onClose={() => panels.close('ai')}
          onSwitchToAgent={() => { panels.close('ai'); panels.open('agent'); }}
        />
      )}
      {panels.is('palette') && <CommandPalette commands={paletteCommands} onClose={() => panels.close('palette')} />}
      {panels.is('settings') && (
        <SettingsPanel
          onClose={() => panels.close('settings')}
          onBackup={exportBackup}
          onImport={() => { panels.close('settings'); panels.open('import'); }}
          onNotice={() => { panels.close('settings'); panels.open('notice'); }}
          onIntegrity={() => { panels.close('settings'); panels.open('integrity'); }}
          onCustomizePet={() => { panels.close('settings'); panels.open('pet'); }}
        />
      )}
      {panels.is('pet') && <PetCustomizer onClose={() => panels.close('pet')} />}
      {panels.is('integrity') && (
        <Suspense fallback={<div className="loading">数据自检加载中…</div>}>
          <IntegrityView
            docs={vault.docs}
            attachmentPaths={vault.attachmentPaths}
            linkIndex={vault.linkIndex}
            onClose={() => panels.close('integrity')}
          />
        </Suspense>
      )}
      {panels.is('medref') && <MedRefView onClose={() => panels.close('medref')} onToast={toast} />}
      {panels.is('course') && (
        <CourseWorkshopView
          key={courseInitialBvid ?? 'course'}
          onClose={() => panels.close('course')}
          onToast={toast}
          docs={vault.docs}
          onSave={vault.save}
          createNote={vault.createNote}
          onOpenNote={(path) => vault.setCurrentPath(path)}
          onOpenVideo={openCourseVideo}
          onCourseMeta={rememberCourse}
          initialBvid={courseInitialBvid}
        />
      )}
      {panels.is('words') && (
        <WordDrillView
          onClose={() => panels.close('words')}
          onSaveNote={async (dir, title, content) => {
            const path = dir ? `${dir}/${title}.md` : `${title}.md`;
            await vault.save(path, content);
            openNote(path);
            return path;
          }}
        />
      )}
      {panels.is('matgen') && (
        <Suspense fallback={<div className="loading">资料生成加载中…</div>}>
          {/* onSave：写入「复习讲义/」目录并打开（与 ConvertView 同一转发口径） */}
          <MatGenView
            onSave={async (dir, t, content) => {
              const path = dir ? `${dir}/${t}.md` : `${t}.md`;
              await vault.save(path, content);
              openNote(path);
              return path;
            }}
            onClose={() => panels.close('matgen')}
          />
        </Suspense>
      )}
      {panels.is('vocab') && <VocabView onClose={() => panels.close('vocab')} />}
      {panels.is('recite') && (
        <ReciteView
          path={vault.currentPath ?? ''}
          content={draft ?? ''}
          resolve={vault.resolveLink}
          onOpenLink={handleOpenLink}
          readFile={readFile}
          onClose={() => panels.close('recite')}
        />
      )}
      {panels.is('imageLib') && (
        <ImageLibrary
          entries={attachmentImages}
          resolveAsset={readFile}
          onInsert={vault.currentPath ? (md) => { editorInsertRef.current?.(md); } : undefined}
          onClose={() => panels.close('imageLib')}
        />
      )}
      {/* 视频笔记：顶层渲染，不依赖「已打开笔记」——挂进编辑区时没开笔记点它等于无反应 */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openVideo(f); }}
      />
      {/*
        视频笔记 + AI 笔记合成「一栏」：两者贴同一条右边缘、共享同一列宽度、上下相邻。
        这一栏是唯一的定位根，三种操作互不干扰：
          · 视频标题栏拖动 = 整栏移动（位置持久化，双击标题栏复位）
          · 左边缘抓手     = 整栏宽度（双击复位，方向键微调）
          · 两块之间的分隔条 = 视频大小（上下拖按 16:9 换算成宽度，画面等比放大/缩小）
        尺寸与位置都写进 localStorage，下次打开还是这个样子。
        视频块自身不再带独立的拖动/缩放：栏内尺寸只留一套来源，
        否则内联 width/height 会把它顶出整栏（实测溢出 288px，且分隔条失效）。
      */}
      {/*
        上下顺序是「AI 笔记在上、视频在下」：整栏贴底，视频是最后一项，
        所以打开 AI 笔记时视频的底边不动——只往上多长出一块，不再被顶到屏幕顶部。
        （旧顺序视频在上，AI 一开就把视频整体推上去，用户实测反馈为「视频被 AI 笔记顶掉」。）
      */}
      {(panels.is('video') || panels.is('agent')) && (
        <div
          className="dock-col"
          data-dock-root
          data-panel-drag-root
          style={{ ...dockDrag.style, ...dockSplit.style }}
          aria-label="视频与 AI 笔记栏"
        >
          {/*
            拖动条：不管哪块面板在，都能移动整栏。
            之前只把拖动挂在视频标题栏上 —— 视频一关，整栏就再也动不了（用户实测反馈）。
          */}
          {/*
            必须是 div 而不是 button：usePanelDrag 的 NO_DRAG 明确忽略 button/a/input…
            （为的是标题栏里的按钮不被当拖动起点）。写成 button 的话这里点了毫无反应。
          */}
          <div
            className="dock-col__drag"
            role="separator"
            aria-orientation="horizontal"
            tabIndex={0}
            aria-label="拖动移动这一栏（双击复位位置）"
            title="拖动移动；双击复位位置"
            onPointerDown={dockDrag.onHandlePointerDown}
            onDoubleClick={dockDrag.reset}
          />
          <button
            type="button"
            className="dock-col__grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整这一栏的宽度（方向键微调，双击复位）"
            onPointerDown={dockSplit.onWidthDown}
            onPointerMove={dockSplit.onMove}
            onPointerUp={dockSplit.onUp}
            onPointerCancel={dockSplit.onUp}
            onKeyDown={dockSplit.onKeyDown('w')}
            onDoubleClick={dockSplit.reset}
          />
          {/* 只开视频：分隔条贴在视频块上沿，往上拖整块变高 */}
          {panels.is('video') && !panels.is('agent') && <DockSplitHandle dockSplit={dockSplit} />}
          {/* 视频在上、AI 笔记在下（顺序即视觉顺序，别被后续 patch 调换） */}
          {panels.is('video') && (
            /*
             * 这一块不带自己的 data-panel-drag-root / 缩放入参：
             * 栏内尺寸只有一套来源——宽度归整栏抓手、高度归分隔条。
             * 曾经把它同时当成独立浮窗（自带拖动 transform + 内联 width/height），
             * 实测会把它撑到 908px 宽、越过整栏 288px 跑出窗口，之后分隔条也一起失效。
             */
            <div className="video-note-wrap">
              <VideoNoteView
                key={videoMedia}
                src={videoSrc}
                media={videoMedia}
                title={videoTitle}
                seekTo={videoSeek}
                onSeekConsumed={() => setVideoSeek(null)}
                onPick={() => videoInputRef.current?.click()}
                onUrl={openVideoUrl}
                course={videoCourse}
                onOpenCourseNote={(path) => openNote(path)}
                onOpenCourse={openCourseFromVideo}
                onInsert={(md) => { const ins = editorInsertRef.current; if (!ins) return false; ins(md); return true; }}
                onAttach={(name, blob) => vault.saveAttachment(name, blob)}
                hasAttachment={(path) => vault.hasAttachment(path)}
                // 标题栏拖动 = 移动整栏（transform 写在 .dock-col 上）；双击标题栏复位
                onDragStart={dockDrag.onHandlePointerDown}
                onDragReset={dockDrag.reset}
                onClose={() => panels.close('video')}
              />
            </div>
          )}
          {/* AI 笔记在上沿挂分隔条：与视频同开时它就落在两块之间（互换高度），单开时就是它自己的上沿 */}
          {panels.is('agent') && <DockSplitHandle dockSplit={dockSplit} />}
          {panels.is('agent') && (
            <Suspense fallback={<div className="loading">AI 笔记加载中…</div>}>
              <AiAgentPanel
                onClose={() => panels.close('agent')}
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
                seed={agentSeed}
                onSeedConsumed={() => setAgentSeed(null)}
                onSwitchToAi={() => { panels.close('agent'); panels.open('ai'); }}
              />
            </Suspense>
          )}
          {/*
            下方拖动条：与上方那条同一套手势（整栏移动、双击复位）。
            为什么要有它——整栏贴底，上方那根 12px 的细条在长对话里要往上滚才看得见；
            抓窗口底边是更直觉的动作，尤其是只想把栏往上挪一点、让出底部内容的时候。
            必须 div 而不是 button：usePanelDrag 的 NO_DRAG 会忽略 button（见上方拖动条的注释）。
          */}
          <div
            className="dock-col__drag dock-col__drag--bottom"
            role="separator"
            aria-orientation="horizontal"
            tabIndex={0}
            aria-label="拖动移动这一栏（下方抓手，双击复位位置）"
            title="拖动移动；双击复位位置"
            onPointerDown={dockDrag.onHandlePointerDown}
            onDoubleClick={dockDrag.reset}
          />
        </div>
      )}
      {panels.is('notice') && <SafetyNotice onClose={() => panels.close('notice')} />}
      {panels.is('draft') && (
        <Suspense fallback={<div className="loading">草稿生成器加载中…</div>}>
          <DraftGen
            initialText={draftText}
            imageEntries={attachmentImages}
            resolveAsset={readFile}
            onSave={async (dir, title, content) => {
              const path = dir ? `${dir}/${title}.md` : `${title}.md`;
              await vault.save(path, content);
              openNote(path);
              return path;
            }}
            onClose={() => { panels.close('draft'); setDraftText(''); }}
          />
        </Suspense>
      )}
      {panels.is('pdf') && (
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
            onClose={() => panels.close('pdf')}
          />
        </Suspense>
      )}
      {panels.is('history') && (
        <Suspense fallback={<div className="loading">快照加载中…</div>}>
          <HistoryPanel
            currentPath={vault.currentPath}
            existingPaths={existingPathSet}
            onRestore={async (path, content) => {
              await vault.save(path, content);
              openNote(path);
            }}
            onClose={() => panels.close('history')}
          />
        </Suspense>
      )}
      {panels.is('convert') && (
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
            onClose={() => panels.close('convert')}
          />
        </Suspense>
      )}
      {panels.is('import') && (
        <Suspense fallback={<div className="loading">导入面板加载中…</div>}>
          {/* 统一导入：一个入口吃掉笔记备份 / 知识包 / 题库 / 数据集 / Anki / Word·PDF / Excel。
              四条回调全部转发到**既有**通道（vault.importBackup / importMdFiles / handleImportPack /
              saveAttachment），不新开写盘路径，联动与老入口完全一致。 */}
          <ImportView
            onImportBackup={(t) => vault.importBackup(t)}
            onImportMd={(files) => vault.importMdFiles(files)}
            onImportPack={handleImportPack}
            onAttach={vault.saveAttachment}
            onClose={() => { panels.close('import'); setQbankRefresh((n) => n + 1); }}
          />
        </Suspense>
      )}
      {panels.is('brain') && (
        <Suspense fallback={<div className="loading">脑图谱加载中…</div>}>
          <BrainAtlasView onClose={() => panels.close('brain')} />
        </Suspense>
      )}
      {panels.is('anatomy') && (
        <div className="panel panel--full anatomy-overlay">
          <div className="panel__head anatomy-topbar">
            <button className="btn-small" onClick={() => panels.close('anatomy')}>← 返回</button>
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

      {/* 桌宠：fixed 定位，不参与 .app 的 flex 布局，也不挡面板遮罩 */}
      <Pet />
    </div>
  );
}
