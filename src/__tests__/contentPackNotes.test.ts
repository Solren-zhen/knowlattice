/**
 * 讲义页 → 笔记：识别、分册、排序、生成 Markdown。
 * 守的点是「页码顺序不能乱」（'9' 与 '10' 按字符串比会把整本讲义读错）
 * 和「图缺一张不能整页作废」。
 */
import { describe, expect, it } from 'vitest';
import {
  bookMarkdown,
  bookNotePath,
  groupBooks,
  looksLikePageLinks,
  looksLikePages,
  packPageLinks,
  packPages,
  unitBriefIndex,
  type PackPage,
} from '../core/contentPackNotes';

const page = (p: Partial<PackPage>): PackPage => ({
  paper: 'p1',
  label: '生理学讲义',
  teacher: '甲',
  page: '1',
  note: '',
  images: [],
  qids: [],
  ...p,
});

describe('讲义页识别', () => {
  it('认页列表：元素有 paper + page + images', () => {
    expect(looksLikePages([{ paper: 'p', label: 'L', page: '3', images: ['m1'] }])).toBe(true);
  });

  it('不把题库数组、空数组、对象当成讲义页', () => {
    expect(looksLikePages([{ stem: '题目', options: ['A', 'B'], answer: 0 }])).toBe(false);
    expect(looksLikePages([])).toBe(false);
    expect(looksLikePages({ pages: [] })).toBe(false);
  });

  it('认页题映射：键是「paper:页码」', () => {
    expect(looksLikePageLinks({ 'p1:1': ['i1'], 'p1:2': ['i2'], 'p1:3': [] })).toBe(true);
    // 知识点→题的映射键是中文名，不该被当成页题映射
    expect(looksLikePageLinks({ 细胞膜: ['i1'], 动作电位: ['i2'], 肌丝滑行: ['i3'] })).toBe(false);
  });

  it('丢掉缺 paper/page 的页（排不了序，也关联不上题）', () => {
    const got = packPages([
      { paper: 'p1', label: 'L', page: '2', images: ['a'] },
      { paper: 'p1', label: 'L', images: ['b'] },
      { label: 'L', page: '9', images: ['c'] },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].page).toBe('2');
  });

  it('页题映射只留形状正确的键', () => {
    const got = packPageLinks({ 'p1:4': ['i1'], 'p1:5': [1, 2], '随便:写': ['x'] });
    expect(Object.keys(got)).toEqual(['p1:4']);
    expect(got['p1:4']).toEqual(['i1']);
  });
});

describe('分册与排序', () => {
  it('按页码数值排序，不是按字符串', () => {
    const books = groupBooks([
      page({ page: '10' }), page({ page: '9' }), page({ page: '100' }), page({ page: '2' }),
    ]);
    expect(books).toHaveLength(1);
    expect(books[0].pages.map((p) => p.page)).toEqual(['2', '9', '10', '100']);
  });

  it('同一讲义的多个版本分成不同册（页码不通用）', () => {
    const books = groupBooks([
      page({ teacher: '甲', page: '1' }),
      page({ teacher: '乙', page: '1' }),
      page({ teacher: '甲', page: '2' }),
    ]);
    expect(books).toHaveLength(2);
    expect(books.find((b) => b.teacher === '甲')!.pages).toHaveLength(2);
  });

  it('笔记路径带版本子目录，非法字符换成下划线', () => {
    expect(bookNotePath({ key: 'k', label: '生理/学', teacher: '甲:乙', paper: 'p', pages: [] }))
      .toBe('讲义/生理_学/甲_乙.md');
    expect(bookNotePath({ key: 'k', label: '生理学', teacher: '', paper: 'p', pages: [] }))
      .toBe('讲义/生理学.md');
  });
});

describe('生成 Markdown', () => {
  const book = groupBooks([
    page({ page: '1', images: ['m1', 'm2'], note: '脊髓节段' }),
    page({ page: '2', images: ['m3'] }),
  ])[0];

  it('图按页内顺序内联，页码按升序成节', () => {
    const md = bookMarkdown(book, {
      mediaPath: (ref) => `_attachments/${ref}.png`,
    });
    expect(md).toContain('## 第 1 页');
    expect(md).toContain('![](_attachments/m1.png)');
    expect(md.indexOf('m1.png')).toBeLessThan(md.indexOf('m2.png'));
    expect(md.indexOf('## 第 1 页')).toBeLessThan(md.indexOf('## 第 2 页'));
    expect(md).toContain('本页要点：脊髓节段');
  });

  it('缺图的页只跳过那张图，页本身还在', () => {
    const md = bookMarkdown(book, {
      mediaPath: (ref) => (ref === 'm2' ? null : `_attachments/${ref}.png`),
    });
    expect(md).toContain('m1.png');
    expect(md).not.toContain('m2.png');
    expect(md).toContain('## 第 2 页');
    expect(md).toContain('1 张未找到');
  });

  it('整页一张图都没有时给出可读说明（不是空小节）', () => {
    const md = bookMarkdown(groupBooks([page({ page: '7', images: ['m9'] })])[0], { mediaPath: () => null });
    expect(md).toContain('_（本页图片不在导入的这批文件里）_');
  });

  it('把页题映射写成「本页相关题」，并用题干摘要，不超过上限', () => {
    const md = bookMarkdown(book, {
      mediaPath: () => null,
      links: { 'p1:1': ['i1', 'i2', 'i3', 'i4'] },
      index: new Map([
        ['i1', { stem: '脊髓节段共有几个', answers: ['B'] }],
        ['i2', { stem: '颈髓节段数', answers: ['A'] }],
        ['i3', { stem: '胸髓节段数', answers: ['C'] }],
        ['i4', { stem: '腰髓节段数', answers: ['D'] }],
      ]),
      maxItems: 2,
    });
    expect(md).toContain('本页相关题 4 道');
    expect(md).toContain('脊髓节段共有几个（答案 B）');
    expect(md).toContain('…余下 2 道在题库里练');
    expect(md).not.toContain('腰髓节段数');
  });

  it('有映射但没有题干时，明说题干在题库里（不假装已关联到内容）', () => {
    const md = bookMarkdown(book, { mediaPath: () => null, links: { 'p1:1': ['i1'] } });
    expect(md).toContain('题目正文在题库里');
  });

  it('页自带的 qids 在没有映射时也能列出来', () => {
    const b = groupBooks([page({ page: '3', qids: ['x1', 'x2'] })])[0];
    const md = bookMarkdown(b, { mediaPath: () => null });
    expect(md).toContain('本页相关题 2 道');
  });

  it('尾部统计与真实落库张数一致', () => {
    const md = bookMarkdown(book, { mediaPath: (ref) => (ref === 'm3' ? null : `_attachments/${ref}.png`) });
    expect(md).toContain('图片 2 张已落库，1 张未找到');
  });
});

describe('单元文件 → 题干摘要索引', () => {
  it('只取文字块，图块不出现在摘要里；超长截到 60 字', () => {
    const idx = unitBriefIndex({
      format: 'kq.pack.v1',
      items: [{
        qid: 'wc:1:1',
        stem: [{ t: 'text', v: '第一段题干' }, { t: 'image', v: 'm1' }, { t: 'text', v: '续写' }],
        answers: ['A', 'C'],
      }],
    });
    expect(idx.get('wc:1:1')!.stem).toBe('第一段题干 续写');
    expect(idx.get('wc:1:1')!.answers).toEqual(['A', 'C']);
  });

  it('不是内容包的 JSON 不建索引', () => {
    expect(unitBriefIndex({ format: 'something.else', items: [{ qid: 'a', stem: [] }] }).size).toBe(0);
    expect(unitBriefIndex({ items: 'nope' }).size).toBe(0);
  });

  it('没有题干文字的题不占位（避免笔记里出现空白条目）', () => {
    expect(unitBriefIndex({ items: [{ qid: 'a', stem: [{ t: 'image', v: 'm1' }] }] }).size).toBe(0);
  });
});
