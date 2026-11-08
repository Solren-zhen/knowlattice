/**
 * 桌宠「晶灵」：页面角落的一枚晶体精灵。
 *
 * 它是「陪伴」不是「入口」：不抢焦点、不遮主操作、可拖走、可关掉。
 * 角色用 SVG 几何面画（没有位图资产），颜色全部走主题 token：
 *   深色 / 浅色 / 轻量三个主题下都能自己重新着色。
 *
 * 交互：
 *   - 待机浮动 + 眨眼；点击说一句知识库提示（4 秒后收起）；
 *   - 按住拖动改位置，松手写盘；窗口变化时把坐标夹回视口；
 *   - 右上角关闭 = 隐藏，设置面板「桌宠：显示」可恢复。
 *
 * 为什么要手动管指针捕获：拖动中指针移出按钮时，不捕获就会丢 move 事件；
 * jsdom 没有 setPointerCapture，所以包了 try/catch，测试环境退回普通事件。
 */
import {
  useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react';
import { IconClose } from './icons';
import PetFigure from './PetFigure';
import { loadPetImage } from '../core/petImage';
import {
  clampPet, loadPet, nextPetLine, savePet, setPetHidden, subscribePet,
} from '../core/pet';

const DRAG_THRESHOLD = 5;

export default function Pet() {
  const [pet, setPet] = useState(() => loadPet());
  const [line, setLine] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lineTimer = useRef(0);
  const suppressClick = useRef(false);
  const drag = useRef<{
    id: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const moveHandler = useRef<((event: PointerEvent) => void) | null>(null);
  const upHandler = useRef<((event: PointerEvent) => void) | null>(null);

  // 设置面板改了显隐，这里跟着同步
  useEffect(() => subscribePet(() => setPet(loadPet())), []);

  // 上传的图片：从 IndexedDB 读 Blob 转 objectURL；开关关掉或组件卸载时回收
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    // 两支都在微任务里落状态，避免在 effect 里同步 setState（React Compiler 告警）
    void (pet.image
      ? loadPetImage().then((blob) => {
          if (disposed || !blob) return;
          url = URL.createObjectURL(blob);
          setImageUrl(url);
        }).catch(() => { /* 读不到就继续用晶体角色 */ })
      : Promise.resolve().then(() => { if (!disposed) setImageUrl(null); }));
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [pet.image]);

  // 窗口变窄 / 换屏：把拖拽过的坐标夹回来（默认位置由 CSS 的 right/bottom 负责，
  // 不写死坐标，所以窗口怎么变它都贴着自己的角落）。
  useEffect(() => {
    if (pet.hidden || pet.x == null) return;
    const clampIntoView = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pos = clampPet(
        rect.left, rect.top, rect.width, rect.height,
        document.documentElement.clientWidth, document.documentElement.clientHeight,
      );
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    };
    clampIntoView(); // 直接以窄屏打开时不会有 resize 事件，先夹一次
    window.addEventListener('resize', clampIntoView);
    return () => window.removeEventListener('resize', clampIntoView);
  }, [pet.hidden, pet.x]);

  useEffect(() => () => window.clearTimeout(lineTimer.current), []);

  // 拖拽监听挂在 window 上，组件卸载时必须收回（hook 必须在早退之前）
  const detachDrag = useCallback(() => {
    if (moveHandler.current) window.removeEventListener('pointermove', moveHandler.current);
    if (upHandler.current) {
      window.removeEventListener('pointerup', upHandler.current);
      window.removeEventListener('pointercancel', upHandler.current);
    }
    moveHandler.current = null;
    upHandler.current = null;
  }, []);
  useEffect(() => detachDrag, [detachDrag]);

  if (pet.hidden) return null;

  const showLine = () => {
    setLine((previous) => nextPetLine(previous ?? undefined));
    window.clearTimeout(lineTimer.current);
    lineTimer.current = window.setTimeout(() => setLine(null), 4200);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const current = {
      id: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    drag.current = current;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* jsdom */ }
    setDragging(true);

    // move / up 挂到 window：指针常常在按钮外抬起（拖到卡片或面板上），
    // 只监听按钮自己的 pointerup 会收不到，位置就一直没落盘。
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== current.id) return;
      const dx = moveEvent.clientX - current.startX;
      const dy = moveEvent.clientY - current.startY;
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.moved = true;
      const node = rootRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const pos = clampPet(
        moveEvent.clientX - current.offsetX,
        moveEvent.clientY - current.offsetY,
        box.width, box.height,
        document.documentElement.clientWidth, document.documentElement.clientHeight,
      );
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== current.id) return;
      detachDrag();
      drag.current = null;
      setDragging(false);
      if (!current.moved) return;
      suppressClick.current = true; // 拖完的那次 click 不算「点它」
      const node = rootRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const pos = clampPet(
        box.left, box.top, box.width, box.height,
        document.documentElement.clientWidth, document.documentElement.clientHeight,
      );
      const next = { ...loadPet(), x: Math.round(pos.x), y: Math.round(pos.y) };
      savePet(next);
      setPet(next);
    };

    moveHandler.current = onMove;
    upHandler.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const style: CSSProperties & Record<string, string | number> = {
    ...(pet.x == null || pet.y == null ? {} : { left: pet.x, top: pet.y, right: 'auto', bottom: 'auto' }),
  };
  if (pet.color) style['--pet-accent'] = pet.color;
  const bubbleRight = pet.x == null || pet.x > document.documentElement.clientWidth / 2;

  return (
    <div
      ref={rootRef}
      className={`pet pet--${pet.size}${dragging ? ' is-dragging' : ''}`}
      style={style}
      data-pet
    >
      {line && (
        <div className={`pet-bubble${bubbleRight ? ' pet-bubble--right' : ''}`} role="status">
          {line}
        </div>
      )}
      <button
        type="button"
        className="pet-figure"
        aria-label={`${pet.name}：点一下，换一句提示；按住可以拖动`}
        title={pet.name}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          showLine();
        }}
        onPointerDown={onPointerDown}
      >
        {imageUrl
          ? <img className="pet-img" src={imageUrl} alt="" draggable={false} />
          : <PetFigure face={pet.face} accessory={pet.accessory} />}
      </button>
      <button
        type="button"
        className="pet-close"
        aria-label={`隐藏${pet.name}`}
        title="隐藏桌宠（可在设置里恢复）"
        onClick={(event) => {
          event.stopPropagation();
          setPetHidden(true);
        }}
      >
        <IconClose size={13} />
      </button>
    </div>
  );
}
