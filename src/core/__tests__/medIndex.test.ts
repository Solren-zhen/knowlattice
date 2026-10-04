import { describe, expect, it } from 'vitest';
import { formatMedBooks, formatMedHits, pagesToMarkdown, searchMedBooks } from '../medIndex';
import { pageAnchor } from '../pageAnchor';

const para = (n: number, t: string) => (t + '。').repeat(n);

/** 造一本「长教材」：三段各自一节，各带页码锚点（>4000 字才会走父子切分） */
function makeBook(name: string) {
  const text = [
    pageAnchor(1),
    '# 第一章 总论',
    para(500, '总论内容'),
    pageAnchor(2),
    '## 第一节 检查',
    para(500, '检查方法包括视触叩听'),
    pageAnchor(3),
    '## 第二节 治疗',
    para(500, '治疗方案首选药物'),
  ].join('\n\n');
  return { name, text };
}

describe('pagesToMarkdown', () => {
  it('逐页前置页码锚点（1 基）', () => {
    const md = pagesToMarkdown(['第一页', '第二页']);
    expect(md).toBe(`${pageAnchor(1)}\n第一页\n\n${pageAnchor(2)}\n第二页`);
  });

  it('空页只留锚点，页号不错位', () => {
    const md = pagesToMarkdown(['A', '', 'C']);
    expect(md).toContain(`${pageAnchor(2)}\n\n\n${pageAnchor(3)}`);
  });
});

describe('searchMedBooks', () => {
  it('命中最密集的段落，并继承小节与页码', () => {
    const hits = searchMedBooks([makeBook('内科学（第10版）')], '检查方法');
    expect(hits).toHaveLength(1);
    expect(hits[0].book).toBe('内科学（第10版）');
    expect(hits[0].page).toBe(2);
    expect(hits[0].section).toBe('第一节 检查');
    expect(hits[0].text).toContain('检查方法包括视触叩听');
    expect(hits[0].chunkId).toContain('内科学（第10版）#');
  });

  it('多关键词需同时命中', () => {
    const books = [makeBook('内科学（第10版）')];
    expect(searchMedBooks(books, '总论 治疗方案')).toHaveLength(1);
    expect(searchMedBooks(books, '总论 心电图')).toHaveLength(0);
  });

  it('book 关键字限定教材', () => {
    const books = [makeBook('内科学（第10版）'), makeBook('药理学（第10版）')];
    const hits = searchMedBooks(books, '治疗方案', 6, '药理');
    expect(hits).toHaveLength(1);
    expect(hits[0].book).toBe('药理学（第10版）');
    expect(searchMedBooks(books, '治疗方案', 6, '不存在的书')).toHaveLength(0);
  });

  it('book 参数带空格的多段变体也能命中（每段都出现在书名里）', () => {
    const books = [makeBook('内科学（第10版）'), makeBook('药理学（第10版）')];
    // 模型常把书名抄成「内科学 第10版」（括号丢失、以空格分隔）
    expect(searchMedBooks(books, '治疗方案', 6, '内科学 第10版')).toHaveLength(1);
    expect(searchMedBooks(books, '治疗方案', 6, '内科学（第10版）')).toHaveLength(1);
    // 两段缺一不可
    expect(searchMedBooks(books, '治疗方案', 6, '内科学 药理学')).toHaveLength(0);
  });

  it('空查询返回空', () => {
    expect(searchMedBooks([makeBook('X')], '   ')).toEqual([]);
  });

  it('limit 截断', () => {
    const books = [makeBook('A'), makeBook('B'), makeBook('C')];
    expect(searchMedBooks(books, '治疗方案', 2)).toHaveLength(2);
  });
});

describe('formatMedHits', () => {
  it('空结果给出导入提示', () => {
    expect(formatMedHits([])).toContain('教材库没有检索到');
  });

  it('书名 + 页码 + 章节 + chunk_id', () => {
    const hits = searchMedBooks([makeBook('外科学（第10版）')], '治疗方案');
    const out = formatMedHits(hits);
    expect(out).toContain('《外科学（第10版）》 P3 §第二节 治疗');
    expect(out).toContain('chunk_id=');
  });

  it('超长正文截断', () => {
    const out = formatMedHits([{
      book: 'X', page: 1, section: '', text: '甲'.repeat(2000), chunkId: 'c', score: 1,
    }]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(1200);
  });
});

describe('formatMedBooks', () => {
  it('列出书名与页数', () => {
    const out = formatMedBooks([{ title: '生理学（第10版）', pages: 450, extractablePages: 447 }]);
    expect(out).toContain('已导入 1 本教材');
    expect(out).toContain('《生理学（第10版）》 450 页（可检索 447 页）');
  });

  it('空库提示去设置导入', () => {
    expect(formatMedBooks([])).toContain('教材库为空');
  });
});
