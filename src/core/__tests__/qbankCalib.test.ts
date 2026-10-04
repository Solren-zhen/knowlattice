// @vitest-environment jsdom
/** 元认知校准的计数与汇总：桶累积、非法输入、损坏存储、过度自信指数、备份往返。 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIDENCE_VALUES, calibrationSummary, exportCalibration, importCalibration, loadCalibration, recordCalibration,
} from '../qbankCalib';

const KEY = 'knowlattice-qcalib';

beforeEach(() => localStorage.clear());

describe('qbankCalib', () => {
  it('按档位累积计数，始终返回 5 个桶', () => {
    recordCalibration(5, true);
    recordCalibration(5, true);
    recordCalibration(5, false);
    recordCalibration(2, false);
    const buckets = loadCalibration();
    expect(buckets.map((b) => b.confidence)).toEqual(CONFIDENCE_VALUES);
    expect(buckets.find((b) => b.confidence === 5)).toEqual({ confidence: 5, n: 3, correct: 2 });
    expect(buckets.find((b) => b.confidence === 2)).toEqual({ confidence: 2, n: 1, correct: 0 });
    expect(buckets.find((b) => b.confidence === 3)).toEqual({ confidence: 3, n: 0, correct: 0 });
  });

  it('非法档位与损坏的存储都不会污染结果', () => {
    recordCalibration(0 as never, true);
    recordCalibration(6 as never, true);
    recordCalibration(2.5 as never, true);
    recordCalibration(Number.NaN as never, true);
    expect(loadCalibration().every((b) => b.n === 0)).toBe(true);

    localStorage.setItem(KEY, '{ not json');
    expect(calibrationSummary().n).toBe(0);
    localStorage.setItem(KEY, '"str"');
    expect(calibrationSummary().n).toBe(0);
    localStorage.setItem(KEY, JSON.stringify({ 3: { n: -5, correct: 99 } }));
    expect(loadCalibration().find((b) => b.confidence === 3)).toEqual({ confidence: 3, n: 0, correct: 0 });
    localStorage.setItem(KEY, JSON.stringify({ 4: { n: 2, correct: 9 } }));
    expect(loadCalibration().find((b) => b.confidence === 4)).toEqual({ confidence: 4, n: 2, correct: 2 });
  });

  it('过度自信指数 = 平均自信 − 实际正确率', () => {
    // 全报 5 档且全错：平均自信 1.0，正确率 0 → +1.0（极端高估）
    recordCalibration(5, false);
    recordCalibration(5, false);
    expect(calibrationSummary().overconfidence).toBeCloseTo(1, 5);
    // 全报 1 档且全对：0.2 − 1 → −0.8（低估）
    localStorage.clear();
    recordCalibration(1, true);
    expect(calibrationSummary().overconfidence).toBeCloseTo(-0.8, 5);
    // 报 3 档、一半对：0.6 − 0.5 → +0.1
    localStorage.clear();
    recordCalibration(3, true);
    recordCalibration(3, false);
    const s = calibrationSummary();
    expect(s.n).toBe(2);
    expect(s.correct).toBe(1);
    expect(s.overconfidence).toBeCloseTo(0.1, 5);
  });

  it('无样本时汇总全为 0，不出现 NaN', () => {
    const s = calibrationSummary();
    expect(s).toEqual({ n: 0, correct: 0, overconfidence: 0, buckets: loadCalibration() });
  });

  it('导出只带有数据的档位；导入整体覆盖并忽略非法输入', () => {
    recordCalibration(4, true);
    recordCalibration(4, false);
    expect(exportCalibration()).toEqual({ 4: { n: 2, correct: 1 } });

    importCalibration({ 1: { n: 3, correct: 1 }, 9: { n: 100, correct: 100 } });
    const after = loadCalibration();
    expect(after.find((b) => b.confidence === 4)?.n).toBe(0); // 覆盖，不是累加
    expect(after.find((b) => b.confidence === 1)).toEqual({ confidence: 1, n: 3, correct: 1 });

    importCalibration(null);
    importCalibration('nope');
    importCalibration([1, 2, 3]);
    expect(loadCalibration().find((b) => b.confidence === 1)?.n).toBe(3);
  });
});
