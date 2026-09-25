import { describe, expect, it } from 'vitest';
import { parseOutline, outlineLines, activeHeadingLine } from '../outline';

describe('parseOutline', () => {
  it('提取 1~4 级标题与行号（1-based）', () => {
    const items = parseOutline('# 心脏\n\n## 结构\n### 心房\n#### 传导束\n正文');
    expect(items).toEqual([
      { level: 1, text: '心脏', line: 1 },
      { level: 2, text: '结构', line: 3 },
      { level: 3, text: '心房', line: 4 },
      { level: 4, text: '传导束', line: 5 },
    ]);
  });

  it('跳过 frontmatter', () => {
    const items = parseOutline('---\ntags: [x]\nchapter: 不算标题\n---\n\n# 正文标题');
    expect(items).toEqual([{ level: 1, text: '正文标题', line: 6 }]);
  });

  it('跳过围栏代码块里的「标题」（含 ```pathway 与 ~~~）', () => {
    const src = [
      '# 真',
      '```pathway',
      '## 假',
      'A -> B',
      '```',
      '~~~',
      '## 也是假',
      '~~~',
      '## 又是真的',
    ].join('\n');
    expect(parseOutline(src).map((o) => o.text)).toEqual(['真', '又是真的']);
  });

  it('剥离行内标记：加粗/高亮/代码/双链别名/链接；嵌入图题不进目录', () => {
    const items = parseOutline('## **加粗**的==重点==\n## [[目标|显示名]]\n## `代码`标题\n## [文字](https://x)\n## ![[图片.png]]');
    expect(items.map((o) => o.text)).toEqual(['加粗的重点', '显示名', '代码标题', '文字']);
  });

  it('空标题（## 后无文字）不产出', () => {
    expect(parseOutline('## \n## ')).toEqual([]);
  });

  it('缩进的 ## 不算标题（与 livePreview 渲染口径一致）', () => {
    expect(parseOutline('  ## 缩进')).toEqual([]);
  });
});

describe('activeHeadingLine', () => {
  const lines = outlineLines(parseOutline('# A\n\n## B\n\n## C'));
  it('行号数组来自大纲', () => {
    expect(lines).toEqual([1, 3, 5]);
  });
  it('光标在首个标题之前返回 null', () => {
    expect(activeHeadingLine([3, 5], 1)).toBeNull();
  });
  it('光标落在某标题行上 = 该标题', () => {
    expect(activeHeadingLine(lines, 3)).toBe(3);
  });
  it('光标在两个标题之间 = 上一个标题', () => {
    expect(activeHeadingLine(lines, 4)).toBe(3);
  });
  it('光标在最后一个小节 = 最后一个标题', () => {
    expect(activeHeadingLine(lines, 99)).toBe(5);
  });
  it('无标题返回 null', () => {
    expect(activeHeadingLine([], 1)).toBeNull();
  });
});
