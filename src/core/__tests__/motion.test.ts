import { describe, expect, it } from 'vitest';
import {
  SPRING,
  clamp,
  dampedSettle,
  decayProjection,
  isResting,
  lerp,
  pickSnapAnchor,
  pushSample,
  rubberBand,
  springStep,
  tiltAngles,
  velocityFromSamples,
  type PointerSample,
} from '../motion';

/** 按 60fps 跑一段弹簧，返回每一帧的位置 */
function run(
  from: number,
  target: number,
  cfg: { response: number; dampingRatio: number },
  seconds: number,
  startV = 0,
): number[] {
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  const out: number[] = [];
  let state = { x: from, v: startV };
  for (let i = 0; i < frames; i++) {
    state = springStep(state, target, cfg, dt);
    out.push(state.x);
  }
  return out;
}

describe('springStep', () => {
  it('临界阻尼（ζ=1）不过冲', () => {
    const frames = run(0, 1, { response: 0.3, dampingRatio: 1 }, 1);
    expect(Math.max(...frames)).toBeLessThanOrEqual(1.001);
  });

  it('阻尼比 0.75 有轻微过冲，但峰值受控（≤6%）', () => {
    const frames = run(0, 1, SPRING.settle, 1);
    const peak = Math.max(...frames);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(1.06);
  });

  it('所有预设都能在 1 秒内收敛到位', () => {
    for (const cfg of Object.values(SPRING)) {
      const frames = run(0, 100, cfg, 1);
      expect(Math.abs(frames[frames.length - 1] - 100)).toBeLessThan(0.5);
    }
  });

  it('从反向初速出发也收敛（不会飞走）', () => {
    const frames = run(50, 0, SPRING.settle, 1.5, -900);
    expect(Math.abs(frames[frames.length - 1])).toBeLessThan(0.5);
    expect(Math.max(...frames.map(Math.abs))).toBeLessThan(120);
  });

  it('硬参数（press 的 response 0.12）不发散：数值积分在这种参数下会跑到 11 万像素外', () => {
    const frames = run(0, 100, SPRING.press, 1);
    const last = frames[frames.length - 1];
    expect(Number.isFinite(last)).toBe(true);
    expect(Math.abs(last - 100)).toBeLessThan(0.5);
  });

  it('解析解与帧率无关：60fps / 30fps / 单次大 dt 走到的位置一致', () => {
    let a = { x: 0, v: 0 };
    for (let i = 0; i < 60; i++) a = springStep(a, 1, SPRING.settle, 1 / 60);
    let b = { x: 0, v: 0 };
    for (let i = 0; i < 30; i++) b = springStep(b, 1, SPRING.settle, 1 / 30);
    const c = springStep({ x: 0, v: 0 }, 1, SPRING.settle, 1);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.x - c.x)).toBeLessThan(1e-9);
  });
});

describe('isResting', () => {
  it('位置与速度都进误差带才算静止', () => {
    expect(isResting({ x: 1, v: 0 }, 1)).toBe(true);
    expect(isResting({ x: 0.99, v: 0 }, 1)).toBe(false);
    expect(isResting({ x: 1, v: 0.5 }, 1)).toBe(false);
  });

  it('可按调用方给出的误差带判断（px 量级）', () => {
    expect(isResting({ x: 100.05, v: 0.2 }, 100, 0.1, 0.5)).toBe(true);
  });
});

describe('decayProjection', () => {
  it('速度为 0 时停在原地', () => {
    expect(decayProjection(200, 0)).toBeCloseTo(200, 6);
  });

  it('速度越大滑得越远，方向跟随速度', () => {
    expect(decayProjection(0, 1)).toBeGreaterThan(decayProjection(0, 0.5));
    expect(decayProjection(0, -1)).toBeLessThan(0);
  });

  it('减速率被钳在合理区间（0.9~0.9999）', () => {
    expect(Number.isFinite(decayProjection(0, 1, 1))).toBe(true);
    expect(decayProjection(0, 1, 1)).toBeLessThan(20000);
  });
});

describe('velocityFromSamples', () => {
  const s = (x: number, t: number): PointerSample => ({ x, t });

  it('样本不足时速度为 0', () => {
    expect(velocityFromSamples([])).toBe(0);
    expect(velocityFromSamples([s(10, 0)])).toBe(0);
  });

  it('匀速采样得出精确速度', () => {
    expect(velocityFromSamples([s(0, 0), s(50, 50), s(100, 100)])).toBeCloseTo(1, 6);
  });

  it('时间跨度为 0 时不返回 Infinity', () => {
    expect(velocityFromSamples([s(0, 5), s(80, 5)])).toBe(0);
  });

  it('pushSample 丢掉窗口外的旧样本', () => {
    let samples: PointerSample[] = [];
    for (const t of [0, 20, 40, 60, 200]) samples = pushSample(samples, s(t, t));
    expect(samples.map((v) => v.t)).toEqual([200]);
  });

  it('pushSample 限制样本上限', () => {
    let samples: PointerSample[] = [];
    for (let i = 0; i < 50; i++) samples = pushSample(samples, s(i, i), 10_000, 5);
    expect(samples).toHaveLength(5);
  });
});

describe('rubberBand', () => {
  it('没越界就没有位移', () => {
    expect(rubberBand(0, 600)).toBe(0);
    expect(rubberBand(-20, 600)).toBe(0);
  });

  it('越界越多位移越大，但永远小于容器尺寸（有上界）', () => {
    const a = rubberBand(50, 600);
    const b = rubberBand(200, 600);
    const c = rubberBand(100_000, 600);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(600);
  });

  it('手指越出 100px 只推动约 50px（拉扯感来自衰减比）', () => {
    expect(rubberBand(100, 600)).toBeGreaterThan(40);
    expect(rubberBand(100, 600)).toBeLessThan(60);
  });

  it('张紧度越大越跟手', () => {
    expect(rubberBand(100, 600, 0.9)).toBeGreaterThan(rubberBand(100, 600, 0.3));
  });
});

describe('pickSnapAnchor', () => {
  const anchors = [0, 300, 600];

  it('没有锚点时返回 -1', () => {
    expect(pickSnapAnchor(0, 0, [])).toBe(-1);
    expect(pickSnapAnchor(123, 0, [200])).toBe(0);
  });

  it('慢放时取最近的锚点（等价于「越过中点才换」）', () => {
    expect(pickSnapAnchor(149, 0, anchors)).toBe(0);
    expect(pickSnapAnchor(151, 0, anchors)).toBe(1);
    expect(pickSnapAnchor(310, 0, anchors)).toBe(1);
  });

  it('快甩时按惯性投影落点选锚点', () => {
    // 300 处以 1px/ms 向上甩：投影到约 799 → 落在末锚点
    expect(pickSnapAnchor(300, 1, anchors)).toBe(2);
    expect(pickSnapAnchor(300, -1, anchors)).toBe(0);
  });

  it('甩动方向与位置相反时以投影为准（不是以手指位置为准）', () => {
    // 310 处向下甩：投影到负值 → 回到首锚点
    expect(pickSnapAnchor(310, -0.6, anchors)).toBe(0);
  });

  it('刚好在阈值上下：低于阈值按位置算，达到阈值按投影算', () => {
    const justUnder = pickSnapAnchor(310, 0.34, anchors);
    const atThreshold = pickSnapAnchor(310, 0.35, anchors);
    expect(justUnder).toBe(1);
    expect(atThreshold).toBe(2);
  });

  it('投影越界时停在端点，不会越出锚点表', () => {
    expect(pickSnapAnchor(600, 5, anchors)).toBe(2);
    expect(pickSnapAnchor(0, -5, anchors)).toBe(0);
  });
});

describe('tiltAngles', () => {
  it('指针在正中心时两角都归零', () => {
    const { rotateX, rotateY, mx, my } = tiltAngles(0.5, 0.5, 6);
    expect(rotateX).toBeCloseTo(0, 6);
    expect(rotateY).toBeCloseTo(0, 6);
    expect(mx).toBe(0.5);
    expect(my).toBe(0.5);
  });

  it('指针所在的那一侧后仰（左上角：rotateX 为正、rotateY 为负）', () => {
    const { rotateX, rotateY } = tiltAngles(0, 0, 6);
    expect(rotateX).toBeCloseTo(6, 6);
    expect(rotateY).toBeCloseTo(-6, 6);
  });

  it('最大倾角不超过设定值', () => {
    for (const [nx, ny] of [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ]) {
      const { rotateX, rotateY } = tiltAngles(nx, ny, 6);
      expect(Math.abs(rotateX)).toBeLessThanOrEqual(6);
      expect(Math.abs(rotateY)).toBeLessThanOrEqual(6);
    }
  });

  it('越界坐标被钳到边界（快速划出卡片不会甩出大角度）', () => {
    const out = tiltAngles(-3, 9, 6);
    expect(out.rotateX).toBeCloseTo(-6, 6);
    expect(out.rotateY).toBeCloseTo(-6, 6);
    expect(out.mx).toBe(0);
    expect(out.my).toBe(1);
  });
});

describe('dampedSettle', () => {
  it('t<=0 没有位移', () => {
    expect(dampedSettle(0)).toBe(0);
    expect(dampedSettle(-0.1)).toBe(0);
  });

  it('包络随时间衰减（尾巴会停）', () => {
    expect(Math.abs(dampedSettle(0.05))).toBeGreaterThan(Math.abs(dampedSettle(0.5)));
    expect(Math.abs(dampedSettle(1.5))).toBeLessThan(0.001);
  });
});

describe('clamp / lerp', () => {
  it('clamp 双向钳制', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });

  it('lerp 端点与中点', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});
