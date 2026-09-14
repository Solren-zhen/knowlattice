import { describe, expect, it } from 'vitest';
import { FRAME_MS_DEGRADE, FRAME_MS_RESTORE, MIN_SAMPLES, nextDegraded } from '../adaptiveQuality';

const fill = (ms: number, n = MIN_SAMPLES) => Array.from({ length: n }, () => ms);

describe('nextDegraded', () => {
  it('采样帧数不足时不做任何改变（避免刚按下就误降）', () => {
    expect(nextDegraded(fill(80, MIN_SAMPLES - 1), false)).toBe(false);
    expect(nextDegraded([], true)).toBe(true);
  });

  it('平均帧时间超过阈值 → 降分辨率', () => {
    expect(nextDegraded(fill(FRAME_MS_DEGRADE + 5), false)).toBe(true);
  });

  it('流畅时不会降分辨率（好机器上不出现发虚）', () => {
    expect(nextDegraded(fill(16.7), false)).toBe(false);
    expect(nextDegraded(fill(FRAME_MS_DEGRADE - 1), false)).toBe(false);
  });

  it('降分辨率后只要仍旧卡就保持降级', () => {
    expect(nextDegraded(fill(40), true)).toBe(true);
  });

  it('降分辨率后明显恢复流畅 → 升回全分辨率', () => {
    expect(nextDegraded(fill(FRAME_MS_RESTORE - 1), true)).toBe(false);
  });

  it('滞回区间内保持不变，不会来回抖动', () => {
    const mid = (FRAME_MS_RESTORE + FRAME_MS_DEGRADE) / 2;
    expect(nextDegraded(fill(mid), false)).toBe(false);
    expect(nextDegraded(fill(mid), true)).toBe(true);
  });

  it('个别超长帧不会造成误判（用中位数而非平均）', () => {
    const samples = [...fill(16, MIN_SAMPLES - 1), 300];
    expect(nextDegraded(samples, false)).toBe(false);
  });
});
