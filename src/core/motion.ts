/**
 * 动效运行时（纯函数层）：弹簧、惯性投影、指针速度、吸附锚点、橡皮筋、倾斜角。
 *
 * 为什么自己写而不是引动画库：仓库里 core/adaptiveQuality.ts、core/pointerTap.ts
 * 都是「纯函数 + 单测」的形态，动效参数同样需要能被断言（阻尼比、吸附阈值、
 * 越界衰减、峰值过冲量）。放在纯函数里，回归是 npx vitest 一条命令的事；
 * 放进库的运行时，就只能靠肉眼看。
 *
 * 参数口径统一用「response（到位时间，秒）+ dampingRatio（阻尼比，1 = 临界阻尼，
 * <1 才有回弹）」。它比 stiffness/damping 直观：设计稿上直接写得出这两个数。
 * 换算式：ω0 = 2π / response，k = ω0²，c = 2ζω0。
 *
 * 本文件不碰 DOM（不 import window/matchMedia），所以可以脱离 jsdom 直接单测。
 */

export interface SpringConfig {
  /** 到位时间（秒）：越小越快 */
  response: number;
  /** 阻尼比：1 = 临界阻尼不过冲，0.7~0.85 = 轻微回弹 */
  dampingRatio: number;
}

export interface SpringState {
  /** 当前位置（px、比例、角度都行，与 target 同单位） */
  x: number;
  /** 当前速度（单位/秒） */
  v: number;
}

/**
 * 全套预设。改手感只改这里，别在各个组件里散落魔法数字。
 * 峰值过冲（ζ）参考值：ζ=0.75 ≈ 4%，ζ=0.85 ≈ 2.5%，ζ=0.9 ≈ 1.5%，ζ=1 = 0。
 */
export const SPRING = {
  /** 按压成型：只要「按下去」，绝对不许抖 */
  press: { response: 0.12, dampingRatio: 1 },
  /** 松手回正 / 吸附落位：一点点回弹，手感有「扣住」 */
  settle: { response: 0.35, dampingRatio: 0.75 },
  /** 面板展开 / 形态变换：几乎不过冲，避免边缘抖出锯齿 */
  expand: { response: 0.32, dampingRatio: 0.9 },
  /** 抽屉这类大面积、大惯性的吸附：略软 */
  sheet: { response: 0.4, dampingRatio: 0.85 },
} as const satisfies Record<string, SpringConfig>;

/** 阻尼比小于这个值时按欠阻尼公式算（避免 sqrt(1-ζ²)→0 的数值毛刺） */
const UNDERDAMPED_EPS = 1e-6;

/**
 * 弹簧推进一步（dt 单位秒）。用**解析解**而不是数值积分：
 * - 半隐式欧拉在 response 0.12 这种硬参数下会发散（ζω0·dt 太大，迹条件破不满足），
 *   实测 60 帧后能跑到 11 万像素外；
 * - 解析解与帧率无关：掉帧到 30fps 或意外长帧都得到同一条轨迹，动效可复现，
 *   也让「同一时刻的位置」有唯一答案（渲染、测试、视觉回归才对得上）。
 * 三支：欠阻尼 / 临界 / 过阻尼，按阻尼比分支。
 */
export function springStep(
  state: SpringState,
  target: number,
  cfg: SpringConfig,
  dt: number,
): SpringState {
  const step = Math.max(dt, 0);
  if (step === 0) return state;
  const w0 = (2 * Math.PI) / Math.max(cfg.response, 1e-3);
  const zeta = Math.max(cfg.dampingRatio, 0);
  const x0 = state.x - target;
  const v0 = state.v;

  if (zeta < 1 - UNDERDAMPED_EPS) {
    // 欠阻尼：e^{-ζω₀t}(A cos ω_d t + B sin ω_d t)
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * step);
    const cos = Math.cos(wd * step);
    const sin = Math.sin(wd * step);
    const A = x0;
    const B = (v0 + zeta * w0 * x0) / wd;
    return {
      x: decay * (A * cos + B * sin) + target,
      v: decay * ((-zeta * w0 * A + B * wd) * cos + (-zeta * w0 * B - A * wd) * sin),
    };
  }

  if (zeta <= 1 + UNDERDAMPED_EPS) {
    // 临界阻尼：(x₀ + (v₀ + ω₀x₀)t) e^{-ω₀t}
    const decay = Math.exp(-w0 * step);
    const C2 = v0 + w0 * x0;
    return {
      x: (x0 + C2 * step) * decay + target,
      v: decay * (C2 - w0 * x0 - w0 * C2 * step),
    };
  }

  // 过阻尼：两个实根的各一路衰减
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - s);
  const r2 = -w0 * (zeta + s);
  const e1 = Math.exp(r1 * step);
  const e2 = Math.exp(r2 * step);
  const C1 = (v0 - r2 * x0) / (r1 - r2);
  const C2 = x0 - C1;
  return {
    x: C1 * e1 + C2 * e2 + target,
    v: C1 * r1 * e1 + C2 * r2 * e2,
  };
}

/**
 * 是否已经静止：位置与速度都进了误差带。
 * 默认误差带按「比例/角度」（0~1 量级）取值；px 量级的调用自己传大一点的 eps。
 */
export function isResting(
  state: SpringState,
  target: number,
  epsX = 0.001,
  epsV = 0.01,
): boolean {
  return Math.abs(state.x - target) <= epsX && Math.abs(state.v) <= epsV;
}

/**
 * 惯性投影：以当前速度自由滑行最终会停在哪（UIKit 的 decelerationRate 模型）。
 * v 单位 px/ms，0.998 = 正常滚动阻尼（0.99 = 快）。
 * 用途：松手时判断「按这个速度甩出去会落到哪个锚点」。
 */
export function decayProjection(x: number, v: number, decelerationRate = 0.998): number {
  const d = Math.min(Math.max(decelerationRate, 0.9), 0.9999);
  return x + (v * d) / (1 - d);
}

export interface PointerSample {
  /** 位移（px，水平或垂直取一个轴） */
  x: number;
  /** 时间戳（ms，performance.now()） */
  t: number;
}

/**
 * 追加一个采样点，并把窗口外的丢掉。返回新数组（保持纯函数）。
 * 只留最近 windowMs 毫秒，且最多 maxSamples 个。
 */
export function pushSample(
  samples: readonly PointerSample[],
  sample: PointerSample,
  windowMs = 100,
  maxSamples = 20,
): PointerSample[] {
  const next = [...samples, sample].filter((s) => sample.t - s.t <= windowMs);
  return next.slice(-maxSamples);
}

/**
 * 指针速度（px/ms）：窗口内首末样本的位移/时间差。
 * 样本不足 2 个、或时间跨度为 0 → 0（不要用「最后一个点减倒数第二个点」，
 * 手指停住的那几十毫秒会算出巨大速度，于是松手时莫名跳一屏）。
 */
export function velocityFromSamples(samples: readonly PointerSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
}

/**
 * 橡皮筋：越界位移的衰减。overshoot 是手指/指针越出的距离，dimension 是容器尺寸。
 * 越拖越沉、且有上界（永远到不了 dimension），松手回弹才有「拉扯」感。
 * tension 越大越松（越接近 1:1 跟手）。
 */
export function rubberBand(overshoot: number, dimension: number, tension = 0.55): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  const t = Math.max(tension, 1e-3);
  return (1 - 1 / ((overshoot * t) / dimension + 1)) * dimension;
}

export interface SnapOptions {
  /** 甩动阈值（px/ms）：超过它按惯性投影找锚点，低于它按「离谁近去哪」 */
  flick?: number;
  /** 惯性投影的减速率，透传给 decayProjection */
  decelerationRate?: number;
}

/**
 * 松手后落到哪个锚点。anchors 必须升序。
 *
 * - 慢放（|v| < flick）：离当前位移最近的锚点 —— 这就是「越过相邻锚点中点才换」，
 *   中点规则与「取最近」在数学上是同一件事，不用额外传比例。
 * - 快甩（|v| >= flick）：按惯性投影落点取最近锚点；投影越界则停在端点。
 */
export function pickSnapAnchor(
  pos: number,
  velocity: number,
  anchors: readonly number[],
  opts: SnapOptions = {},
): number {
  if (anchors.length === 0) return -1;
  if (anchors.length === 1) return 0;
  const flick = opts.flick ?? 0.35;
  const projected =
    Math.abs(velocity) >= flick ? decayProjection(pos, velocity, opts.decelerationRate) : pos;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const dist = Math.abs(anchors[i] - projected);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * 指针在卡片内的归一化坐标（0~1，超出会被钳到边界）→ 3D 倾斜角（度）。
 *
 * 符号约定：指针停留在哪一侧，那一侧「后仰」——像用手指把卡片那一角按下去。
 * 左上角 (0,0) → rotateX 为正、rotateY 为负；中心 (0.5,0.5) → 两角都为 0。
 */
export function tiltAngles(
  nx: number,
  ny: number,
  maxTiltDeg: number,
): { rotateX: number; rotateY: number; mx: number; my: number } {
  const cx = Math.min(Math.max(nx, 0), 1);
  const cy = Math.min(Math.max(ny, 0), 1);
  return {
    rotateX: -(cy - 0.5) * 2 * maxTiltDeg,
    rotateY: (cx - 0.5) * 2 * maxTiltDeg,
    mx: cx,
    my: cy,
  };
}

/**
 * 闭式阻尼振荡的「回弹尾巴」：t>0 时返回衰减到 0 的有符号偏移系数，乘上峰值幅度即得位移。
 * 用于一次性冲击后的余振（例如按下的回弹尾、命中反馈的微颤），不需要逐帧积分状态。
 * freq 单位 1/秒（约 6~10 手感自然），damping 越大衰减越快（约 6~12）。
 *
 * 来源：video-shotcraft 的 assets/lib/helpers/motion.ts（Apache-2.0，`dampedSettle`），
 * 那边按帧计数，这里把 t 的口径明确成秒。
 */
export function dampedSettle(t: number, freq = 7, damping = 9): number {
  return t <= 0 ? 0 : Math.exp(-damping * t) * Math.sin(2 * Math.PI * freq * t);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
