/**
 * 命令面板的匹配规则 + 生词本的存取/批拆。
 *
 * 为什么值得测：这两处都是「用户看不见代码、但一错就怪功能」的地方——
 * 面板搜不到自己刚加的命令等于没加；批量收词把一行拆错（把释义当词条）会污染生词本，
 * 而它写进 localStorage 后没人会去清理。
 */
import { describe, expect, it } from 'vitest';
import { matchCommands } from '../commands';
import {
  addVocab,
  collectFromText,
  exportVocabState,
  importVocabState,
  loadVocab,
  rateVocab,
  removeVocab,
  vocabDueQueue,
  vocabStats,
} from '../vocab';

interface Cmd { id: string; title: string; group?: string; aliases?: string[] }

const LIST: Cmd[] = [
  { id: 'quiz', title: '题库练习', group: '题库', aliases: ['刷题'] },
  { id: 'vocab', title: '生词本', group: '题库', aliases: ['单词', 'vocabulary'] },
  { id: 'import', title: '导入（统一入口）', group: '工具', aliases: ['import'] },
];

describe('matchCommands', () => {
  it('空查询按注册顺序给出全部（注册顺序就是重要性顺序）', () => {
    expect(matchCommands(LIST, '').map((c) => c.id)).toEqual(['quiz', 'vocab', 'import']);
  });

  it('标题、别名、分组都能命中', () => {
    expect(matchCommands(LIST, '生词').map((c) => c.id)).toEqual(['vocab']);
    expect(matchCommands(LIST, '刷题').map((c) => c.id)).toEqual(['quiz']);
    expect(matchCommands(LIST, 'vocabulary').map((c) => c.id)).toEqual(['vocab']);
  });

  it('大小写不敏感', () => {
    expect(matchCommands(LIST, 'IMPORT').map((c) => c.id)).toEqual(['import']);
  });

  it('匹配不到的查询返回空数组（面板据此显示「没有匹配」）', () => {
    expect(matchCommands(LIST, 'zzzz')).toEqual([]);
  });

  it('limit 生效', () => {
    expect(matchCommands(LIST, '', 2)).toHaveLength(2);
  });
});

describe('生词本', () => {
  it('收词、去重、删词', () => {
    const term = 'zz-test-hepatomegaly';
    removeVocab(term);
    expect(addVocab(term, '肝肿大').added).toBe(true);
    // 同一个词再收一次：不新增，但释义会更新（用户可能补了更准的译法）
    expect(addVocab(term, '肝大').added).toBe(false);
    const e = loadVocab().find((x) => x.term === term);
    expect(e?.def).toBe('肝大');
    removeVocab(term);
    expect(loadVocab().find((x) => x.term === term)).toBeUndefined();
  });

  it('批量粘贴：中英对照拆成词条+释义，拆不出来的整行当词条', () => {
    const a = 'zz-bulk-alpha 甲';
    const b = 'zz-bulk-beta——乙';
    const c = 'zz-bulk-gamma';
    const d = 'zz-bulk-delta 门静脉'; // 单个空格 + 中文解释也要拆
    collectFromText(`${a}\n- ${b}\n${c}
${d}`, '笔记A');
    const map = new Map(loadVocab().map((x) => [x.term, x]));
    expect(map.get('zz-bulk-alpha')?.def).toBe('甲');
    expect(map.get('zz-bulk-beta')?.def).toBe('乙');
    expect(map.get('zz-bulk-gamma')?.def).toBe('');
    expect(map.get('zz-bulk-gamma')?.src).toBe('笔记A');
    expect(map.get('zz-bulk-delta')?.def).toBe('门静脉');
    for (const t of ['zz-bulk-alpha', 'zz-bulk-beta', 'zz-bulk-gamma', 'zz-bulk-delta']) removeVocab(t);
  });

  it('新词进到期队列，复习后统计跟着变', () => {
    const term = 'zz-queue-delta';
    removeVocab(term);
    addVocab(term, '丁');
    const entries = loadVocab();
    expect(vocabDueQueue(entries).some((e) => e.term === term)).toBe(true);
    const card = entries.find((e) => e.term === term);
    if (!card) throw new Error('刚加的词不在生词本里');
    rateVocab(card, 'good');
    expect(vocabStats(loadVocab()).total).toBeGreaterThan(0);
    // 刚评过「认识」的词不该立刻又回到今天的队列里
    expect(vocabDueQueue(loadVocab()).some((e) => e.term === term)).toBe(false);
    removeVocab(term);
  });
});

describe('生词本进备份（只补不覆盖）', () => {
  it('导出的键就是整张词表，恢复时空库按原样补进来', () => {
    const term = 'zz-bak-alpha';
    removeVocab(term);
    addVocab(term, '甲', '某篇笔记');
    const dump = exportVocabState();
    expect(dump[`vocab:${term}`]?.def).toBe('甲');

    const other = 'zz-bak-beta';
    removeVocab(other);
    const r = importVocabState({ [`vocab:${other}`]: { term: other, def: '乙', addedAt: 1 } });
    expect(r.added).toBe(1);
    expect(loadVocab().find((e) => e.term === other)?.def).toBe('乙');

    for (const t of [term, other]) removeVocab(t);
  });

  it('本机已有的词保留本地释义，只补缺的键', () => {
    const term = 'zz-bak-gamma';
    removeVocab(term);
    addVocab(term, '本地改过的释义');
    const r = importVocabState({
      [`vocab:${term}`]: { term, def: '备份里的旧释义', addedAt: 1 },
      'vocab:zz-bak-delta': { term: 'zz-bak-delta', def: '丁', addedAt: 1 },
    });
    expect(r).toEqual({ added: 1, kept: 1 });
    expect(loadVocab().find((e) => e.term === term)?.def).toBe('本地改过的释义');
    for (const t of [term, 'zz-bak-delta']) removeVocab(t);
  });

  it('垃圾输入不炸也不写盘', () => {
    expect(importVocabState(null)).toEqual({ added: 0, kept: 0 });
    expect(importVocabState({ 'vocab:x': { term: '   ' } })).toEqual({ added: 0, kept: 0 });
    expect(importVocabState('不是对象')).toEqual({ added: 0, kept: 0 });
  });
});
