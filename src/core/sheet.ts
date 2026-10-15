/**
 * 底部抽屉的物理（第 5 项）：锚点换算、橡皮筋越界、松手吸附、手势仲裁。
 *
 * 纯函数，不碰 DOM。手感参数只有三类，都能在这一个文件里看全：
 * 锚点（露出几成）、越界阻尼（橡皮筋）、松手判定（速度阈值）。
 * 弹簧本身复用 core/motion.ts 的 SPRING.sheet。
 */
import { pickSnapAnchor, rubberBand } from './motion';

/** 两档锚点：露出高度占视口的比例 —— 近处一档看列表，全开一档看长内容 */
export const SHEET_STOPS = [0.6, 0.94] as const;

/** 越界阻尼的参考尺寸：用可拖动行程（不是屏幕高），越界手感才不随屏幕大小漂 */
const RUBBER_TENSION = 0.55;

export interface SheetGeometry {
  /** 视口高（px） */
  viewport: number;
  /** 面板高度占视口的比例（取最大档，抽屉平时就占这么多，只是被推下去了） */
  panelFraction: number;
  /** 露出高度占比（升序） */
  stops: readonly number[];
}

export const DEFAULT_SHEET_GEOMETRY: SheetGeometry = {
  viewport: 800,
  panelFraction: SHEET_STOPS[SHEET_STOPS.length - 1],
  stops: SHEET_STOPS,
};

/**
 * 锚点 → 面板 translateY 列表（**升序**，供 pickSnapAnchor 使用）。
 * 0 = 全开（露出最大档），值越大越往下。
 */
export function sheetAnchors(geometry: SheetGeometry = DEFAULT_SHEET_GEOMETRY): number[] {
  const { viewport, panelFraction, stops } = geometry;
  return stops
    .map((stop) => viewport * (panelFraction - stop))
    .sort((a, b) => a - b);
}

/** 打开时停靠的锚点：最小 y（露出最多的一档），所以打开就是「已经拉到最高」 */
export function sheetOpenY(geometry: SheetGeometry = DEFAULT_SHEET_GEOMETRY): number {
  return sheetAnchors(geometry)[0] ?? 0;
}

/** 最大 y：拖到最下面时露出的那一档（再往下就是越界区，会被橡皮筋衰减） */
export function sheetRestY(geometry: SheetGeometry = DEFAULT_SHEET_GEOMETRY): number {
  const anchors = sheetAnchors(geometry);
  return anchors[anchors.length - 1] ?? 0;
}

/**
 * 拖拽位移：区间内 1:1 跟随，越界走橡皮筋（越拖越沉、且有上界）。
 * 参考尺寸取可拖动行程，手指越过 100px 大约只推动 50px —— 这正是「拉扯感」的来源。
 */
export function sheetDragY(
  raw: number,
  geometry: SheetGeometry = DEFAULT_SHEET_GEOMETRY,
): number {
  const min = sheetOpenY(geometry);
  const max = sheetRestY(geometry);
  const span = Math.max(max - min, 1);
  if (raw < min) return min - rubberBand(min - raw, span, RUBBER_TENSION);
  if (raw > max) return max + rubberBand(raw - max, span, RUBBER_TENSION);
  return raw;
}

/**
 * 松手后落到哪个锚点。
 * 慢放（|v| < 0.35px/ms）：离谁近去谁 —— 等价于「越过相邻锚点中点才换档」；
 * 快甩：按惯性投影落点取档。速度单位 px/ms，由 motion.velocityFromSamples 算。
 */
export function resolveSheetTarget(
  y: number,
  velocity: number,
  geometry: SheetGeometry = DEFAULT_SHEET_GEOMETRY,
): number {
  const anchors = sheetAnchors(geometry);
  const index = pickSnapAnchor(y, velocity, anchors);
  return anchors[index < 0 ? 0 : index];
}

/**
 * 手势仲裁：这次纵向拖动该由抽屉接管，还是交还给内容滚动？
 *
 * 判据三条（缺一条就会出现「想滚列表结果把抽屉拉走了」）：
 * 1) 抽屉是开着的；
 * 2) 内容已经滚到顶（scrollTop === 0）——否则先滚内容；
 * 3) 这一次拖动确实是「往下推抽屉」（dy > 0）且纵向意图大于横向（不是横向滑日期）。
 */
export function claimSheetDrag(input: {
  open: boolean;
  scrollTop: number;
  dy: number;
  dx?: number;
}): boolean {
  const { open, scrollTop, dy, dx = 0 } = input;
  if (!open) return false;
  if (scrollTop > 0) return false;
  if (dy <= 0) return false;
  return Math.abs(dy) > Math.abs(dx);
}
