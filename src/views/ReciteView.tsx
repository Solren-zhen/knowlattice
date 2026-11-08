/**
 * 全屏背诵：把分屏预览里的「背诵」放大成一整屏，只留正文。
 *
 * 为什么单开一个视图而不是把分屏拉宽：
 *   - 分屏时右栏宽度有限，长句折行多，读到一半就要滚；
 *   - 全屏后可以用空格逐条往下揭（手不用离开键盘），这是背诵真正需要的节奏。
 *
 * 与分屏背诵共用同一套渲染：`Preview` 传 `recite`，遮罩、读屏名、点击揭示全沿用，
 * 这里只负责「多一个容器 + 键盘 + 进度 + 结束留痕」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import PanelOverlay from './PanelOverlay';
import Preview from './Preview';
import { useEsc } from './useEsc';
import { recordRecite } from '../core/reciteLog';

interface Props {
  path: string;
  content: string;
  resolve?: (name: string) => string | null;
  onOpenLink?: (name: string) => void;
  readFile?: (path: string) => string | undefined;
  onClose: () => void;
}

/** 毫秒 → `m:ss`（超过 1 小时才显示 `h:mm:ss`） */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export default function ReciteView({ path, content, resolve, onOpenLink, readFile, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** 开始时刻只在 effect 里取：渲染期读时钟会被 React Compiler 判为不纯 */
  const startedAt = useRef(0);
  const closedRef = useRef(false);
  const [progress, setProgress] = useState({ revealed: 0, total: 0 });
  const [revealed, setRevealed] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  /** 从 DOM 重新量一次进度；`data-revealed` 是唯一事实，不另存镜像状态 */
  const sync = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    setProgress({
      total: root.querySelectorAll('.cloze-blank').length,
      revealed: root.querySelectorAll('.cloze-blank[data-revealed]').length,
    });
  }, []);

  /** 结束本轮：把「篇 / 条数 / 揭开数 / 时长」记下来，再关闭 */
  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const root = rootRef.current;
    const total = root?.querySelectorAll('.cloze-blank').length ?? 0;
    const revealed = root?.querySelectorAll('.cloze-blank[data-revealed]').length ?? 0;
    if (path && total > 0) {
      recordRecite({ path, total, revealed, ms: Date.now() - startedAt.current, at: Date.now() });
    }
    onClose();
  }, [path, onClose]);

  useEsc(close);

  /** 空格：揭下一条还没揭的；全部揭完就什么都不做（避免误触翻页） */
  const revealNext = useCallback(() => {
    setRevealed((prev) => {
      const total = rootRef.current?.querySelectorAll('.cloze-blank').length ?? 0;
      for (let i = 0; i < total; i++) if (!prev.includes(i)) return [...prev, i];
      return prev;
    });
  }, []);

  /** R：全部重新盖住，做第二遍 */
  const coverAll = useCallback(() => setRevealed([]), []);

  /** 点击某条：揭开 ↔ 盖回 */
  const toggleCloze = useCallback((index: number) => {
    if (index < 0) return;
    setRevealed((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') {
        // 全屏背诵里空格不滚动页面：它唯一的语义就是「揭下一条」
        e.preventDefault();
        revealNext();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        coverAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealNext, coverAll]);

  useEffect(() => {
    startedAt.current = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = formatMs(elapsedMs);
  const pct = progress.total > 0 ? Math.round((progress.revealed / progress.total) * 100) : 0;

  return (
    <PanelOverlay tone="plain" onClose={close}>
      <div className="recite-panel" role="dialog" aria-label="全屏背诵">
        <header className="recite-head">
          <span className="recite-title">背诵</span>
          <span className="recite-meta" aria-live="polite">
            {progress.total > 0 ? `${progress.revealed} / ${progress.total} 条` : '这篇没有挖空'}
            <span className="recite-dot">·</span>
            {elapsed}
          </span>
          <span className="recite-bar" aria-hidden="true">
            <span className="recite-bar__fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="recite-keys">
            <kbd>空格</kbd>揭下一条 <kbd>R</kbd>全部盖回 <kbd>Esc</kbd>结束
          </span>
          <button type="button" className="btn" onClick={close}>
            结束本轮
          </button>
        </header>
        <div className="recite-body" ref={rootRef}>
          <div className="recite-page">
            <Preview
              content={content}
              resolve={resolve}
              onOpenLink={onOpenLink}
              readFile={readFile}
              recite
              revealed={revealed}
              onToggleCloze={toggleCloze}
              onRendered={sync}
              onReciteChange={(revealedCount, total) => setProgress({ revealed: revealedCount, total })}
            />
          </div>
        </div>
      </div>
    </PanelOverlay>
  );
}
