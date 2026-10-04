import { describe, expect, it, vi } from 'vitest';
import * as pageAnchorModule from '../pageAnchor';
import {
  foldLigatures, lookupQuote, normalizeForCite, parseCitations, verifyCitations, verifyQuote,
} from '../citeVerify';

/** 统计剥离页码锚点的调用次数：证明核验缓存确实把「每条引用 × 每篇笔记」的重复剥离消掉 */
const stripCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock('../pageAnchor', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof pageAnchorModule;
  return {
    ...actual,
    stripPageAnchors: (src: string) => {
      stripCalls.n += 1;
      return actual.stripPageAnchors(src);
    },
  };
});

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

describe('核验缓存', () => {
  const multiDocs = new Map([
    ['生理/甲.md', '<!--kb:P1-->\n甲状腺激素由滤泡上皮细胞分泌，调节全身代谢。'],
    ['药理/乙.md', '<!--kb:P2-->\n强心苷类，正性肌力。'],
    ['病理/丙.md', '<!--kb:P3-->\n炎症的基本病理变化包括变质、渗出、增生。'],
  ]);
  const multiAnswer = '“由滤泡上皮细胞分泌”〔P12〕；“正性肌力”〔P8〕；“变质、渗出、增生”〔P3〕';

  it('同一 docs 反复核验只扫一遍：剥离次数不随渲染次数增长', () => {
    stripCalls.n = 0;
    const first = verifyCitations(multiAnswer, multiDocs);
    // 3 条引用 × 3 篇笔记：不缓存剥离结果要剥 9 次，缓存后每篇只剥 1 次
    expect(stripCalls.n).toBe(3);
    expect(first.map((r) => r.status)).toEqual(['exact', 'exact', 'exact']);

    verifyCitations(multiAnswer, multiDocs);
    verifyCitations(multiAnswer, multiDocs);
    // 结果缓存命中：重渲不再触碰全库
    expect(stripCalls.n).toBe(3);
  });

  it('结果缓存命中后与首次核验逐字一致', () => {
    const first = verifyCitations(multiAnswer, multiDocs);
    const second = verifyCitations(multiAnswer, multiDocs);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // 换一个等价的新 Map 实例（绕过结果缓存，仅剥离缓存命中）结论必须一致
    expect(verifyCitations(multiAnswer, new Map(multiDocs))).toEqual(first);
  });

  it('多处逐字命中标 ambiguous，唯一命中不标', () => {
    const docs = new Map([
      ['甲.md', '共同结论是心输出量增加。'],
      ['乙.md', '共同结论是心输出量增加。'],
      ['丙.md', '独有结论是肾小球滤过率下降。'],
    ]);
    const multi = verifyCitations('“共同结论是心输出量增加”〔P1〕', docs)[0];
    expect(multi.status).toBe('exact');
    expect(multi.hits).toBe(2);
    expect(multi.ambiguous).toBe(true);

    const single = verifyCitations('“独有结论是肾小球滤过率下降”〔P1〕', docs)[0];
    expect(single.status).toBe('exact');
    expect(single.hits).toBe(1);
    expect(single.ambiguous).toBe(false);

    const miss = verifyCitations('“库内根本没有的整句话”〔P1〕', docs)[0];
    expect(miss.hits).toBe(0);
    expect(miss.ambiguous).toBe(false);
  });

  it('同一书名的两条引用页码不同时各自回填页码', () => {
    const docs = new Map([['甲.md', '甲状腺激素由滤泡上皮细胞分泌。']]);
    const out = verifyCitations('“由滤泡上皮细胞分泌”〔《甲》 P12〕；“由滤泡上皮细胞分泌”〔《甲》 P34〕', docs);
    expect(out.map((r) => r.page)).toEqual([12, 34]);
    expect(out.map((r) => r.status)).toEqual(['exact', 'exact']);
  });

  it('内容变更后缓存不脏：换新 Map 重新核验得到新结论', () => {
    const before = new Map([['甲.md', '原始结论是心输出量增加。']]);
    expect(verifyCitations('“原始结论是心输出量增加”〔P1〕', before)[0].status).toBe('exact');

    const after = new Map([['甲.md', '改写后的内容与原先完全不同。']]);
    const r = verifyCitations('“原始结论是心输出量增加”〔P1〕', after)[0];
    expect(r.status).toBe('not_found');
    expect(r.hits).toBe(0);
  });
});
