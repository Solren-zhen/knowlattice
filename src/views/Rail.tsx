/**
 * 左侧导航轨：可展开分组标签 + 功能入口 + 字体/主题切换。
 * 字体与主题状态只有导航轨在用，收敛在此；各面板开关由 Workspace 传入回调。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  applyFont, applyTheme, currentFont, currentTheme, FONT_LABELS,
  type Font, type Theme,
} from '../core/theme';
import { applyHighlight, currentHighlight, HIGHLIGHT_PRESETS } from '../core/highlight';
import {
  IconLogo, IconTree, IconPathway, IconChevron, IconSearch, IconHistory, IconBody, IconBrain, IconGraph, IconCards,
  IconTarget, IconQuiz, IconTodo, IconTag, IconChart, IconAi, IconAgent, IconWand, IconBook,
  IconConvert, IconSun, IconMoon, IconInfo, IconRestore,
} from './icons';

interface Props {
  activeItem: string | null;
  treeOpen: boolean;
  onToggleTree: () => void;
  onPathway?: () => void;
  onHome: () => void;
  onSearch: () => void;
  onHistory: () => void;
  onAnatomy: () => void;
  onBrain: () => void;
  onGraph: () => void;
  onReview: () => void;
  onMistake: () => void;
  onQuiz: () => void;
  onTodo: () => void;
  onTag: () => void;
  onDash: () => void;
  onAi: () => void;
  onAgent: () => void;
  onDraft: () => void;
  onPdf: () => void;
  onConvert: () => void;
  onImport: () => void;
  onNotice: () => void;
}

export default function Rail(p: Props) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [font, setFont] = useState<Font>(currentFont);
  const [fontOpen, setFontOpen] = useState(false);
  const fontButtonRef = useRef<HTMLButtonElement>(null);
  const [hl, setHl] = useState<string>(currentHighlight);
  const [hlOpen, setHlOpen] = useState(false);
  const hlButtonRef = useRef<HTMLButtonElement>(null);
  const hlName = HIGHLIGHT_PRESETS.find((preset) => preset.bg === hl)?.name;
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia?.('(max-width: 1040px)').matches === true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopExpanded, setDesktopExpanded] = useState(() => {
    try {
      const preference = localStorage.getItem('knowlattice-rail-expanded');
      return preference === null
        ? window.matchMedia?.('(min-width: 1041px)').matches === true
        : preference === 'true';
    } catch { return false; }
  });
  const expanded = isNarrow ? mobileOpen : desktopExpanded;

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1040px)');
    if (!media) return;
    const syncViewport = () => {
      setIsNarrow(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener?.('change', syncViewport);
    return () => media.removeEventListener?.('change', syncViewport);
  }, []);

  useEffect(() => {
    if (!isNarrow || !mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isNarrow, mobileOpen]);

  return (
    <nav
      className={`rail${expanded ? ' rail--expanded' : ''}`}
      aria-label="主导航"
      onClick={(event) => {
        if (event.target === event.currentTarget && isNarrow && mobileOpen) {
          setMobileOpen(false);
          return;
        }
        const action = (event.target as HTMLElement).closest('.rail-home, .rail-btn:not(.rail-font-btn)');
        if (isNarrow && mobileOpen && action) setMobileOpen(false);
      }}
    >
      <button
        ref={menuButtonRef}
        className="rail-expand"
        aria-label={isNarrow ? (mobileOpen ? '关闭导航' : '打开导航') : (desktopExpanded ? '收起导航标签' : '展开导航标签')}
        aria-expanded={expanded}
        onClick={() => {
          if (isNarrow) {
            setMobileOpen((open) => !open);
            return;
          }
          const next = !desktopExpanded;
          try { localStorage.setItem('knowlattice-rail-expanded', String(next)); } catch {}
          setDesktopExpanded(next);
        }}
      >
        <span className="rail-expand-icon"><IconChevron /></span>
        <span className="rail-expand-label">{expanded ? '收起导航' : '展开导航'}</span>
      </button>
      {/* 上组：窗口变矮时只有这一组在内部滚动。
          下组（AI / 草稿 / PDF / 转换 / 字体 / 主题）钉在底部、不参与滚动——
          这样字体飞出菜单仍留在不滚动的容器里，.rail 的 overflow:visible 不必动。
          整条轨内容固定要 963px，窗口低于这个高度时下组会直接溢出到视口外，
          而 overflow:visible 没有滚动条，那几个入口就够不着；所以上组单独滚动。 */}
      <div className="rail-scroll">
        <button className="rail-home" data-tip="回到主界面" aria-label="回到主界面" onClick={p.onHome}>
          <IconLogo /><span className="rail-label">知识首页</span>
        </button>
        <div className="rail-section-label" aria-hidden={!expanded}>工作区</div>
        <button
          className={`rail-btn ${p.treeOpen ? 'on' : ''}`}
          data-tip="目录：折叠 / 展开章节树"
          aria-label="目录"
          aria-pressed={p.treeOpen}
          onClick={p.onToggleTree}
        >
          <IconTree />
          <span className="rail-label">目录</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'search' ? ' on' : ''}`} aria-current={p.activeItem === 'search' ? 'page' : undefined} data-tip="快速搜索（Ctrl+K）" aria-label="搜索" onClick={p.onSearch}>
          <IconSearch />
          <span className="rail-label">搜索</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'pdf' ? ' on' : ''}`} aria-current={p.activeItem === 'pdf' ? 'page' : undefined} data-tip="PDF 对照：左看右记 + 摘录历史" aria-label="PDF 对照" onClick={p.onPdf}>
          <IconBook />
          <span className="rail-label">PDF 对照</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'anatomy' ? ' on' : ''}`} aria-current={p.activeItem === 'anatomy' ? 'page' : undefined} data-tip="3D 解剖图谱：结构 ↔ 笔记双向打通" aria-label="解剖图谱" onClick={p.onAnatomy}>
          <IconBody />
          <span className="rail-label">解剖图谱</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'brain' ? ' on' : ''}`} aria-current={p.activeItem === 'brain' ? 'page' : undefined} data-tip="脑图谱：MNI152 模板 MRI 对照" aria-label="脑图谱" onClick={p.onBrain}>
          <IconBrain />
          <span className="rail-label">脑图谱</span>
        </button>
        <button className={`rail-btn rail-btn--graph${p.activeItem === 'graph' ? ' on' : ''}`} aria-current={p.activeItem === 'graph' ? 'page' : undefined} data-tip="知识图谱：全库双链网络图" aria-label="知识图谱" onClick={p.onGraph}>
          <IconGraph />
          <span className="rail-label">知识图谱</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'pathway' ? ' on' : ''}`} aria-current={p.activeItem === 'pathway' ? 'page' : undefined} data-tip="医学通路：拖动节点绘制并复用通路图" aria-label="医学通路" onClick={() => p.onPathway?.()}>
          <IconPathway />
          <span className="rail-label">医学通路</span>
        </button>
        <div className="rail-group-divider"><span>学习</span></div>
        <button className={`rail-btn${p.activeItem === 'review' ? ' on' : ''}`} aria-current={p.activeItem === 'review' ? 'page' : undefined} data-tip="间隔复习（遗忘曲线）" aria-label="间隔复习" onClick={p.onReview}>
          <IconCards />
          <span className="rail-label">间隔复习</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'mistake' ? ' on' : ''}`} aria-current={p.activeItem === 'mistake' ? 'page' : undefined} data-tip="错题本（薄弱点热力图）" aria-label="错题本" onClick={p.onMistake}>
          <IconTarget />
          <span className="rail-label">错题本</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'quiz' ? ' on' : ''}`} aria-current={p.activeItem === 'quiz' ? 'page' : undefined} data-tip="题库练习：导入 JSON 组卷" aria-label="题库练习" onClick={p.onQuiz}>
          <IconQuiz />
          <span className="rail-label">题库练习</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'todo' ? ' on' : ''}`} aria-current={p.activeItem === 'todo' ? 'page' : undefined} data-tip="待办清单" aria-label="待办清单" onClick={p.onTodo}>
          <IconTodo />
          <span className="rail-label">待办清单</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'tag' ? ' on' : ''}`} aria-current={p.activeItem === 'tag' ? 'page' : undefined} data-tip="标签：按 #标签 聚合全库" aria-label="标签" onClick={p.onTag}>
          <IconTag />
          <span className="rail-label">标签</span>
        </button>
        <button className={`rail-btn${p.activeItem === 'dashboard' ? ' on' : ''}`} aria-current={p.activeItem === 'dashboard' ? 'page' : undefined} data-tip="学习统计：打卡 / 复习 / 错题" aria-label="学习统计" onClick={p.onDash}>
          <IconChart />
          <span className="rail-label">学习统计</span>
        </button>
      </div>
      <div className="rail-sep" />
      <div className="rail-section-label rail-section-label--bottom" aria-hidden={!expanded}>工具</div>
      <button className={`rail-btn${p.activeItem === 'ai' ? ' on' : ''}`} aria-current={p.activeItem === 'ai' ? 'page' : undefined} data-tip="AI 问答：内嵌网页问答" aria-label="AI 问答" onClick={p.onAi}>
        <IconAi />
        <span className="rail-label">AI 问答</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'agent' ? ' on' : ''}`} aria-current={p.activeItem === 'agent' ? 'page' : undefined} data-tip="AI 笔记：对话式检索与修改笔记（先预览后写入）" aria-label="AI 笔记" onClick={p.onAgent}>
        <IconAgent />
        <span className="rail-label">AI 笔记</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'draft' ? ' on' : ''}`} aria-current={p.activeItem === 'draft' ? 'page' : undefined} data-tip="智能草稿：讲义 / PDF 一键成笔记" aria-label="智能草稿" onClick={p.onDraft}>
        <IconWand />
        <span className="rail-label">智能草稿</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'history' ? ' on' : ''}`} aria-current={p.activeItem === 'history' ? 'page' : undefined} data-tip="历史版本：快照与误删找回" aria-label="历史版本" onClick={p.onHistory}>
        <IconHistory />
        <span className="rail-label">历史版本</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'import' ? ' on' : ''}`} aria-current={p.activeItem === 'import' ? 'page' : undefined} data-tip="导入：自动识别格式（笔记 / 题库 / Anki / 数据集 / Word·PDF），支持批量" aria-label="导入" onClick={p.onImport}>
        <IconRestore />
        <span className="rail-label">导入</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'convert' ? ' on' : ''}`} aria-current={p.activeItem === 'convert' ? 'page' : undefined} data-tip="格式转换：PDF / Word → Markdown" aria-label="格式转换" onClick={p.onConvert}>
        <IconConvert />
        <span className="rail-label">格式转换</span>
      </button>
      <button className="rail-btn" data-tip="关于、隐私与第三方许可" aria-label="关于与许可" onClick={p.onNotice}>
        <IconInfo />
        <span className="rail-label">关于与许可</span>
      </button>
      <div className="rail-sep" />
      <div className="rail-font-wrap">
        <button
          ref={fontButtonRef}
          className={`rail-btn rail-font-btn ${fontOpen ? 'on' : ''}`}
          data-tip={`切换字体（当前：${FONT_LABELS[font]}）`}
          aria-label="切换字体"
          aria-expanded={fontOpen}
          aria-controls="rail-font-options"
          onClick={() => setFontOpen((v) => !v)}
        >
          <span className="rail-font-glyph">Aa</span>
          <span className="rail-label">字体：{FONT_LABELS[font]}</span>
        </button>
        {fontOpen && (
          <div
            className="rail-flyout"
            id="rail-font-options"
            role="group"
            aria-label="字体样式"
            onMouseLeave={() => setFontOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFontOpen(false);
                fontButtonRef.current?.focus();
              }
            }}
          >
            {(['system', 'serif', 'mono'] as Font[]).map((f) => (
              <button
                key={f}
                type="button"
                className={font === f ? 'active' : ''}
                aria-pressed={font === f}
                onClick={() => { applyFont(f); setFont(f); setFontOpen(false); fontButtonRef.current?.focus(); }}
              >
                {FONT_LABELS[f]}
                {f === 'serif' ? ' · 阅读' : f === 'mono' ? ' · 代码' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 高亮色：与「字体」并列的阅读外观设置。默认醒目红，预设之外可用取色器自定义
          （颜色与反白/反黑字色都由 core/highlight.ts 落成 --hl-bg / --hl-ink）。 */}
      <div className="rail-font-wrap">
        <button
          ref={hlButtonRef}
          className={`rail-btn ${hlOpen ? 'on' : ''}`}
          data-tip={`切换高亮色（当前：${hlName ?? '自定义'}）`}
          aria-label="切换高亮色"
          aria-expanded={hlOpen}
          aria-controls="rail-highlight-options"
          onClick={() => setHlOpen((v) => !v)}
        >
          {/* 文字样张「A」+ 下半截染当前高亮色，与「字体」的「Aa」成对（见 .rail-hl-glyph 注释） */}
          <span
            className="rail-hl-glyph"
            style={{ '--hl-now': hl } as CSSProperties}
            aria-hidden="true"
          >A</span>
          <span className="rail-label">高亮色</span>
        </button>
        {hlOpen && (
          <div
            className="rail-flyout rail-hl-flyout"
            id="rail-highlight-options"
            role="group"
            aria-label="文本高亮色"
            onMouseLeave={() => setHlOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setHlOpen(false);
                hlButtonRef.current?.focus();
              }
            }}
          >
            {/* 点预设不关面板：换色要能当场在正文里比效果，关掉再开反而多两步 */}
            <div className="rail-hl-swatches">
              {HIGHLIGHT_PRESETS.map((preset) => (
                <button
                  key={preset.bg}
                  type="button"
                  className={`rail-hl-swatch${hl === preset.bg ? ' active' : ''}`}
                  style={{ background: preset.bg }}
                  aria-label={`高亮色：${preset.name}`}
                  aria-pressed={hl === preset.bg}
                  title={preset.name}
                  onClick={() => { applyHighlight(preset.bg); setHl(preset.bg); }}
                />
              ))}
            </div>
            <label className="rail-hl-custom">
              <span>自定义</span>
              <input
                type="color"
                value={hl}
                aria-label="自定义高亮色"
                onChange={(event) => { applyHighlight(event.target.value); setHl(event.target.value); }}
              />
            </label>
          </div>
        )}
      </div>
      <button
        className="rail-btn"
        data-tip={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label="切换主题"
        aria-pressed={theme === 'dark'}
        onClick={(event) => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          // 传点击坐标：core/theme.ts 据此做一次从按钮扩散的圆形揭示
          applyTheme(next, { x: event.clientX, y: event.clientY });
          setTheme(next);
        }}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
          <span className="rail-label">{theme === 'dark' ? '切换浅色主题' : '切换深色主题'}</span>
      </button>
    </nav>
  );
}
