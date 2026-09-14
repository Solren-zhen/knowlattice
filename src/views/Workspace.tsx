/**
 * 三栏主界面（M1~M3）：章节树 | 编辑器 | 预览 + 反链面板 + Ctrl+K 快速搜索。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVault } from '../core/vault';
import { noteTemplate, parseFrontmatterCached, type NoteType } from '../core/parser';
import { appendExcerpt } from '../core/noteGen';
import { loadCards } from '../core/srs';
import { loadMistakes } from '../core/mistakes';
import {
  loadAnatomyManifest,
  loadZhDict,
  zhOrganName,
  type ManifestOrgan,
  type AnatomyManifest,
} from '../core/anatomy';
import ChapterTree from './ChapterTree';
import Preview from './Preview';
// 编辑器（CodeMirror ~400KB）与其余弹层视图全部懒加载：首屏只加载目录 + 预览，
// 打开笔记/对应功能时才下载各自 chunk
const Editor = lazy(() => import('./Editor'));
const QuickSearch = lazy(() => import('./QuickSearch'));
const ReviewView = lazy(() => import('./ReviewView'));
const MistakeBook = lazy(() => import('./MistakeBook'));
const AnatomyBrowser = lazy(() => import('./AnatomyBrowser'));
// 3D 视图懒加载：three.js（~1MB）拆成独立 chunk，打开解剖图谱时才加载
const AnatomyViewer3D = lazy(() => import('./AnatomyViewer3D'));
const BrainAtlasView = lazy(() => import('./BrainAtlasView'));
// 思维导图懒加载（mind-elixir 依赖较大，打开时才加载）
const MindMapView = lazy(() => import('./MindMapView'));
// 重依赖视图懒加载：force-graph / mammoth+xlsx / react-pdf-viewer+pdfjs 都很大，按需加载
const GraphView = lazy(() => import('./GraphView'));
const QuizView = lazy(() => import('./QuizView'));
const PdfSplitView = lazy(() => import('./PdfSplitView'));
// 格式转换懒加载：mammoth + turndown + pdfjs 都较大，打开面板时才加载
const ConvertView = lazy(() => import('./ConvertView'));
// 历史版本面板：快照读取/恢复
const HistoryPanel = lazy(() => import('./HistoryPanel'));
import AiPanel from './AiPanel';
import DraftGen from './DraftGen';
import TodoView from './TodoView';
import TagBrowser from './TagBrowser';
import Dashboard from './Dashboard';
import {
  IconSave, IconTrash, IconChevron, IconBack, IconFwd, IconSearch,
  IconFolder, IconLink,
} from './icons';
import Rail from './Rail';
import { toast, confirmBox } from '../core/feedback';

const RECENTS_KEY = 'medvault-recents';

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
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [mindOpen, setMindOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [anatomyOpen, setAnatomyOpen] = useState(false);
  const [brainOpen, setBrainOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [pdfOpen, setPdfOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 目录卡片显隐（导航轨「目录」按钮切换，窄屏可收起给正文让位） */
  const [treeOpen, setTreeOpen] = useState(true);
  const [anatomyManifest, setAnatomyManifest] = useState<AnatomyManifest | null>(null);
  const [anatomySelected, setAnatomySelected] = useState<ManifestOrgan | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  /** 保存成功闪现反馈 */
  const [savedFlash, setSavedFlash] = useState(false);
  /** 笔记导航历史（后退/前进） */
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: [], idx: -1 });

  // 稳定引用：让 saveCurrent / openNoteCore 等 useCallback 不随渲染链失效，
  // 也避免下游（如 GraphView）因回调身份变化而整个重建
  const editRef = useRef({ vault, draft, dirty, recents });
  editRef.current = { vault, draft, dirty, recents };

  // Ctrl+K 全局唤起快速搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /** 立即保存当前笔记；manual=false 时不弹「已保存」反馈（自动保存用） */
  const saveCurrent = useCallback(async (manual = true) => {
    const { vault: v, draft: d } = editRef.current;
    if (v.currentPath && d !== null) {
      await v.save(v.currentPath, d);
      setDirty(false);
      if (manual) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1400);
      }
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

  /** 打开笔记并记入导航历史 */
  const openNote = useCallback(
    (path: string) => {
      openNoteCore(path);
      setNav((n) => {
        const stack = n.stack.slice(0, n.idx + 1);
        if (stack[n.idx] === path) return n;
        stack.push(path);
        return { stack, idx: stack.length - 1 };
      });
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

  // Alt+← / Alt+→ 后退前进；解剖图谱打开时 Esc 退出
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (brainOpen && e.key === 'Escape') { setBrainOpen(false); return; }
      if (anatomyOpen && e.key === 'Escape') { setAnatomyOpen(false); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [anatomyOpen, brainOpen, goBack, goForward]);

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

  /** 回到主界面（欢迎页）：先把未保存改动落盘，再清空当前笔记 */
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
      const systemZh: Record<string, string> = {
        articular: '关节', cardiovascular: '心血管', digestive: '消化',
        endocrine: '内分泌', integumentary: '皮肤', lymphatic: '淋巴',
        muscular: '肌肉', nervous: '神经', regional: '区域',
        renal: '泌尿', reproductive: '生殖', respiratory: '呼吸',
        skeletal: '骨骼',
      };
      const zh = systemZh[organ.system] ?? organ.system;
      const dir = `08-解剖学/${zh}`;
      // 汉化：笔记标题/文件名优先用中文结构名（词典缺失或与已有笔记重名时回退英文）
      const zhDict = await loadZhDict();
      const zhName = zhOrganName(organ.name_en, zhDict.organs);
      const title =
        zhName && !vault.docs.has(`${dir}/${zhName}.md`) ? zhName : organ.name_en;
      const lines = [
        '---',
        `aliases: [${organ.name_en}]`,
        'tags: [解剖]',
        `chapter: 解剖学/${zh}`,
        `source: Anatria-3D ${organ.mesh_file}`,
        `created: ${new Date().toISOString().slice(0, 10)}`,
        '---',
        '',
        `# ${title}`,
        '',
        `- 层级: ${organ.path.join(' > ') || '(系统根结构)'}`,
        `- 系统: ${zh} (${organ.system})`,
        `- 结构ID: ${organ.organ_id}`,
        `- 英文名: ${organ.name_en}`,
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
    [vault, openNote]
  );

  /** 3D/列表单击 → 选中高亮（不打开笔记；null = 取消选中） */
  const handleAnatomySelect = useCallback((organ: ManifestOrgan | null) => {
    setAnatomySelected(organ);
  }, []);

  /** vault 路径 → 可渲染内容：.md 返回文本，附件返回 Blob 对象 URL（由 vault 统一解析） */
  const readFile = vault.readFile;

  const handleCreate = useCallback(
    async (dir: string, title: string, type: NoteType = 'concept') => {
      try {
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
    [vault, pushRecent]
  );

  const notePaths = useMemo(
    () => [...vault.docs.keys()].filter((p) => p.endsWith('.md')),
    [vault.docs]
  );
  const noteTargets = useMemo(
    () => notePaths.map((path) => {
      const parsed = parseFrontmatterCached(path, vault.docs.get(path) ?? '');
      return {
        path,
        title: parsed.title || path.replace(/\.md$/, '').split('/').pop() || path,
        chapter: parsed.meta.chapter,
      };
    }),
    [notePaths, vault.docs]
  );
  const noteCount = notePaths.length;
  /** 现存路径集合（历史面板判断「已删除」快照用；memoized 防止面板 effect 重载） */
  const existingPathSet = useMemo(() => new Set(notePaths), [notePaths]);
  const wordCount = useMemo(
    () => (draft ? draft.replace(/\s/g, '').length : 0),
    [draft]
  );

  if (!vault.loaded) {
    return <div className="loading">加载知识库…</div>;
  }

  const activePath = vault.currentPath;
  const activeCard = activePath ? loadCards()[activePath] : null;
  const activeMistake = activePath ? loadMistakes()[activePath] : null;
  const activeExam = activePath
    ? parseFrontmatterCached(activePath, vault.docs.get(activePath) ?? '').meta.exam
    : null;
  const activeDueText = activeCard
    ? new Date(activeCard.due).getTime() <= Date.now()
      ? '到期待复习'
      : `${activeCard.reps} 次 · 下次 ${new Date(activeCard.due).toLocaleDateString('zh-CN')}`
    : null;

  return (
    <div className="app" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* 左侧导航轨：功能入口 + 字体/主题切换（见 Rail.tsx） */}
      <Rail
        treeOpen={treeOpen}
        onToggleTree={() => setTreeOpen((v) => !v)}
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
        onAi={() => setAiOpen((v) => !v)}
        onDraft={openDraft}
        onPdf={() => setPdfOpen(true)}
        onConvert={() => setConvertOpen(true)}
      />

      {/* 悬浮工作台：目录 / 编辑 / 关联 三张卡片漂在背景之上 */}
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
            <ChapterTree
              tree={vault.tree}
              currentPath={vault.currentPath}
              onOpen={openNote}
              onCreate={handleCreate}
              onExport={() => vault.exportAll()}
              onExportFolder={() => vault.exportMdFolder()}
              onImport={(t) => vault.importBackup(t)}
              onImportMd={(files) => vault.importMdFiles(files)}
              onRemove={(paths) => {
                if (vault.currentPath && paths.includes(vault.currentPath)) {
                  setDraft(null);
                  setDirty(false);
                }
                void vault.removeMany(paths);
              }}
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
                  onClick={() => setSearchOpen(true)}
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
                      await vault.remove(vault.currentPath!);
                      setDraft(null); // 清空草稿，避免删除后残留旧内容
                      setDirty(false);
                      toast('已删除（可在「历史版本」中恢复）', 'ok');
                    });
                  }}
                  aria-label="删除笔记"
                >
                  <IconTrash />
                </button>
              </div>

              <Suspense fallback={<div className="editor-fallback">编辑器加载中…</div>}>
                <Editor
                  value={draft ?? ''}
                  onChange={handleChange}
                  linkNames={vault.allLinkNames}
                  onOpenLink={handleOpenLink}
                  onAttach={(name, blob) => vault.saveAttachment(name, blob)}
                  onDraft={(text) => { setDraftText(text); setDraftOpen(true); }}
                  readFile={readFile}
                />
              </Suspense>
            </div>

            {showBacklinks && (
              <div className="card c-insp">
                <div className="card-head">
                  <IconLink size={15} />
                  <span>关联 · {vault.currentBacklinks.length}</span>
                </div>
                <div className="card-body">
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
                    return (
                      <div key={p} className="backlink-item" onClick={() => openNote(p)}>
                        {title || p.replace(/\.md$/, '').split('/').pop()}
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
            onClose={() => setMindOpen(false)}
            onOpenWiki={handleOpenLink}
            onSaveNote={(md) => {
              void vault.save(vault.currentPath!, md);
              setDraft(md);
              setDirty(false);
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
          />
        </Suspense>
      )}
      {todoOpen && <TodoView onClose={() => setTodoOpen(false)} />}
      {tagOpen && <TagBrowser docs={vault.docs} onOpenPath={(p) => { setTagOpen(false); openNote(p); }} onClose={() => setTagOpen(false)} />}
      {dashOpen && <Dashboard docs={vault.docs} onClose={() => setDashOpen(false)} />}
      {aiOpen && <AiPanel onClose={() => setAiOpen(false)} />}
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
          <ConvertView
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
          <div className="anatomy-stage">
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
