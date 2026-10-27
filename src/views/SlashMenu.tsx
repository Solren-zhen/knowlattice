/**
 * 斜杠命令菜单：贴在光标下方的小列表。
 *
 * 为什么不用弹窗组件：它必须「不打断输入」——按 Esc 就消失、继续打字就继续过滤、
 * 菜单本身不能抢焦点（抢了焦点，再打字就打到菜单里去了）。
 * 所以这里只渲染，一切按键都在编辑器里处理（见 Editor 的 slashRef）。
 */
import type { SlashCommand } from '../core/slashCommands';

interface Props {
  items: SlashCommand[];
  active: number;
  /** 光标位置（视口坐标）；由 CodeMirror 的 coordsAtPos 给出 */
  x: number;
  y: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

export default function SlashMenu({ items, active, x, y, onPick, onHover }: Props) {
  if (!items.length) return null;
  // 贴边回收：菜单宽度按 260px 估，超出视口就左移/上移，别让最后一条看不见
  const width = 260;
  const left = Math.max(8, Math.min(x, (typeof window === 'undefined' ? 1440 : window.innerWidth) - width - 12));
  const flipUp = typeof window !== 'undefined' && y > window.innerHeight - 220;
  const style = flipUp
    ? { left, bottom: Math.max(8, (typeof window === 'undefined' ? 900 : window.innerHeight) - y + 20), width }
    : { left, top: y + 6, width };
  return (
    <div className="slash-menu" role="listbox" aria-label="斜杠命令" style={{ position: 'fixed', ...style }}>
      {items.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`slash-menu__item${i === active ? ' on' : ''}`}
          // mousedown 而不是 click：click 前会先 blur 编辑器，插入位置就丢了
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(cmd);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="slash-menu__label">{cmd.label}</span>
          <span className="slash-menu__hint">{cmd.hint}</span>
        </button>
      ))}
    </div>
  );
}
