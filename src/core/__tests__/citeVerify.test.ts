import { describe, expect, it } from 'vitest';
import {
  foldLigatures, lookupQuote, normalizeForCite, parseCitations, verifyCitations, verifyQuote,
} from '../citeVerify';

describe('parseCitations', () => {
  it('拆出书名、页码与紧邻引文', () => {
    const out = parseCitations('甲状腺激素“由滤泡上皮细胞分泌”〔《生理学》 P182〕。');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ book: '生理学', page: 182, quote: '由滤泡上皮细胞分泌' });
  });

  it('无书名、无引文时字段为空', () => {
    const out = parseCitations('见〔P42〕。');
    expect(out[0]).toMatchObject({ book: null, page: 42, quote: '' });
  });

  it('「第N版」不算页码，「第N页」算', () => {
    const out = parseCitations('“原文”〔《内科学》 第10版 第182页〕');
    expect(out[0]).toMatchObject({ book: '内科学', page: 182 });
    const v = parseCitations('“原文”〔《内科学》 第10版〕');
    expect(v[0]).toMatchObject({ book: '内科学', page: null });
  });
});

describe('verifyQuote 四档', () => {
  const source = '甲状腺激素由滤泡上皮细胞分泌，调节全身代谢。';

  it('exact：归一化后整段是原文子串', () => {
    expect(verifyQuote('由滤泡上皮细胞分泌', source)).toBe('exact');
  });

  it('partial：头尾都命中、中段有落差', () => {
    const s = '心肌梗死的心电图表现为ST段抬高，肌钙蛋白升高。';
    expect(verifyQuote('心肌梗死的心电图表现为病理性Q波，肌钙蛋白升高', s)).toBe('partial');
  });

  it('fabricated：只有前缀命中（拿真实开头编了后面）', () => {
    expect(verifyQuote('甲状腺激素由滤泡上皮细胞大量合成', source)).toBe('fabricated');
  });

  it('not_found：头尾都对不上', () => {
    expect(verifyQuote('与原文毫无关系的整句话', source)).toBe('not_found');
  });

  it('空引文判 not_found', () => {
    expect(verifyQuote('   ', source)).toBe('not_found');
  });
});

describe('核验归一化', () => {
  it('合字折叠：ﬃ → ffi', () => {
    expect(foldLigatures('eﬃcacy')).toBe('efficacy');
    expect(verifyQuote('eﬃcacy', 'The efficacy is high.')).toBe('exact');
  });

  it('数字严格通道：1.5 不放过 15', () => {
    expect(verifyQuote('血压 1.5 kPa', '血压 15 kPa')).toBe('fabricated');
  });

  it('归一化去除空白差异', () => {
    expect(normalizeForCite('甲 状 腺')).toBe('甲状腺');
  });
});

describe('verifyCitations / lookupQuote', () => {
  const docs = new Map([
    ['生理学/内分泌.md', '# 内分泌\n甲状腺激素由滤泡上皮细胞分泌，调节全身代谢。'],
    ['药理/洋地黄.md', '# 洋地黄\n强心苷类，正性肌力。'],
  ]);

  it('按书名限定来源并给出四档结论', () => {
    const out = verifyCitations('甲状腺激素“由滤泡上皮细胞分泌”〔《内分泌》 P12〕。', docs);
    expect(out[0].status).toBe('exact');
    expect(out[0].sourcePath).toBe('生理学/内分泌.md');
  });

  it('编造的引文判 fabricated', () => {
    const out = verifyCitations('“甲状腺激素由滤泡上皮细胞大量合成”〔《内分泌》 P12〕。', docs);
    expect(out[0].status).toBe('fabricated');
  });

  it('lookupQuote 可限定单篇或全库', () => {
    expect(lookupQuote('正性肌力', docs).sourcePath).toBe('药理/洋地黄.md');
    expect(lookupQuote('正性肌力', docs, '生理学/内分泌.md').status).toBe('not_found');
  });
});
