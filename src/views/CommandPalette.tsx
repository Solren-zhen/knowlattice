/**
 * 命令面板（Ctrl/⌘+Shift+P）。
 *
 * 与 Ctrl+K 快速搜索分工：Ctrl+K 找**笔记**，这里执行**动作**（切视图、保存、导出、背题）。
 * 样式直接复用 .qs-* 一套（同一块「浮层 + 输入 + 列表」），不新造视觉，
 * 也保证键盘行为（↑↓ 选择、回车执行、Esc 关闭）与搜索面板一致——两处手感不同会被当成 bug。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc } from './useEsc';
import { useDialogDrag } from './usePanelDrag';
import { matchCommands, type CommandDef } from '../core/commands';

export interface PaletteCommand extends CommandDef {
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => matchCommands(commands, query, 12), [commands, query]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // 高亮行滚进视口：否则按回车执行的是用户没看见的那一条
  useEffect(() => {
    const el = listRef.current?.querySelectorAll('.qs-item')[sel] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [sel, rows.length]);

  useEsc(onClose, true);
  // 命令面板也能拖动：拖开后能同时看到底下的内容再执行动作
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDialogDrag(() => panelRef.current);

  const pick = (i: number) => {
    const cmd = rows[i];
    onClose();
    // 先关面板再执行：命令可能打开另一个浮层（题库/导入），同时挂两个浮层会抢焦点
    cmd?.run();
  };

  return (
    <div className="panel-backdrop qs-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className="panel qs-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
        onPointerDown={drag.onPointerDown}
        style={drag.style}
      >
        <input
          ref={inputRef}
          className="qs-input"
          placeholder="输入命令…（切换视图、保存、导出；↑↓ 选择，回车执行，Esc 关闭）"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, Math.max(0, rows.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(sel);
            }
          }}
        />
        <div className="qs-results" ref={listRef}>
          {rows.length === 0 && <div className="qs-empty">没有匹配「{query}」的命令</div>}
          {rows.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`qs-item ${i === sel ? 'active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <div className="qs-title">{cmd.title}</div>
              <div className="qs-snippet">{cmd.group ?? ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
