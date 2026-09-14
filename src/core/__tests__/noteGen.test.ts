import { describe, expect, it } from 'vitest';
import { appendExcerpt, draftToMarkdown, generateDraft } from '../noteGen';
import { parseFrontmatter } from '../parser';

describe('generateDraft', () => {
  it('从首句推断标题', () => {
    const d = generateDraft('氧解离曲线是指血红蛋白与氧结合能力随氧分压变化的曲线。');
    expect(d.title).toBe('氧解离曲线');
  });

  it('按语义归组属性键，多句一条子列表', () => {
    const text =
      '定义段。机制段内容较长。机制第二句。临床表现两句？' +
      '临床表现第二句。鉴别段。治疗段。';
    const d = generateDraft(text);
    // splitClauses 按句号拆开后句号被剥离
    expect(d.body).toContain('- 定义: 定义段');
    expect(d.body).toContain('- 机制:');
    expect(d.body).toContain('\t- 机制段内容较长');
    expect(d.body).toContain('- 临床表现:');
    expect(d.body).toContain('- 鉴别: 鉴别段');
    expect(d.body).toContain('- 治疗: 治疗段');
    expect(d.body).toContain('- 我的理解: ');
  });

  it('带序号条款保序还原为有序列表', () => {
    const d = generateDraft('1. 止呕 2. 抑酸 3. 保护黏膜');
    expect(d.body).toContain('- 内容:');
    expect(d.body).toContain('\t1. 止呕');
    expect(d.body).toContain('\t2. 抑酸');
    expect(d.body).toContain('\t3. 保护黏膜');
  });

  it('拆句时去掉 markdown 符号与多余空白', () => {
    const d = generateDraft('**定义：** 这是一个。 又一个。');
    expect(d.body).toContain('- 定义: 定义： 这是一个');
    expect(d.body).toContain('- 要点: 又一个');
  });

  it('选项默认值与 tags 拆分', () => {
    const d = generateDraft('这是目标。', { chapter: '生理', tags: 'a,b,c' });
    expect(d.chapter).toBe('生理');
    expect(d.source).toBe('讲义摘录');
    expect(d.tags).toEqual(['a', 'b', 'c']);
  });

  it('excerpt 模式保留原文，不自动生成分类字段', () => {
    const text = '氧解离曲线是指血红蛋白与氧结合能力随氧分压变化的曲线。作用是促进组织供氧。';
    const d = generateDraft(text, { format: 'excerpt' });
    expect(d.body).toBe(text);
    expect(d.body).not.toContain('- 作用:');
    expect(d.body).not.toContain('- 要点:');
    expect(d.body).not.toContain('- 内容:');
  });

  it('空文本抛错', () => {
    expect(() => generateDraft('   ')).toThrow();
  });
});

describe('draftToMarkdown', () => {
  it('生成带 frontmatter 的完整笔记且可回环解析', () => {
    const d = generateDraft('肺牵张反射是指肺在扩张时反射性抑制吸气。');
    const md = draftToMarkdown(d);
    const p = parseFrontmatter(md);
    expect(p.title).toBe(d.title);
    expect(p.body).toContain('- 定义: ');
    expect(p.meta.aliases).toEqual([d.title]);
    expect(p.meta.tags).toEqual(d.tags);
  });

  it('可以把摘录追加到已有笔记正文末尾', () => {
    const original = '---\nchapter: 生理\n---\n\n# 氧解离曲线\n\n- 定义: 原有内容\n';
    expect(appendExcerpt(original, '新增摘录')).toBe(
      '---\nchapter: 生理\n---\n\n# 氧解离曲线\n\n- 定义: 原有内容\n\n新增摘录\n',
    );
  });
});
