/**
 * 本页目录（笔记大纲）：关联面板首区。列出当前笔记的 #~#### 标题，
 * 点击跳转编辑器对应行；光标所在小节高亮（activeLine 由 Editor 经 Workspace 传下）。
 * 无标题时整块不渲染（不占空态噪音）。
 */
import { useEffect, useRef } from 'react';
import type { OutlineItem } from '../core/outline';

interface Props {
  outline: OutlineItem[];
  /** 光标所在小节的标题行号；null = 尚未定位（光标在首个标题之前） */
  activeLine: number | null;
  /** 跳转到指定行（Editor 注册的滚动+定位实现） */
  onJump: (line: number) => void;
}

export default function OutlinePanel({ outline, activeLine, onJump }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // 活动项滚进可视区：打字/移动光标跨节时，目录自动跟上（不滚动页面，只滚目录内列表）
  useEffect(() => {
    if (activeLine == null) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>('.outline-item.on');
    el?.scrollIntoView?.({ block: 'nearest' }); // jsdom 无 scrollIntoView
  }, [activeLine, outline]);

  return (
    <nav className="outline-panel" aria-label="本页目录">
      <div className="outline-head">本页目录</div>
      <div className="outline-list" ref={listRef}>
        {outline.map((o, i) => (
          <button
            key={`${o.line}-${i}`}
            type="button"
            className={`outline-item lv${o.level}${o.line === activeLine ? ' on' : ''}`}
            title={`跳转到「${o.text}」`}
            aria-current={o.line === activeLine ? 'location' : undefined}
            onClick={() => onJump(o.line)}
          >
            {o.text}
          </button>
        ))}
      </div>
    </nav>
  );
}
