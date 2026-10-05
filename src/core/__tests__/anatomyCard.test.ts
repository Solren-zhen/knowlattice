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

  it('成对结构：分侧精确名在前（接旧分侧笔记），共享名随后，结构 ID 收尾', () => {
    const left: ManifestOrgan = { ...organ, name_en: 'Abductor hallucis (left)', organ_id: 'ah_l' };
    expect(anatomyNoteCandidates(left, '踇展肌（左）')).toEqual([
      'Abductor hallucis (left)',
      '踇展肌（左）',
      'Abductor hallucis', // 共享英文
      '踇展肌',            // 共享中文
      'ah_l',
    ]);
  });

  it('成对结构且词典缺失：共享中文名不产生空候选', () => {
    const left: ManifestOrgan = { ...organ, name_en: 'Abductor hallucis (left)', organ_id: 'ah_l' };
    expect(anatomyNoteCandidates(left, null)).toEqual([
      'Abductor hallucis (left)',
      'Abductor hallucis',
      'ah_l',
    ]);
  });

  it('单侧结构（前缀式命名，无对侧）不产生共享候选', () => {
    const oneSide: ManifestOrgan = { ...organ, name_en: 'Right testicular artery', organ_id: 'rta' };
    expect(anatomyNoteCandidates(oneSide, '睾丸动脉')).toEqual(['Right testicular artery', '睾丸动脉', 'rta']);
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

  it('成对结构：本侧分侧笔记存在时优先打开它（尊重旧数据）', () => {
    const left: ManifestOrgan = { ...organ, name_en: 'Abductor hallucis (left)', organ_id: 'ah_l' };
    const resolve = (n: string) =>
      n === 'Abductor hallucis (left)' ? '08-解剖学/肌肉/踇展肌（左）.md'
      : n === 'Abductor hallucis' ? '08-解剖学/肌肉/踇展肌.md'
      : null;
    expect(resolveAnatomyNotePath(resolve, left, '踇展肌（左）')).toBe('08-解剖学/肌肉/踇展肌（左）.md');
  });

  it('成对结构：无分侧笔记时落到共享篇（另一侧建的「踇展肌」）', () => {
    const right: ManifestOrgan = { ...organ, name_en: 'Abductor hallucis (right)', organ_id: 'ah_r' };
    const resolve = (n: string) => (n === '踇展肌' ? '08-解剖学/肌肉/踇展肌.md' : null);
    expect(resolveAnatomyNotePath(resolve, right, '踇展肌（右）')).toBe('08-解剖学/肌肉/踇展肌.md');
  });

  it('成对结构：另一侧的分侧笔记不会被打开（候选不含对侧精确名）', () => {
    const left: ManifestOrgan = { ...organ, name_en: 'Abductor hallucis (left)', organ_id: 'ah_l' };
    const resolve = (n: string) => (n === 'Abductor hallucis (right)' ? '08-解剖学/肌肉/踇展肌（右）.md' : null);
    expect(resolveAnatomyNotePath(resolve, left, null)).toBeNull();
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
