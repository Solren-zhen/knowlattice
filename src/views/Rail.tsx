/**
 * 左侧导航轨（悬浮指挥台）：logo 回主页 + 功能入口 + 字体/主题切换。
 * 字体与主题状态只有导航轨在用，收敛在此；各面板开关由 Workspace 传入回调。
 */
import { useState } from 'react';
import {
  applyFont, applyTheme, currentFont, currentTheme, FONT_LABELS,
  type Font, type Theme,
} from '../core/theme';
import {
  IconLogo, IconTree, IconSearch, IconHistory, IconBody, IconBrain, IconGraph, IconCards,
  IconTarget, IconQuiz, IconTodo, IconTag, IconChart, IconAi, IconWand, IconBook,
  IconConvert, IconSun, IconMoon,
} from './icons';

interface Props {
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
}

export default function Rail(p: Props) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [font, setFont] = useState<Font>(currentFont);
  const [fontOpen, setFontOpen] = useState(false);

  return (
    <nav className="rail" aria-label="主导航">
      {/* 上组：窗口变矮时只有这一组在内部滚动。
          下组（AI / 草稿 / PDF / 转换 / 字体 / 主题）钉在底部、不参与滚动——
          这样字体飞出菜单仍留在不滚动的容器里，.rail 的 overflow:visible 不必动。
          此前整条轨靠 .rail-spacer 撑开：轨内容固定要 963px，窗口低于这个高度时下组
          直接溢出到视口外，而 overflow:visible 没有滚动条，那几个入口永远够不着。 */}
      <div className="rail-scroll">
        <button className="rail-logo" data-tip="回到主界面" aria-label="回到主界面" onClick={p.onHome}>
          <IconLogo />
        </button>
        <button
          className={`rail-btn ${p.treeOpen ? 'on' : ''}`}
          data-tip="目录：折叠 / 展开章节树"
          aria-label="目录"
          aria-pressed={p.treeOpen}
          onClick={p.onToggleTree}
        >
          <IconTree />
        </button>
        <button className="rail-btn" data-tip="快速搜索（Ctrl+K）" aria-label="搜索" onClick={p.onSearch}>
          <IconSearch />
        </button>
        <button className="rail-btn" data-tip="PDF 对照：左看右记 + 摘录历史" aria-label="PDF 对照" onClick={p.onPdf}>
          <IconBook />
        </button>
        <button className="rail-btn" data-tip="3D 解剖图谱：结构 ↔ 笔记双向打通" aria-label="解剖图谱" onClick={p.onAnatomy}>
          <IconBody />
        </button>
        <button className="rail-btn" data-tip="脑图谱：MNI152 模板 MRI 对照" aria-label="脑图谱" onClick={p.onBrain}>
          <IconBrain />
        </button>
        <button className="rail-btn" data-tip="知识图谱：全库双链网络图" aria-label="知识图谱" onClick={p.onGraph}>
          <IconGraph />
        </button>
        <div className="rail-sep" />
        <button className="rail-btn" data-tip="间隔复习（遗忘曲线）" aria-label="间隔复习" onClick={p.onReview}>
          <IconCards />
        </button>
        <button className="rail-btn" data-tip="错题本（薄弱点热力图）" aria-label="错题本" onClick={p.onMistake}>
          <IconTarget />
        </button>
        <button className="rail-btn" data-tip="题库练习：导入 JSON 组卷" aria-label="题库练习" onClick={p.onQuiz}>
          <IconQuiz />
        </button>
        <button className="rail-btn" data-tip="待办清单" aria-label="待办清单" onClick={p.onTodo}>
          <IconTodo />
        </button>
        <button className="rail-btn" data-tip="标签：按 #标签 聚合全库" aria-label="标签" onClick={p.onTag}>
          <IconTag />
        </button>
        <button className="rail-btn" data-tip="学习统计：打卡 / 复习 / 错题" aria-label="学习统计" onClick={p.onDash}>
          <IconChart />
        </button>
      </div>
      <div className="rail-sep" />
      <button className="rail-btn" data-tip="AI 助手：内嵌网页问答" aria-label="AI 助手" onClick={p.onAi}>
        <IconAi />
      </button>
      <button className="rail-btn" data-tip="智能草稿：讲义 / PDF 一键成笔记" aria-label="智能草稿" onClick={p.onDraft}>
        <IconWand />
      </button>
      <button className="rail-btn" data-tip="历史版本：快照与误删找回" aria-label="历史版本" onClick={p.onHistory}>
        <IconHistory />
      </button>
      <button className="rail-btn" data-tip="格式转换：PDF / Word → Markdown" aria-label="格式转换" onClick={p.onConvert}>
        <IconConvert />
      </button>
      <div className="rail-sep" />
      <div className="rail-font-wrap">
        <button
          className={`rail-btn rail-font-btn ${fontOpen ? 'on' : ''}`}
          data-tip={`切换字体（当前：${FONT_LABELS[font]}）`}
          aria-label="切换字体"
          onClick={() => setFontOpen((v) => !v)}
        >
          <span className="rail-font-glyph">Aa</span>
        </button>
        {fontOpen && (
          <div className="rail-flyout" onMouseLeave={() => setFontOpen(false)}>
            {(['system', 'serif', 'mono'] as Font[]).map((f) => (
              <div
                key={f}
                className={font === f ? 'active' : ''}
                onClick={() => { applyFont(f); setFont(f); setFontOpen(false); }}
              >
                {FONT_LABELS[f]}
                {f === 'serif' ? ' · 阅读' : f === 'mono' ? ' · 代码' : ''}
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        className="rail-btn"
        data-tip={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label="切换主题"
        onClick={() => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          setTheme(next);
        }}
      >
        {theme === 'dark' ? <IconSun /> : <IconMoon />}
      </button>
    </nav>
  );
}
