/**
 * 底部抽屉（第 5 项）：窄屏下的浮层容器。
 *
 * 为什么做成通用组件而不是给搜索写死：抽屉真正的难点是「手势仲裁 + 结束条件」，
 * 与装什么内容无关；把它做成受控容器（open / onClose / children），换内容只是换 children。
 * 当前唯一的接入点是窄屏（≤700px）的快速搜索 —— 桌面端保持原有的居中弹窗不变。
 *
 * 复用而不是另造：焦点陷阱、inert 兄弟节点、关闭后焦点归还全部交给 DialogSurface
 * （它就是仓库里所有模态的底座）；Esc 走 core/escStack 的 useEsc，打开顺序不会乱。
 *
 * 手感参数都在 core/sheet.ts 里（锚点、橡皮筋、吸附阈值），这里只负责把物理接到 DOM。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc } from './useEsc';
import {
  SPRING,
  isResting,
  pushSample,
  springStep,
  velocityFromSamples,
  type PointerSample,
  type SpringState,
} from '../core/motion';
import { motionAllowed } from '../core/motionPrefs';
import {
  DEFAULT_SHEET_GEOMETRY,
  claimSheetDrag,
  resolveSheetTarget,
  sheetDragY,
  sheetOpenY,
  sheetRestY,
  type SheetGeometry,
} from '../core/sheet';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 无障碍名称（DialogSurface 会放到 aria-label） */
  label: string;
  children: ReactNode;
  /** 露出高度占视口的比例（升序）；默认两档：近处看列表 / 全开看长内容 */
  stops?: readonly number[];
}

/** 判定「算拖动而不是点按」的阈值（px） */
const DRAG_SLOP = 4;
/** 松手时这一档之下再甩一下 = 关掉（px/ms） */
const CLOSE_FLICK = 0.6;
/** 拖过头多少像素后松手 = 关掉 */
const CLOSE_OVERSHOOT = 48;

export default function BottomSheet({ open, onClose, label, children, stops }: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const yRef = useRef(0);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const samplesRef = useRef<PointerSample[]>([]);
  const dragRef = useRef<{ id: number; startY: number; claimed: boolean } | null>(null);
  const geometryRef = useRef<SheetGeometry>(DEFAULT_SHEET_GEOMETRY);
  const [dragging, setDragging] = useState(false);
  /** 退场动画进行中：遮罩可点、Esc 可再按，用它挡住重复触发 */
  const closingRef = useRef(false);

  // beginClose 是函数声明（会被提升），所以这里可以先引用、后定义
  useEsc(beginClose, open);

  const geometry = (): SheetGeometry => {
    const viewport = typeof window === 'undefined' ? DEFAULT_SHEET_GEOMETRY.viewport : window.innerHeight;
    const list = stops && stops.length > 0 ? stops : DEFAULT_SHEET_GEOMETRY.stops;
    return { viewport, panelFraction: list[list.length - 1], stops: list };
  };

  const apply = (y: number) => {
    yRef.current = y;
    const el = sheetRef.current;
    if (el) el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
  };

  const stopAnim = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  /**
   * 关闭：先播一段退场，再真正卸载。
   *
   * 松手那一刻速度最大，直接 onClose() 会让抽屉一帧消失、把刚测出的速度丢掉；
   * 而打开与拖拽中松手都走了弹簧 —— 同一个手势两种结果，读起来像页面崩了一下。
   * 曲线沿用仓库既有的退场语汇 --t-exit(160ms) + --ease-in，与 .mv-toast 一致。
   *
   * 用函数声明而不是 const 箭头：需要被上面的 useEsc 引用（声明提升）。
   */
  function beginClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    const el = sheetRef.current;
    if (!motionAllowed() || !el) {
      onClose();
      return;
    }
    stopAnim();
    el.style.pointerEvents = 'none'; // 退场途中不再接受拖动
    el.style.transition = 'transform var(--t-exit) var(--ease-in)';
    el.style.transform = `translate3d(0, ${geometryRef.current.viewport}px, 0)`;
    window.setTimeout(onClose, 170); // --t-exit 160ms + 10ms 余量
  }

  /** 用弹簧把抽屉送到目标位移；到位即停（不常驻 rAF） */
  const springTo = (target: number) => {
    stopAnim();
    if (!motionAllowed()) {
      apply(target);
      return;
    }
    let state: SpringState = { x: yRef.current, v: 0 };
    lastTsRef.current = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(Math.max((now - lastTsRef.current) / 1000, 0), 1 / 30);
      lastTsRef.current = now;
      state = springStep(state, target, SPRING.sheet, dt);
      apply(state.x);
      if (isResting(state, target, 0.5, 20)) {
        apply(target);
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // 打开：从屏幕下方弹到「近处那一档」；关闭：先播退场再卸载（见 beginClose）
  useEffect(() => {
    if (!open) return;
    // 重新打开：清掉上一次退场留下的内联 transition / pointer-events 与关闭标记。
    // 不清 transition 的话，下面 springTo 逐帧写 transform 会被那条 160ms 过渡拖住，
    // 弹簧会被抹平成一坨缓动。
    closingRef.current = false;
    const el = sheetRef.current;
    if (el) {
      el.style.removeProperty('transition');
      el.style.removeProperty('pointer-events');
    }
    geometryRef.current = geometry();
    const target = sheetOpenY(geometryRef.current);
    if (!motionAllowed()) {
      apply(target);
      return;
    }
    apply(geometryRef.current.viewport);
    springTo(target);
    return stopAnim;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 视口变化（手机横竖屏、软键盘）：锚点跟着重算，保持在当前那一档
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const next = geometry();
      const previous = geometryRef.current;
      const wasOpen = yRef.current <= sheetOpenY(previous) + 1;
      geometryRef.current = next;
      apply(wasOpen ? sheetOpenY(next) : Math.min(yRef.current, sheetRestY(next)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (rafRef.current) stopAnim();
    // 手柄直接归抽屉管；内容区先按「滚动优先」处理，够到顶再交给抽屉
    const onHandle = (e.target as Element).closest('.sheet-handle') !== null;
    dragRef.current = { id: e.pointerId, startY: e.clientY, claimed: onHandle };
    samplesRef.current = [];
    setDragging(onHandle);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    const dx = e.movementX ?? 0;
    samplesRef.current = pushSample(samplesRef.current, { x: e.clientY, t: performance.now() });
    if (!drag.claimed) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      const claimed = claimSheetDrag({
        open,
        scrollTop: bodyRef.current?.scrollTop ?? 0,
        dy,
        dx,
      });
      if (!claimed) return;
      drag.claimed = true;
      setDragging(true);
    }
    apply(sheetDragY(sheetOpenY(geometryRef.current) + dy, geometryRef.current));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!drag?.claimed) return;
    const geometryNow = geometryRef.current;
    const rest = sheetRestY(geometryNow);
    const y = yRef.current;
    if (y > rest + CLOSE_OVERSHOOT) {
      beginClose();
      return;
    }
    const velocity = velocityFromSamples(samplesRef.current);
    const target = resolveSheetTarget(y, velocity, geometryNow);
    // 已经停在最下面那一档时再往下甩：直接关（抽屉的常规退出方式）
    if (target >= rest && velocity > CLOSE_FLICK) {
      beginClose();
      return;
    }
    springTo(target);
  };

  if (!open) return null;

  return (
    <>
      <div className="sheet-backdrop" onClick={beginClose} />
      <div
        className={`sheet${dragging ? ' is-dragging' : ''}`}
        ref={sheetRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <DialogSurface label={label} className="sheet-panel">
          <div className="sheet-handle" aria-hidden="true" />
          <div className="sheet-body" ref={bodyRef}>
            {children}
          </div>
        </DialogSurface>
      </div>
    </>
  );
}
