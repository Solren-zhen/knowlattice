/**
 * 医学速查的纯函数测试：症状检索、口诀检索、用户条目合并。
 *
 * 不 mock fetch：这里不测加载（那是 DOM 用例的事），只测「拿到数据之后怎么筛、怎么并」。
 * 重点是两条容易错的边界：空查询要给出可浏览的起点（不能空白），
 * 用户改过的条目要盖住内置那条（自己写的不能被生成物盖回去）。
 */
import { describe, expect, it } from 'vitest';
import {
  countCats,
  inCat,
  mergeSymptoms,
  searchMnemonics,
  searchSymptoms,
  type MedMnemonicLib,
  type MedSymptom,
} from '../medRef';
import { MY_BOOK, mergeMnemonicBooks, type UserMnemonic } from '../medRefStore';

const SYMS: MedSymptom[] = [
  { name: '发热', cat: '全身症状', diseases: ['肺炎', '伤寒'] },
  { name: '头痛', cat: '神经系统', diseases: ['偏头痛'] },
  { name: '咳嗽', cat: '呼吸系统', diseases: ['支气管炎', '肺炎'] },
];

const BOOKS: MedMnemonicLib[] = [
  {
    book: '汤头歌诀',
    note: '公有领域',
    entries: [
      { term: '麻黄汤', cat: '发表之剂', body: '麻黄汤中用桂枝，杏仁甘草四般施', tip: '太阳伤寒' },
      { term: '桂枝汤', cat: '发表之剂', body: '桂枝芍药等分用，姜枣甘草解肌功', tip: '太阳中风' },
    ],
  },
];

describe('searchSymptoms', () => {
  it('空查询给出可浏览的起点，不返回空', () => {
    expect(searchSymptoms(SYMS, '')).toHaveLength(3);
  });

  it('按症状名命中', () => {
    expect(searchSymptoms(SYMS, '头').map((s) => s.name)).toEqual(['头痛']);
  });

  it('疾病名也能搜到对应症状', () => {
    const hit = searchSymptoms(SYMS, '肺炎');
    expect(hit.map((s) => s.name).sort()).toEqual(['发热', '咳嗽'].sort());
  });

  it('limit 生效（边打边筛不能一次渲染几百行）', () => {
    expect(searchSymptoms(SYMS, '', 2)).toHaveLength(2);
  });
});

describe('searchMnemonics', () => {
  it('按方名命中的落在那本书里，其他书被剔掉', () => {
    const hit = searchMnemonics(BOOKS, '麻黄');
    expect(hit).toHaveLength(1);
    expect(hit[0].entries.map((e) => e.term)).toEqual(['麻黄汤']);
  });

  it('正文命中也能搜到（只记得半句时用得上）', () => {
    expect(searchMnemonics(BOOKS, '解肌')[0].entries.map((e) => e.term)).toEqual(['桂枝汤']);
  });

  it('空查询返回整本', () => {
    expect(searchMnemonics(BOOKS, '')[0].entries).toHaveLength(2);
  });
});

describe('mergeSymptoms', () => {
  it('同名时用户那条覆盖内置', () => {
    const mine: MedSymptom[] = [{ name: '发热', cat: '我的分类', diseases: ['我改的病'] }];
    const merged = mergeSymptoms(SYMS, mine);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual(mine[0]);
  });

  it('新名字追加在内置之后', () => {
    const mine: MedSymptom[] = [{ name: '自建症状', cat: '', diseases: [] }];
    expect(mergeSymptoms(SYMS, mine).map((s) => s.name).at(-1)).toBe('自建症状');
  });

  it('没有自建条目时原样返回', () => {
    expect(mergeSymptoms(SYMS, [])).toBe(SYMS);
  });
});

describe('mergeMnemonicBooks', () => {
  it('同名同书覆盖，且排在该书最前', () => {
    const mine: UserMnemonic[] = [
      { book: '汤头歌诀', term: '麻黄汤', cat: '我改的门类', body: '我改的正文', tip: '' },
    ];
    const merged = mergeMnemonicBooks(BOOKS, mine);
    expect(merged[0].entries[0]).toMatchObject({ term: '麻黄汤', body: '我改的正文' });
    expect(merged[0].entries).toHaveLength(2); // 不能变成三条
  });

  it('没有同名书时新增一本「我的口诀」并放在最前', () => {
    const mine: UserMnemonic[] = [{ book: MY_BOOK, term: '自编方', cat: '', body: '自编歌诀', tip: '' }];
    const merged = mergeMnemonicBooks(BOOKS, mine);
    expect(merged[0].book).toBe(MY_BOOK);
    expect(merged).toHaveLength(2);
  });

  it('不修改传入的内置书（生成物在别处还要复用）', () => {
    const mine: UserMnemonic[] = [{ book: '汤头歌诀', term: '新方', cat: '', body: 'x', tip: '' }];
    mergeMnemonicBooks(BOOKS, mine);
    expect(BOOKS[0].entries).toHaveLength(2);
  });
});

describe('countCats', () => {
  it('汇总条目上的分类并计数，按中文排序', () => {
    expect(countCats(['发热', '呼吸系统', '发热', '  呼吸系统 ', ''])).toEqual([
      { name: '发热', count: 2 },
      { name: '呼吸系统', count: 2 },
    ]);
  });

  it('英文分类不因大小写分叉，保留第一次写下的写法', () => {
    expect(countCats(['Fever', 'fever', 'FEVER'])).toEqual([{ name: 'Fever', count: 3 }]);
  });

  it('全是空白时返回空表（没有分类就不显示筛选行）', () => {
    expect(countCats(['', '   '])).toEqual([]);
  });
});

describe('inCat', () => {
  it('空筛选放行全部', () => {
    expect(inCat('发热', '')).toBe(true);
  });

  it('忽略首尾空白与大小写', () => {
    expect(inCat(' Fever ', 'fever')).toBe(true);
    expect(inCat('发热', '呼吸系统')).toBe(false);
  });
});
