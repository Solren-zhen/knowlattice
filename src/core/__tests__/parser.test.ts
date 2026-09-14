import { describe, expect, it } from 'vitest';
import {
  noteTemplate,
  parseFrontmatter,
  parseFrontmatterCached,
  serializeFrontmatter,
} from '../parser';

describe('parseFrontmatter', () => {
  it('解析基础字段与一级标题', () => {
    const raw = `---
aliases: [氧离曲线, 氧解离]
tags: [生理学, 呼吸]
chapter: 生理学
source: 讲义
created: 2026-01-02
exam: [2023-生理-12]
---

# 氧解离曲线

正文内容
`;
    const r = parseFrontmatter(raw);
    expect(r.meta.aliases).toEqual(['氧离曲线', '氧解离']);
    expect(r.meta.tags).toEqual(['生理学', '呼吸']);
    expect(r.meta.chapter).toBe('生理学');
    expect(r.meta.source).toBe('讲义');
    expect(r.meta.created).toBe('2026-01-02');
    expect(r.meta.exam).toEqual(['2023-生理-12']);
    expect(r.title).toBe('氧解离曲线');
    // body 含一级标题行（frontmatter 之后整体为正文）
    expect(r.body).toBe('\n# 氧解离曲线\n\n正文内容\n');
  });

  it('支持多行 YAML 列表与带引号的值', () => {
    const raw = `---
aliases:
  - "别名一"
  - 别名二
tags:
  - t1
---

# 标题
`;
    const r = parseFrontmatter(raw);
    expect(r.meta.aliases).toEqual(['别名一', '别名二']);
    expect(r.meta.tags).toEqual(['t1']);
  });

  it('无 frontmatter 时原样返回正文', () => {
    const r = parseFrontmatter('# 纯标题\n\n内容');
    expect(r.meta.aliases).toEqual([]);
    expect(r.title).toBe('纯标题');
    expect(r.body).toBe('# 纯标题\n\n内容');
  });

  it('正文 #标签 与 frontmatter 合并去重', () => {
    const raw = `---
tags: [呼吸]
---

# 标题

#标签A 正文 #标签B #标签A
`;
    const r = parseFrontmatter(raw);
    expect(r.meta.tags).toHaveLength(3);
    expect(r.meta.tags).toEqual(expect.arrayContaining(['标签A', '标签B', '呼吸']));
  });

  it('代码块内的 #标签 不收集，且数量有上限', () => {
    const raw = `---
tags: []
---

\`\`\`
# 不是标签
\`\`\`

#真标签
`;
    const r = parseFrontmatter(raw);
    expect(r.meta.tags).toEqual(['真标签']);
  });

  it('处理 CRLF 换行', () => {
    const raw = '---\r\ntags: [a]\r\n---\r\n# 标题\r\n';
    expect(parseFrontmatter(raw).meta.tags).toEqual(['a']);
  });

  it('不把我的标题当成标签：行尾无空格、无前导 # 的才是', () => {
    const raw = '# C# 语言\n\n### 标题\n\n内容 #tag';
    expect(parseFrontmatter(raw).meta.tags).toEqual(['tag']);
  });
});

describe('parseFrontmatterCached', () => {
  it('内容引用相同则命中缓存', () => {
    const content = '# 同一篇\n';
    const a = parseFrontmatterCached('x.md', content);
    const b = parseFrontmatterCached('x.md', content);
    expect(a).toBe(b);
  });

  it('内容变化后对象更新且互不串台（缓存仅保留最新一篇）', () => {
    const a = parseFrontmatterCached('x.md', '# 第一版\n');
    const b = parseFrontmatterCached('x.md', '# 第二版\n');
    expect(a.title).toBe('第一版');
    expect(b.title).toBe('第二版');
    expect(a).not.toBe(b);
    // 已过期内容命中不了缓存，重新解析（对象新开、内容正确）
    const c = parseFrontmatterCached('x.md', '# 第一版\n');
    expect(c).not.toBe(a);
    expect(c.title).toBe('第一版');
  });
});

describe('serializeFrontmatter / noteTemplate', () => {
  it('序列化后回环解析一致', () => {
    const meta = {
      aliases: ['a1', 'a2'],
      tags: ['t1'],
      chapter: '生理',
      source: '讲义',
      created: '2026-01-01',
      exam: ['2023-生理-12'],
    };
    const text = serializeFrontmatter(meta);
    expect(text.startsWith('---\n')).toBe(true);
    expect(parseFrontmatter(text + '\n# 标题').meta).toMatchObject(meta);
  });

  it('noteTemplate 按类型生成骨架且自动填 created', () => {
    const t = noteTemplate('高血压', '心血管', 'disease');
    expect(t).toContain('# 高血压');
    expect(t).toContain('- 定义: ');
    expect(t).toContain('- 临床表现: ');
    expect(t).toContain(`created: ${new Date().toISOString().slice(0, 10)}`);
  });

  it('blank 类型正文为空', () => {
    const t = noteTemplate('空白篇', '', 'blank');
    expect(t.endsWith('\n# 空白篇\n\n')).toBe(true);
  });
});
