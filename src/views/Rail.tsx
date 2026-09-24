/**
 * 左侧导航轨：可展开分组标签 + 功能入口 + 字体/主题切换。
 * 字体与主题状态只有导航轨在用，收敛在此；各面板开关由 Workspace 传入回调。
 */
import { useEffect, useRef, useState } from 'react';
import {
  applyFont, applyTheme, currentFont, currentTheme, FONT_LABELS,
  type Font, type Theme,
} from '../core/theme';
import {
  IconLogo, IconTree, IconChevron, IconSearch, IconHistory, IconBody, IconBrain, IconGraph, IconCards,
  IconTarget, IconQuiz, IconTodo, IconTag, IconChart, IconAi, IconWand, IconBook,
  IconConvert, IconSun, IconMoon, IconInfo,
} from './icons';

interface Props {
  activeItem: string | null;
  treeOpen: boolean;
  onToggleTree: () => void;
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
  onDraft: () => void;
  onPdf: () => void;
  onConvert: () => void;
  onNotice: () => void;
}

export default function Rail(p: Props) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [font, setFont] = useState<Font>(currentFont);
  const [fontOpen, setFontOpen] = useState(false);
  const fontButtonRef = useRef<HTMLButtonElement>(null);
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
          此前整条轨靠 .rail-spacer 撑开：轨内容固定要 963px，窗口低于这个高度时下组
          直接溢出到视口外，而 overflow:visible 没有滚动条，那几个入口永远够不着。 */}
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
        <button className={`rail-btn${p.activeItem === 'graph' ? ' on' : ''}`} aria-current={p.activeItem === 'graph' ? 'page' : undefined} data-tip="知识图谱：全库双链网络图" aria-label="知识图谱" onClick={p.onGraph}>
          <IconGraph />
          <span className="rail-label">知识图谱</span>
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
      <button className={`rail-btn${p.activeItem === 'ai' ? ' on' : ''}`} aria-current={p.activeItem === 'ai' ? 'page' : undefined} data-tip="AI 助手：内嵌网页问答" aria-label="AI 助手" onClick={p.onAi}>
        <IconAi />
        <span className="rail-label">AI 助手</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'draft' ? ' on' : ''}`} aria-current={p.activeItem === 'draft' ? 'page' : undefined} data-tip="智能草稿：讲义 / PDF 一键成笔记" aria-label="智能草稿" onClick={p.onDraft}>
        <IconWand />
        <span className="rail-label">智能草稿</span>
      </button>
      <button className={`rail-btn${p.activeItem === 'history' ? ' on' : ''}`} aria-current={p.activeItem === 'history' ? 'page' : undefined} data-tip="历史版本：快照与误删找回" aria-label="历史版本" onClick={p.onHistory}>
        <IconHistory />
        <span className="rail-label">历史版本</span>
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
      <button
        className="rail-btn"
        data-tip={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label="切换主题"
        aria-pressed={theme === 'dark'}
        onClick={() => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          setTheme(next);
        }}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
          <span className="rail-label">{theme === 'dark' ? '切换浅色主题' : '切换深色主题'}</span>
      </button>
    </nav>
  );
}
