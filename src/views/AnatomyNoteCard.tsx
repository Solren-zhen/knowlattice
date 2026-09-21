/**
 * M5+ · 结构笔记卡片：点 3D 结构（或右侧结构列表）后浮现在点击点旁，
 * 直接把该结构对应笔记的正文摊开给你看；没有笔记时给一键创建入口。
 *
 * 定位：卡片挂在 3D 舞台内，位置按点击点算并夹紧在舞台边界内（见 core/anatomyCard）。
 * 首次绘制前用 useLayoutEffect 量尺寸，所以不会出现「先闪在角落再跳到光标旁」。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadZhDict, zhOrganName, type ManifestOrgan } from '../core/anatomy';
import { CARD_ESTIMATE, placeCard, resolveAnatomyNotePath, type CardSize } from '../core/anatomyCard';
import Preview from './Preview';
import { IconClose } from './icons';

interface Props {
  organ: ManifestOrgan;
  /** 点击点（视口坐标）；null = 从结构列表选中 → 停靠在舞台左上角 */
  anchor: { x: number; y: number } | null;
  /** 3D 舞台元素：卡片位置相对它计算 */
  stage: HTMLElement | null;
  /** 名称 → vault 路径（vault.resolveLink） */
  resolve: (name: string) => string | null;
  /** vault 路径 → 内容（vault.readFile） */
  readFile: (path: string) => string | undefined;
  /** 打开 / 创建该结构的笔记（走编辑器） */
  onOpenNote: (organ: ManifestOrgan) => void;
  /** 卡片正文里的 [[双链]] 点击 */
  onOpenLink: (name: string) => void;
  onClose: () => void;
}

export default function AnatomyNoteCard({
  organ, anchor, stage, resolve, readFile, onOpenNote, onOpenLink, onClose,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [zhOrgans, setZhOrgans] = useState<Map<string, string> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 中文词典与浏览器/3D 视图共用同一份缓存，这里不会产生额外请求
  useEffect(() => {
    void loadZhDict().then((d) => setZhOrgans(d.organs));
  }, []);

  const zhName = zhOrgans ? zhOrganName(organ.name_en, zhOrgans) : null;
  const notePath = useMemo(
    () => resolveAnatomyNotePath(resolve, organ, zhName),
    [resolve, organ, zhName]
  );
  // 笔记不存在时给 null，由卡片走「还没有笔记」空态
  const content = notePath ? readFile(notePath) ?? null : null;

  /** 落位：读舞台与卡片真实尺寸后夹紧（layout effect 在绘制前完成，不会闪一下再跳） */
  const reposition = useCallback(() => {
    const el = cardRef.current;
    if (!el || !stage) return;
    const s = stage.getBoundingClientRect();
    const size: CardSize = el.offsetWidth && el.offsetHeight
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : CARD_ESTIMATE;
    setPos(placeCard(anchor, { left: s.left, top: s.top, width: s.width, height: s.height }, size));
  }, [anchor, stage]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, content]);

  // 舞台尺寸变化（窗口缩放 / 侧栏开合）与卡片自身高度变化（笔记正文异步渲染完）都要重新夹紧。
  // 只改 left/top、不改尺寸，因此不会与 ResizeObserver 形成回环。
  useEffect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => reposition());
    ro.observe(stage);
    if (cardRef.current) ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [stage, reposition]);

  return (
    <div
      ref={cardRef}
      className="anatomy-note-card"
      role="dialog"
      aria-label={`${zhName ?? organ.name_en} 的笔记卡片`}
      // 量到尺寸前先隐藏：避免未定位的卡片在舞台左上角闪一帧
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="anatomy-note-card__head">
        <div className="anatomy-note-card__title">
          <span className="anatomy-note-card__name">{zhName ?? organ.name_en}</span>
          {zhName && <span className="anatomy-note-card__en">{organ.name_en}</span>}
        </div>
        <button className="btn-icon" onClick={onClose} aria-label="关闭笔记卡片" title="关闭卡片（Esc）">
          <IconClose />
        </button>
      </div>

      <div className="anatomy-note-card__meta muted">
        {organ.path.length > 0 ? organ.path.join(' › ') : '系统根结构'}
      </div>

      <div className="anatomy-note-card__body">
        {content !== null ? (
          <Preview
            content={content}
            resolve={resolve}
            readFile={readFile}
            onOpenLink={onOpenLink}
          />
        ) : (
          <div className="anatomy-note-card__empty">
            <p>这个结构还没有笔记</p>
            <p className="muted">建一篇之后，以后点它就能直接看到内容。</p>
          </div>
        )}
      </div>

      <div className="anatomy-note-card__foot">
        <button
          className="btn-primary anatomy-note-card__cta"
          onClick={() => onOpenNote(organ)}
        >
          {content !== null ? '在编辑器中打开 →' : '创建笔记 →'}
        </button>
        <span className="anatomy-note-card__path muted" title={notePath ?? ''}>
          {notePath ?? '（尚未创建）'}
        </span>
      </div>
    </div>
  );
}
