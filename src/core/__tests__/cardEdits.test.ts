import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCard } from '../srsCards';

/**
 * cardEdits 有模块级缓存（复习界面每次渲染都读），所以每个用例都 resetModules 后重新 import，
 * 否则上一个用例的缓存会串味。localStorage 同样每个用例清空。
 */
let m: typeof import('../cardEdits');

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  m = await import('../cardEdits');
});

const card = (key: string, over: Partial<ReviewCard> = {}): ReviewCard => ({
  key,
  path: 'a.md',
  noteTitle: 'A',
  heading: key.includes('#') ? key.split('#')[1] : '',
  body: '原文正文',
  hints: [],
  ...over,
});

describe('applyCardEdits', () => {
  it('没有自定义时原样返回（内容与顺序都不动）', () => {
    const cards = [card('a.md#一'), card('a.md#二')];
    expect(m.applyCardEdits(cards, {})).toEqual(cards);
  });

  it('覆盖正面与背面，其余字段保持原文', () => {
    m.saveCardEdit('a.md#一', { front: '我的问题', back: '我的答案' });
    const [out] = m.applyCardEdits([card('a.md#一')], m.loadCardEdits());
    expect(out.front).toBe('我的问题');
    expect(out.back).toBe('我的答案');
    expect(out.body).toBe('原文正文');
    expect(out.path).toBe('a.md');
  });

  it('空白覆盖 = 回落笔记原文（不留空字符串）', () => {
    m.saveCardEdit('a.md#一', { front: '   ', back: '答案' });
    const [out] = m.applyCardEdits([card('a.md#一')], m.loadCardEdits());
    expect(out.front).toBeUndefined();
    expect(out.back).toBe('答案');
  });

  it('已删除的卡不进结果，其余顺序不变', () => {
    m.deleteCard('a.md#二');
    const out = m.applyCardEdits([card('a.md#一'), card('a.md#二'), card('a.md#三')], m.loadCardEdits());
    expect(out.map((c) => c.key)).toEqual(['a.md#一', 'a.md#三']);
  });
});

describe('saveCardEdit / deleteCard / restoreCard', () => {
  it('两面都清空且未删除时整条记录删掉（不留空壳）', () => {
    m.saveCardEdit('a.md#一', { front: 'x' });
    expect(Object.keys(m.loadCardEdits())).toEqual(['a.md#一']);
    m.saveCardEdit('a.md#一', { front: '', back: '' });
    expect(m.loadCardEdits()).toEqual({});
  });

  it('删除只是打标记：正面/背面的自定义仍保留', () => {
    m.saveCardEdit('a.md#一', { front: '问题', back: '答案' });
    m.deleteCard('a.md#一');
    expect(m.loadCardEdits()['a.md#一']).toMatchObject({ front: '问题', back: '答案', deleted: true });
  });

  it('恢复：带回自定义；没有自定义的整条清掉', () => {
    m.saveCardEdit('a.md#一', { front: '问题' });
    m.deleteCard('a.md#一');
    m.restoreCard('a.md#一');
    expect(m.loadCardEdits()['a.md#一']).toMatchObject({ front: '问题' });
    expect(m.loadCardEdits()['a.md#一'].deleted).toBeUndefined();

    m.deleteCard('a.md#二');
    m.restoreCard('a.md#二');
    expect(m.loadCardEdits()['a.md#二']).toBeUndefined();
  });

  it('删除后卡片从复习集合消失，恢复后回来（这是「删卡不动笔记」的关键）', () => {
    const cards = [card('a.md#一')];
    m.deleteCard('a.md#一');
    expect(m.applyCardEdits(cards, m.loadCardEdits())).toEqual([]);
    m.restoreCard('a.md#一');
    expect(m.applyCardEdits(cards, m.loadCardEdits())).toHaveLength(1);
  });

  it('deletedKeys 按更新时间倒序（最近删的在最前）', () => {
    m.deleteCard('a.md#一', 100);
    m.deleteCard('a.md#二', 200);
    expect(m.deletedKeys(m.loadCardEdits())).toEqual(['a.md#二', 'a.md#一']);
  });
});

describe('导出 / 导入（随整包备份）', () => {
  it('exportCardEdits 就是当前存储', () => {
    m.saveCardEdit('a.md#一', { front: '问题' });
    expect(m.exportCardEdits()).toEqual(m.loadCardEdits());
  });

  it('导入是合并：同键覆盖、其余保留，返回条数', () => {
    m.saveCardEdit('a.md#keep', { front: '本地' });
    m.saveCardEdit('a.md#一', { front: '旧的' });
    const n = m.importCardEdits({
      'a.md#一': { front: '新的', updatedAt: 5 },
      'a.md#new': { deleted: true, updatedAt: 6 },
    });
    expect(n).toBe(2);
    const map = m.loadCardEdits();
    expect(map['a.md#keep'].front).toBe('本地');
    expect(map['a.md#一'].front).toBe('新的');
    expect(map['a.md#new'].deleted).toBe(true);
  });

  it('脏数据被忽略：非对象、空记录、非字符串字段', () => {
    expect(m.importCardEdits(null)).toBe(0);
    expect(m.importCardEdits('x')).toBe(0);
    expect(m.importCardEdits({ a: null, b: {}, c: { front: 42 }, d: { deleted: 'yes' } })).toBe(0);
    expect(m.loadCardEdits()).toEqual({});
  });

  it('损坏的 localStorage 回退为空对象，不抛错', () => {
    localStorage.setItem('knowlattice-card-edits', 'not-json');
    expect(m.loadCardEdits()).toEqual({});
  });

  it('读取时丢掉空记录（备份里可能有历史空壳）', () => {
    localStorage.setItem('knowlattice-card-edits', JSON.stringify({ a: { updatedAt: 1 }, b: { front: 'ok', updatedAt: 2 } }));
    expect(Object.keys(m.loadCardEdits())).toEqual(['b']);
  });
});
