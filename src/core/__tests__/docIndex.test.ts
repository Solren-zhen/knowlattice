import { describe, expect, it } from 'vitest';
import { buildChunks, buildDocChunks, LONG_NOTE } from '../docIndex';
import { pageAnchor } from '../pageAnchor';

const para = (n: number, t: string) => (t + '。').repeat(n);

function longNote(): string {
  return [
    pageAnchor(1),
    '# 第一章 总论',
    para(240, '总论内容'),
    pageAnchor(2),
    '## 第一节 定义',
    para(240, '定义内容'),
    pageAnchor(3),
    '## 第二节 检查',
    para(240, '检查内容'),
    pageAnchor(4),
    '## 第三节 治疗',
    para(240, '治疗内容'),
  ].join('\n\n');
}

describe('buildChunks', () => {
  it('短笔记退化为整篇一个单元，锚点已剥离', () => {
    const units = buildChunks('短笔记正文。', 'a.md');
    expect(units).toHaveLength(1);
    expect(units[0].heading).toBe('');
    expect(units[0].page).toBeNull();
    expect(units[0].text).toBe('短笔记正文。');
  });

  it('短笔记也能从锚点读出页码', () => {
    const units = buildChunks(`${pageAnchor(5)}\n短正文。`, 'a.md');
    expect(units).toHaveLength(1);
    expect(units[0].page).toBe(5);
    expect(units[0].text).toBe('短正文。');
  });

  it('长笔记按小节切分，段落继承标题与页码', () => {
    const content = longNote();
    expect(content.length).toBeGreaterThan(LONG_NOTE);
    const units = buildChunks(content, '教材/内科学.md');
    expect(units.length).toBeGreaterThan(3);
    const check = units.find((u) => u.text.includes('检查内容'))!;
    expect(check.heading).toBe('第二节 检查');
    expect(check.page).toBe(3);
    const def = units.find((u) => u.text.includes('定义内容'))!;
    expect(def.heading).toBe('第一节 定义');
    expect(def.page).toBe(2);
    const general = units.find((u) => u.text.includes('总论内容'))!;
    expect(general.heading).toBe('第一章 总论');
    expect(general.page).toBe(1);
  });

  it('段落单元不含页码锚点', () => {
    const units = buildChunks(longNote(), 'x.md');
    expect(units.every((u) => !u.text.includes('kb:P'))).toBe(true);
  });

  it('buildDocChunks 只收 .md', () => {
    const docs = new Map([
      ['a.md', '甲'],
      ['img.png', '乙'],
    ]);
    expect([...buildDocChunks(docs).keys()]).toEqual(['a.md']);
  });
});
