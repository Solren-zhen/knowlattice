import { useCallback, useEffect, useState } from 'react';

/**
 * 全局划词 → 问 AI。
 *
 * 为什么放在文档层而不是编辑器里：要选的东西不只有 CodeMirror 的正文——AI 回答、复习卡、
 * 思维导图、表格预览里的文字同样是「想追一句」的对象。挂在 document 上，哪一处选中都算。
 *
 * 三件事不做：
 * - 不接管已有选区（面板/对话框/AI 面板自己的选区各有各的按钮，这里一律让开）；
 * - 不跨面板：选中浮动按钮只出现在正文区，浮层里选中不弹第二个按钮；
 * - 不留残影：滚动、缩放、Esc、点空白都立即收起。
 */
const BLOCKED = [
  '.agent-panel', '.panel-backdrop', '.panel', '.dialog-surface', '.rail',
  '.toast-host', '.sel-ask', 'input', 'textarea', 'select',
].join(', ');

/** 太短没得问（一个字），太长就不是「问一句」而是整篇搬运 */
const MIN_CHARS = 2;
const MAX_CHARS = 4000;

interface Spot {
  text: string;
  top: number;
  left: number;
}

export default function SelectionAsk({
  path,
  onAsk,
}: {
  /** 选区所属笔记（当前打开的那篇）；不在笔记里选中时为 null */
  path: string | null;
  onAsk: (quote: { text: string; path: string | null; ask?: string }) => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);

  const measure = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSpot(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) {
      setSpot(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || el.closest(BLOCKED)) {
      setSpot(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // 选区在折叠的 <details> 或 display:none 里：没有可放按钮的位置
      setSpot(null);
      return;
    }
    // 按钮浮在选区上方一点点；贴边时夹回视口内，否则会有一半在屏幕外点不到
    const left = Math.min(Math.max(rect.left + rect.width / 2, 68), window.innerWidth - 68);
    const top = rect.top > 52 ? rect.top - 40 : rect.bottom + 10;
    setSpot({ text, top, left });
  }, []);

  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.sel-ask')) return; // 点按钮自己：别把按钮先收掉
      // 等浏览器把选区落定再量：mouseup 同一个 tick 里 getSelection 还是旧值
      setTimeout(measure, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSpot(null);
      else setTimeout(measure, 0);
    };
    const hide = () => setSpot(null);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [measure]);

  if (!spot) return null;
  return (
    <button
      type="button"
      className="sel-ask"
      style={{ top: spot.top, left: spot.left }}
      aria-label="用选中的文字问 AI"
      title="用选中的文字问 AI（会作为引用带进对话）"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onAsk({ text: spot.text, path });
        setSpot(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      问 AI
    </button>
  );
}
