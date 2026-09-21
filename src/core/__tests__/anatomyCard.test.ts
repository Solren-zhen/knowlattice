import { describe, expect, it } from 'vitest';
import {
  CARD_ESTIMATE,
  anatomyNoteCandidates,
  placeCard,
  resolveAnatomyNotePath,
  type CardStageRect,
} from '../anatomyCard';
import type { ManifestOrgan } from '../anatomy';

const organ: ManifestOrgan = {
  organ_id: 'FMA-24474',
  ta2_latin: 'Femur',
  name_en: 'Femur',
  system: 'skeletal',
  mesh_file: 'skeletal.glb',
  node: 'Femur_l',
  path: ['Lower limb', 'Bones'],
};

describe('anatomyNoteCandidates', () => {
  it('英文名 → 中文名 → 结构 ID，按优先级排列', () => {
    expect(anatomyNoteCandidates(organ, '股骨')).toEqual(['Femur', '股骨', 'FMA-24474']);
  });

  it('词典未命中（zhName 为 null）时跳过中文名，不产生空候选', () => {
    expect(anatomyNoteCandidates(organ, null)).toEqual(['Femur', 'FMA-24474']);
  });

  it('中文名与英文名相同时去重', () => {
    expect(anatomyNoteCandidates(organ, 'Femur')).toEqual(['Femur', 'FMA-24474']);
  });

  it('空白候选被丢弃', () => {
    expect(anatomyNoteCandidates({ ...organ, name_en: '  ', organ_id: '' }, '  ')).toEqual([]);
  });
});

describe('resolveAnatomyNotePath', () => {
  it('英文名命中（笔记 alias 走的就是这条路）', () => {
    const resolve = (n: string) => (n === 'Femur' ? '08-解剖学/骨骼/股骨.md' : null);
    expect(resolveAnatomyNotePath(resolve, organ, '股骨')).toBe('08-解剖学/骨骼/股骨.md');
  });

  it('英文名没命中时回退中文名', () => {
    const seen: string[] = [];
    const resolve = (n: string) => {
      seen.push(n);
      return n === '股骨' ? '08-解剖学/骨骼/股骨.md' : null;
    };
    expect(resolveAnatomyNotePath(resolve, organ, '股骨')).toBe('08-解剖学/骨骼/股骨.md');
    expect(seen).toEqual(['Femur', '股骨']);
  });

  it('一个都接不上返回 null', () => {
    expect(resolveAnatomyNotePath(() => null, organ, '股骨')).toBeNull();
  });
});

describe('placeCard', () => {
  const stage: CardStageRect = { left: 100, top: 50, width: 800, height: 600 };

  it('没有点击点（列表选中）时停靠在左上角，让开顶部 chip 行', () => {
    const p = placeCard(null, stage, CARD_ESTIMATE);
    expect(p.left).toBe(12);
    expect(p.top).toBeGreaterThanOrEqual(48);
  });

  it('点击点在中间：落在光标右下方，坐标为舞台相对值', () => {
    const p = placeCard({ x: 300, y: 250 }, stage, CARD_ESTIMATE);
    expect(p).toEqual({ left: 300 - 100 + 16, top: 250 - 50 + 16 });
  });

  it('点靠近右边缘：翻到光标左侧且不越界', () => {
    const p = placeCard({ x: 100 + 790, y: 250 }, stage, CARD_ESTIMATE);
    expect(p.left).toBeLessThan(790 - 100);
    expect(p.left + CARD_ESTIMATE.width).toBeLessThanOrEqual(stage.width - 12);
    expect(p.left).toBeGreaterThanOrEqual(12);
  });

  it('点靠近下边缘：翻到光标上方且不越界', () => {
    const p = placeCard({ x: 300, y: 50 + 590 }, stage, CARD_ESTIMATE);
    expect(p.top + CARD_ESTIMATE.height).toBeLessThanOrEqual(stage.height - 12);
    expect(p.top).toBeGreaterThanOrEqual(12);
  });

  it('点落在舞台外（如左上角外侧）时夹到边距内', () => {
    const p = placeCard({ x: 0, y: 0 }, stage, CARD_ESTIMATE);
    expect(p).toEqual({ left: 12, top: 12 });
  });

  it('卡片比舞台还大时不产生负坐标', () => {
    const tiny: CardStageRect = { left: 0, top: 0, width: 200, height: 120 };
    const p = placeCard({ x: 100, y: 60 }, tiny, CARD_ESTIMATE);
    expect(p).toEqual({ left: 12, top: 12 });
  });
});
