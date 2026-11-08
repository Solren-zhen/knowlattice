/**
 * 思维导图模型层的单元测试（mindmapModel）。
 *
 * 这层原来是 MindMapView 内部的一堆纯函数，只能靠「打开导图点两下」验证。搬出来后钉住三条：
 *   1. 大纲往返恒等（parseOutline ∘ treeToMd）：文本视图的每一次保存都会走这条路，
 *      不恒等就意味着用户只切了一下视图、笔记就变了一次字节；
 *   2. 空节点不许消失：光杆 `-` / 空标题 `#` 是合法 Markdown，序列化必须写成不怕尾随空白清理的形式；
 *   3. frontmatter 只在入口剥一次，写回时由调用方拼回，模型层不许碰它。
 */
import { describe, expect, it } from 'vitest';
import {
  FM_RE,
  LAYOUTS,
  THEMES,
  escapeRe,
  mdToMind,
  mindToMd,
  normalizeOutline,
  parseOutline,
  themeFor,
  treeToMd,
} from '../mindmapModel';

describe('大纲解析与序列化', () => {
  it('一级标题是根，二级标题与列表项按缩进入树', () => {
    const root = parseOutline('# 循环系统\n## 心脏\n- 左心\n  - 左室\n- 右心\n');
    expect(root.content).toBe('循环系统');
    expect(root.children.map((c) => c.content)).toEqual(['心脏']);
    const heart = root.children[0];
    expect(heart.children.map((c) => c.content)).toEqual(['左心', '右心']);
    expect(heart.children[0].children.map((c) => c.content)).toEqual(['左室']);
  });

  it('没有一级标题时根为空，内容不丢', () => {
    const root = parseOutline('- 甲\n- 乙\n');
    expect(root.content).toBe('');
    expect(root.children.map((c) => c.content)).toEqual(['甲', '乙']);
  });

  it('空节点写成光杆 `-`，往返后仍在（尾随空白被清理也不会消失）', () => {
    const md = '# 根\n- 甲\n-\n- 乙\n';
    const once = treeToMd(parseOutline(md));
    expect(once).toContain('\n-\n');
    expect(treeToMd(parseOutline(once))).toBe(once);
  });

  it('往返恒等：再解析再序列化不再变化', () => {
    const md = '# 药理学\n## 抗高血压\n- 一线\n  - ACEI\n  - ARB\n- 二线\n';
    const once = treeToMd(parseOutline(md));
    expect(treeToMd(parseOutline(once))).toBe(once);
  });

  it('缩进统一成每层两个空格', () => {
    expect(treeToMd(parseOutline('# 根\n\t- 甲\n\t\t- 乙\n'))).toBe('# 根\n- 甲\n  - 乙\n');
  });

  it('normalizeOutline 先剥 frontmatter，正文原样保留', () => {
    const md = '---\ntitle: 笔记\n---\n# 根\n- 甲\n';
    expect(md.match(FM_RE)?.[0]).toContain('title: 笔记');
    expect(normalizeOutline(md)).toBe('# 根\n- 甲\n');
  });
});

describe('mind-elixir 数据转换', () => {
  it('md → mind → md 保持标题与层级', () => {
    const md = '# 根\n- 甲\n  - 乙\n';
    const data = mdToMind(md);
    expect(data.nodeData.topic).toBe('根');
    expect(mindToMd(data.nodeData)).toBe(md);
  });

  it('空 md 也不崩（根节点回落成「笔记」）', () => {
    const data = mdToMind('');
    expect(data.nodeData.topic).toBe('笔记');
    expect(mindToMd(data.nodeData)).toBe('# 笔记\n');
  });
});

describe('主题与预设', () => {
  it('四套主题各有名字，互不相同', () => {
    const names = (['follow', 'warm', 'eye', 'plain'] as const).map((id) => themeFor(id, false).name);
    expect(new Set(names).size).toBe(4);
  });

  it('直角连线覆盖主题自带的连线段，其它样式不动', () => {
    const base = themeFor('follow', false, 'curve');
    const ortho = themeFor('follow', false, 'ortho');
    expect(ortho.generateMainBranch).not.toBe(base.generateMainBranch);
    expect(ortho.name).toBe(base.name);
  });

  it('布局预设与主题预设的 id 都唯一', () => {
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(LAYOUTS.length);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it('escapeRe 只转义正则元字符，中英文原样', () => {
    expect(escapeRe('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRe('心衰 (HFrEF)')).toBe('心衰 \\(HFrEF\\)');
  });
});
