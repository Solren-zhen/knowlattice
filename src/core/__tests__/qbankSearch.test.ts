// @vitest-environment node
/**
 * 题库搜题：词与词是与关系 + 等价词扩展 + ASCII 词边界。
 * 全是纯函数，不碰存储。
 */
import { describe, expect, it } from 'vitest';
import type { QuizBank, QuizQuestion } from '../qbank';
import { containsTerm, searchBank, searchBanks, termAlternatives } from '../qbankSearch';

function q(id: string, over: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id,
    type: 'choice',
    stem: `题干 ${id}`,
    options: ['A', 'B'],
    answer: 0,
    answerText: 'A',
    ...over,
  };
}

const BANK = '甲题库';
const bank: QuizBank = {
  name: BANK,
  importedAt: 0,
  questions: [
    q('a', { stem: '氧解离曲线右移的意义是？', options: ['容易放氧', '容易结合氧'], chapter: '生理学' }),
    q('b', { stem: '心肌梗死的典型表现', chapter: '内科学' }),
    q('c', { stem: 'AMI 的诊断标准', chapter: '心血管' }),
    q('d', { stem: 'family medicine 概述', chapter: '全科' }),
    q('e', { stem: '某题', options: ['与氧解离相关的选项甲'] }),
  ],
};

describe('qbankSearch · 单题匹配', () => {
  it('空查询返回空；分词按空白', () => {
    expect(searchBank(bank, '   ')).toEqual([]);
    expect(termAlternatives('氧解离 右移')).toHaveLength(2);
  });

  it('题干子串命中：primary=stem、带高亮区间', () => {
    const hits = searchBank(bank, '氧解离曲线');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const first = hits[0];
    expect(first.question.id).toBe('a');
    expect(first.primary).toBe('stem');
    expect(first.fields).toContain('stem');
    expect(first.hits.length).toBeGreaterThan(0);
    // 高亮切出来的命中段拼回去等于「氧解离曲线」
    const marked = first.text.slice(first.hits[0].start, first.hits[0].end);
    expect(marked).toBe('氧解离曲线');
  });

  it('多词是与关系：都要命中才返回', () => {
    expect(searchBank(bank, '氧解离 右移').map((h) => h.question.id)).toContain('a');
    expect(searchBank(bank, '氧解离 不存在的词')).toEqual([]);
  });

  it('选项命中时 primary=option、fields 含 option', () => {
    const hits = searchBank(bank, '选项甲');
    expect(hits).toHaveLength(1);
    expect(hits[0].question.id).toBe('e');
    expect(hits[0].primary).toBe('option');
    expect(hits[0].fields).toEqual(['option']);
  });

  it('章节也能搜', () => {
    expect(searchBank(bank, '心血管').map((h) => h.question.id)).toEqual(['c']);
  });
});

describe('qbankSearch · 等价词与词边界', () => {
  it('缩写搜到学名（心梗 → 心肌梗死）', () => {
    const hits = searchBank(bank, '心梗');
    expect(hits.map((h) => h.question.id)).toContain('b');
    // 命中的是学名原文，高亮要落在「心肌梗死」上
    const b = hits.find((h) => h.question.id === 'b')!;
    expect(b.hits.length).toBeGreaterThan(0);
    expect(b.text.slice(b.hits[0].start, b.hits[0].end)).toBe('心肌梗死');
  });

  it('关掉扩展后缩写搜不到学名（证明扩展真的在起作用）', () => {
    expect(searchBank(bank, '心梗', { expand: false })).toEqual([]);
  });

  it('ASCII 词按词边界：AMI 命中 AMI，不命中 family', () => {
    const ids = searchBank(bank, 'AMI').map((h) => h.question.id);
    expect(ids).toContain('c');
    expect(ids).not.toContain('d');
    expect(containsTerm('family medicine', 'ami')).toBe(false);
    expect(containsTerm('ami 诊断', 'ami')).toBe(true);
  });

  it('等价词是「包含式」召回：查询里含词表词（family 含 ami）会带出对应等价词', () => {
    // 这是 expandQuery 的既定设计（包含即追加，只提高召回，见 core/medSynonyms）；
    // 关掉扩展即可退回纯字面匹配。
    expect(searchBank(bank, 'family').map((h) => h.question.id)).toContain('b'); // 心肌梗死被等价词带出
    expect(searchBank(bank, 'family', { expand: false }).map((h) => h.question.id)).toEqual(['d']);
  });
});

describe('qbankSearch · 跨库与上限', () => {
  const bank2: QuizBank = { name: '乙题库', importedAt: 0, questions: [q('x', { stem: '心肌梗死的护理' })] };

  it('searchBanks 汇总多个库', () => {
    const hits = searchBanks([bank, bank2], '心肌梗死');
    expect(new Set(hits.map((h) => h.bank))).toEqual(new Set([BANK, '乙题库']));
  });

  it('perBank / limit 生效', () => {
    const many: QuizBank = {
      name: '多题库',
      importedAt: 0,
      questions: Array.from({ length: 50 }, (_, i) => q(`m${i}`, { stem: '氧解离曲线' })),
    };
    expect(searchBank(many, '氧解离曲线', { perBank: 5 })).toHaveLength(5);
    expect(searchBanks([many], '氧解离曲线', { perBank: 50, limit: 8 })).toHaveLength(8);
  });
});
