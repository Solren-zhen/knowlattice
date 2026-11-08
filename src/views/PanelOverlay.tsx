/**
 * 全屏面板的遮罩层：`panel-backdrop` 的**唯一出口**。
 *
 * 之前 18 个视图各自拼这一层（共 28 处），同时踩两个坑：
 *   ① 「点面板外面才关」靠内层手写 `stopPropagation` 保证。忘写的那几处就变成
 *      「点面板里任何地方都关闭」——题库答题中点错一下就弹「确定退出」。
 *   ② 色调 class（`quiz-overlay` / `mistake-overlay` / `qs-overlay`）散落在各处，
 *      改层级或改模糊度要全库搜，改漏一处就是「面板发暗、发糊、点不到」。
 *
 * 这里只收口两件事：class 与 z-index 口径、点击判定（用 `target === currentTarget`
 * 代替内层 stopPropagation —— 内层写不写都对）。
 *
 * **Esc 不接管**：各面板走 `core/escStack` 的显式栈（`useEsc`），那套已经能正确处理
 * 嵌套面板「一次 Esc 只关最上面一层」。在这里再挂一层会让同一次 Esc 关掉两层。
 */
import type { MouseEvent, ReactNode } from 'react';

/**
 * 遮罩色调。决定层高与背景强度，取值与 `07-hero-theme.css` 里既有规则一一对应：
 * - `plain`   默认（86 层，半透明 + 模糊）
 * - `quiz`    题库系面板（86 层）
 * - `mistakes` 错题 / 报告 / 待办系（86 层）
 * - `search`  快速搜索 / 命令面板（100 层，必须压过所有面板）
 */
export type OverlayTone = 'plain' | 'quiz' | 'mistakes' | 'search';

const TONE_CLASS: Record<OverlayTone, string> = {
  plain: '',
  quiz: 'quiz-overlay',
  mistakes: 'mistake-overlay',
  search: 'qs-overlay',
};

interface Props {
  tone?: OverlayTone;
  /** 点遮罩（不含面板内部）时调用。不传 = 这一层不可关闭（加载中 / 考试进行中） */
  onClose?: () => void;
  children: ReactNode;
  /** 追加的 class（少数面板需要叠自己的遮罩修饰类） */
  className?: string;
}

export default function PanelOverlay({ tone = 'plain', onClose, children, className }: Props) {
  // target 判定而不是 stopPropagation：内层有没有写 stopPropagation 都不影响结果
  const handleClick = onClose
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
      }
    : undefined;

  const classes = ['panel-backdrop', TONE_CLASS[tone], className].filter(Boolean).join(' ');

  return (
    <div className={classes} data-overlay={tone} onClick={handleClick}>
      {children}
    </div>
  );
}
