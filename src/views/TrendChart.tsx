/**
 * 趋势折线 + 横向拖动查看（第 4 项）。
 *
 * 取舍说明（为什么把 7 根柱子换成 14 天折线）：
 * - 7 个点做横向拖动余量太短，指头一动就到底；14 天才有「翻过去看」的空间；
 * - 14 根柱子会变成一把梳齿，同密度下折线更好读；
 * - 卡片高度与排版一点没变（还是 `.wb-card` + 标题 + 底部说明），页面节奏不动。
 *
 * 交互：横向拖动（磁吸到最近的点，见 core/trend.pointAtX）、点按跳点、←/→ 逐日、
 * Home/End 到两端。读数用等宽数字，索引变化时滚动过去（不闪烁、不跳字）。
 * 指针只在横向被捕获（`touch-action: pan-y`），纵向仍然翻页，不抢手势。
 */
import { useEffect, useRef, useState } from 'react';
import {
  SPRING,
  isResting,
  springStep,
  type SpringState,
} from '../core/motion';
import { motionAllowed } from '../core/motionPrefs';
import {
  TREND_BOX,
  pointAtX,
  trendAreaPath,
  trendLinePath,
  trendShortDay,
  trendTotals,
  trendX,
  trendY,
  trendMax,
  type TrendPoint,
} from '../core/trend';

interface Props {
  points: readonly TrendPoint[];
  /** 无障碍名称 */
  label?: string;
}

export default function TrendChart({ points, label = '专注趋势：可横向拖动查看每一天' }: Props) {
  const total = points.length;
  const [index, setIndex] = useState(() => Math.max(0, total - 1));
  const [display, setDisplay] = useState(() => Math.max(0, total - 1));
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const draggingRef = useRef(false);
  const plotRef = useRef<HTMLDivElement>(null);

  // 数据变短（例如切了日期范围）时把索引收回合法区间
  useEffect(() => {
    setIndex((i) => Math.min(Math.max(i, 0), Math.max(0, total - 1)));
  }, [total]);

  // 读数滚动：把浮点索引弹簧到目标整数，途中会经过中间那几天（这就是「滚动计数器」）
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (!motionAllowed() || draggingRef.current) {
      setDisplay(index);
      return;
    }
    let state: SpringState = { x: display, v: 0 };
    lastTsRef.current = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(Math.max((now - lastTsRef.current) / 1000, 0), 1 / 30);
      lastTsRef.current = now;
      state = springStep(state, index, SPRING.press, dt);
      if (isResting(state, index, 0.005, 0.05)) {
        setDisplay(index);
        rafRef.current = 0;
        return;
      }
      setDisplay(state.x);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // display 只作为起点读一次，不进依赖：否则每帧都会重启弹簧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (total === 0) {
    return <p className="muted wb-tip">还没有专注记录。</p>;
  }

  const max = trendMax(points);
  const shown = points[Math.min(Math.max(Math.round(display), 0), total - 1)];
  const totals = trendTotals(points);
  const selectedX = trendX(index, total);
  const selectedY = trendY(points[index]?.count ?? 0, max);
  const baseline = TREND_BOX.height - TREND_BOX.padBottom;
  const hasData = totals.count > 0;

  /** 指针位置 → 数据点（磁吸），拖动期间读数直接跟手 */
  const track = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const x = ratio * TREND_BOX.width;
    draggingRef.current = true;
    const next = pointAtX(x, total);
    setIndex(next);
    setDisplay(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    track(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    track(e.clientX);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const jump = (next: number) => {
      e.preventDefault();
      setIndex(Math.min(Math.max(next, 0), total - 1));
    };
    if (e.key === 'ArrowLeft') jump(index - 1);
    else if (e.key === 'ArrowRight') jump(index + 1);
    else if (e.key === 'Home') jump(0);
    else if (e.key === 'End') jump(total - 1);
  };

  const firstDay = trendShortDay(points[0].day);
  const midDay = trendShortDay(points[Math.floor((total - 1) / 2)].day);
  const lastDay = trendShortDay(points[total - 1].day);

  return (
    <div className="trend">
      <div className="trend-readout" aria-hidden="true">
        <b>{shown?.count ?? 0}</b>
        <span>个周期</span>
        <span className="trend-sep">·</span>
        <span>{shown?.minutes ?? 0} 分钟</span>
        <span className="trend-day">{trendShortDay(shown?.day ?? '')}</span>
      </div>

      <div
        className="trend-plot"
        ref={plotRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total - 1}
        aria-valuenow={index}
        aria-valuetext={`${trendShortDay(points[index]?.day ?? '')}：${points[index]?.count ?? 0} 个专注周期 · ${points[index]?.minutes ?? 0} 分钟`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <svg viewBox={`0 0 ${TREND_BOX.width} ${TREND_BOX.height}`} aria-hidden="true">
          <defs>
            <linearGradient id="trend-stroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.75" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* 基线：一条就够，两条以上在这种小图里会变成噪声 */}
          <line
            x1={0}
            y1={baseline}
            x2={TREND_BOX.width}
            y2={baseline}
            className="trend-baseline"
            vectorEffect="non-scaling-stroke"
          />

          {hasData && (
            <path d={trendAreaPath(points)} fill="url(#trend-fill)" stroke="none" />
          )}
          <path
            d={trendLinePath(points)}
            className="trend-line"
            fill="none"
            stroke="url(#trend-stroke)"
            vectorEffect="non-scaling-stroke"
          />

          {/* 数据点：小圆点常驻，选中的那个加一圈底座 */}
          {points.map((p, i) => (
            <circle
              key={p.day}
              cx={trendX(i, total)}
              cy={trendY(p.count, max)}
              r={i === index ? 3.4 : 1.8}
              className={i === index ? 'trend-dot is-active' : 'trend-dot'}
            />
          ))}

          {/* 指示线：1px 虚线，跟着选中的点走 */}
          <line
            x1={selectedX}
            y1={selectedY}
            x2={selectedX}
            y2={baseline}
            className="trend-cursor"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div className="trend-axis" aria-hidden="true">
          <span>{firstDay}</span>
          <span>{midDay}</span>
          <span>{lastDay}</span>
        </div>
      </div>

      <p className="muted wb-tip">
        {hasData
          ? `共 ${totals.count} 个专注周期 · ${totals.minutes} 分钟。拖动或按 ←/→ 看每一天。`
          : '还没有专注记录：完成一个专注周期后，这里会留下点。'}
      </p>
    </div>
  );
}
