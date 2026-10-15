// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ChapterMastery } from '../qbankStats';
import { radarAxes, systemMastery, systemOf, weakestChapters, mergeMastery } from '../qbankWeakness';

function m(chapter: string, seen: number, wrong: number): ChapterMastery {
  const accuracy = seen > 0 ? (seen - wrong) / seen : 0;
  return { chapter, seen, wrong, accuracy, weak: seen >= 3 && accuracy < 0.6 };
}

describe('qbankWeakness · 学科汇总', () => {
  it('systemOf：按 · 取学科，无分隔符时整段当学科', () => {
    expect(systemOf('生理学·第6章 消化')).toBe('生理学');
    expect(systemOf('生化')).toBe('生化');
  });

  it('systemMastery：按学科合并 seen/wrong，最差在前', () => {
    const out = systemMastery([
      m('生理学·第6章', 3, 2),
      m('生理学·第10章', 5, 2),
      m('生物化学·第1章', 4, 0),
    ]);
    expect(out.map((s) => s.system)).toEqual(['生理学', '生物化学']);
    expect(out[0]).toMatchObject({ seen: 8, wrong: 4 });
    expect(out[0].accuracy).toBeCloseTo(0.5);
    expect(out[1].accuracy).toBeCloseTo(1);
  });

  it('未标章节归入「未标注」', () => {
    expect(systemMastery([m('', 3, 1)])[0].system).toBe('未标注');
  });
});

describe('qbankWeakness · 雷达与最弱章', () => {
  it('radarAxes：取样本最多的若干章，标签去掉学科前缀', () => {
    const out = radarAxes([
      m('生理学·第6章 消化', 3, 1),
      m('生理学·第10章 神经', 9, 1),
      m('生化·第1章', 5, 0),
    ], 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ label: '第10章 神经', seen: 9 });
  });

  it('weakestChapters：样本不足者不入选', () => {
    const out = weakestChapters([
      m('a', 1, 1), // 样本不足
      m('b', 5, 5),
      m('c', 5, 1),
    ]);
    expect(out.map((x) => x.chapter)).toEqual(['b', 'c']);
  });
});

describe('qbankWeakness · 跨库合并', () => {
  it('mergeMastery：同名章节相加，重算正确率与 weak', () => {
    const out = mergeMastery([
      m('生理学·第6章', 3, 1),
      m('生理学·第6章', 2, 2),
      m('生化·第1章', 4, 0),
    ]);
    const physio = out.find((x) => x.chapter === '生理学·第6章')!;
    expect(physio).toMatchObject({ seen: 5, wrong: 3 });
    expect(physio.accuracy).toBeCloseTo(0.4);
    expect(physio.weak).toBe(true);
    expect(out.find((x) => x.chapter === '生化·第1章')!.weak).toBe(false);
  });
});
