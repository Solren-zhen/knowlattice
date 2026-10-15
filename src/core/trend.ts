/**
 * 趋势折线图的几何（第 4 项）：纯函数，不碰 DOM，可脱离浏览器断言。
 *
 * 为什么单独一个模块：折线的坐标换算、指针位置→数据点（磁吸）这类东西一旦写进
 * 组件的 JSX，就只能靠肉眼看；抽出来之后「指针在两点之间时到底选中哪一个」
 * 是可以被测试钉死的（这正是磁吸手感的关键参数）。
 */

export interface TrendPoint {
  day: string;
  count: number;
  minutes: number;
}

/** 绘图区（viewBox 坐标，与真实像素无关；组件用 viewBox 缩放适配任意宽度） */
export interface TrendBox {
  width: number;
  /** 绘图区总高 */
  height: number;
  /** 左右内边距：首末点不贴边，圆点才不会被裁掉 */
  padX: number;
  /** 顶部内边距：留出折线最高点的呼吸位 */
  padTop: number;
  /** 底部内边距：给日期标签留位 */
  padBottom: number;
}

/** 默认绘图区：300×96 的 viewBox。宽高比与卡片内宽接近，缩放后线宽不失真 */
export const TREND_BOX: TrendBox = { width: 300, height: 96, padX: 12, padTop: 10, padBottom: 18 };

/** 纵轴上限：全 0 时也给 1，避免除零把线压到 NaN */
export function trendMax(points: readonly TrendPoint[]): number {
  let max = 0;
  for (const p of points) if (p.count > max) max = p.count;
  return Math.max(1, max);
}

/** 第 index 个点的 x：均匀分布；只有一个点时居中 */
export function trendX(index: number, total: number, box: TrendBox = TREND_BOX): number {
  const inner = box.width - box.padX * 2;
  if (total <= 1) return box.padX + inner / 2;
  const clamped = Math.min(Math.max(index, 0), total - 1);
  return box.padX + (inner * clamped) / (total - 1);
}

/** 值 → y：值越大越靠上 */
export function trendY(value: number, max: number, box: TrendBox = TREND_BOX): number {
  const usable = box.height - box.padTop - box.padBottom;
  const ratio = Math.min(Math.max(value / Math.max(max, 1), 0), 1);
  return box.padTop + (1 - ratio) * usable;
}

/** 折线路径："M x0 y0 L x1 y1 …" */
export function trendLinePath(points: readonly TrendPoint[], box: TrendBox = TREND_BOX): string {
  if (points.length === 0) return '';
  const max = trendMax(points);
  return points
    .map((p, i) => {
      const x = trendX(i, points.length, box).toFixed(2);
      const y = trendY(p.count, max, box).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}

/** 折线下方的面积路径（回到基线闭合），用于那层很淡的渐变填充 */
export function trendAreaPath(points: readonly TrendPoint[], box: TrendBox = TREND_BOX): string {
  if (points.length === 0) return '';
  const base = box.height - box.padBottom;
  const first = trendX(0, points.length, box).toFixed(2);
  const last = trendX(points.length - 1, points.length, box).toFixed(2);
  return `${trendLinePath(points, box)} L${last} ${base.toFixed(2)} L${first} ${base.toFixed(2)} Z`;
}

/**
 * 指针 x → 数据点下标（**磁吸**）。
 *
 * 「离谁近选谁」在数学上就是「越过相邻中点才换」——所以横向拖动天然是吸附的，
 * 不需要额外的吸附半径参数；手感上的差别只体现在松手时用弹簧把指示线收回
 * （见组件里的 SPRING.press）。
 */
export function pointAtX(x: number, total: number, box: TrendBox = TREND_BOX): number {
  if (total <= 1) return 0;
  const inner = box.width - box.padX * 2;
  const ratio = (x - box.padX) / inner;
  return Math.min(Math.max(Math.round(ratio * (total - 1)), 0), total - 1);
}

/** '2026-10-13' → '10-13'（横轴与读数都用它，避免长日期把标签挤在一起） */
export function trendShortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2]}-${m[3]}` : day;
}

/** 合计：底部说明与无障碍标签共用一份口径，避免两处各算一遍 */
export function trendTotals(points: readonly TrendPoint[]): { count: number; minutes: number } {
  let count = 0;
  let minutes = 0;
  for (const p of points) {
    count += p.count;
    minutes += p.minutes;
  }
  return { count, minutes };
}
