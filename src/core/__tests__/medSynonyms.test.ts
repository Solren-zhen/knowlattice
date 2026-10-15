import { afterEach, describe, expect, it } from 'vitest';
import {
  expandQuery, parseSynonymLines, setUserSynonymGroups, synonymTermCount,
} from '../medSynonyms';

afterEach(() => {
  setUserSynonymGroups([]);
});

describe('用户自定义等价词组', () => {
  it('setUserSynonymGroups 立即生效：自定义组内的词互相展开', () => {
    expect(expandQuery('支扩')).toEqual(['支扩']);
    setUserSynonymGroups([['支扩', '支气管扩张']]);
    expect(expandQuery('支扩')).toContain('支气管扩张');
    expect(expandQuery('支气管扩张')).toContain('支扩');
    // 清空后失效
    setUserSynonymGroups([]);
    expect(expandQuery('支扩')).toEqual(['支扩']);
  });

  it('自定义词与内置词表合并不覆盖：内置展开不受影响', () => {
    setUserSynonymGroups([['RTA', '肾小管酸中毒']]);
    expect(expandQuery('心梗')).toContain('心肌梗死');
    expect(synonymTermCount()).toBeGreaterThan(100);
  });

  it('parseSynonymLines：每行一组，空白/逗号/顿号分隔，不足两词丢弃', () => {
    const groups = parseSynonymLines('支扩 支气管扩张\nRTA，肾小管酸中毒、肾小管性酸中毒\n\n只有一个词\n');
    expect(groups).toEqual([
      ['支扩', '支气管扩张'],
      ['RTA', '肾小管酸中毒', '肾小管性酸中毒'],
    ]);
  });
});
