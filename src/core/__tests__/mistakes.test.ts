import { beforeEach, describe, expect, it, vi } from 'vitest';

// mistakes.ts 有模块级 cache，测试间用 resetModules 隔离
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function load() {
  return await import('../mistakes');
}

describe('recordMistake', () => {
  it('从 frontmatter 取章节与标题，记录失败', async () => {
    const content = `---
tags: []
chapter: 生理学
---

# 氧解离曲线

正文
`;
    const m = await load().then((mod) => mod.recordMistake('01-生理/氧解离.md', content));
    expect(m['01-生理/氧解离.md']).toMatchObject({
      path: '01-生理/氧解离.md',
      chapter: '生理学',
      title: '氧解离曲线',
      count: 1,
    });
    expect(m['01-生理/氧解离.md'].lastFailedAt).toBeGreaterThan(0);
  });

  it('同一路径反复失败累加计数', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    const after = mod.recordMistake('p.md', '# T');
    expect(after['p.md'].count).toBe(2);
  });

  it('缺 frontmatter 时标题回退到文件名', async () => {
    const mod = await load();
    const after = mod.recordMistake('dir/无标题.md', '纯正文');
    expect(after['dir/无标题.md'].title).toBe('无标题');
    expect(after['dir/无标题.md'].chapter).toBe('未分类');
  });
});

describe('clearMistake / chapterHeat / importMistakes', () => {
  it('clearMistake 删除记录', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    expect(mod.clearMistake('p.md')).toEqual({});
  });

  it('chapterHeat 按章节聚合且按次数降序', async () => {
    const mod = await load();
    mod.recordMistake('a.md', `---\ntags: []\nchapter: 生理\n---\n# A`);
    mod.recordMistake('b.md', `---\ntags: []\nchapter: 生理\n---\n# B`);
    mod.recordMistake('a.md', `---\ntags: []\nchapter: 生理\n---\n# A`);
    mod.recordMistake('c.md', `---\ntags: []\nchapter: 生化\n---\n# C`);
    const heat = mod.chapterHeat(mod.loadMistakes());
    expect(heat[0]).toEqual({ chapter: '生理', count: 3 });
    expect(heat[1]).toEqual({ chapter: '生化', count: 1 });
  });

  it('importMistakes 合并并校验字段', async () => {
    const mod = await load();
    mod.recordMistake('keep.md', '# K');
    const n = mod.importMistakes({
      'keep.md': { path: 'keep.md', count: 99, chapter: 'x', title: 'y', lastFailedAt: 1 },
      bad: { count: 'not-number' },
    });
    expect(n).toBe(1);
    expect(mod.loadMistakes()['keep.md'].count).toBe(99);
    expect(mod.loadMistakes()).not.toHaveProperty('bad');
  });

  it('parseFrontmatter 与 recordMistake 的字段口径一致', async () => {
    const { parseFrontmatter } = await import('../parser');
    const mod = await load();
    const content = `---
tags: []
chapter: 生理学
---

# 氧解离曲线
`;
    const m = mod.recordMistake('p.md', content);
    const { title, meta } = parseFrontmatter(content);
    expect(m['p.md'].title).toBe(title);
    expect(m['p.md'].chapter).toBe(meta.chapter);
  });
});

/**
 * 引用语义回归测试（2026-09-20 修复）。
 * 旧实现里 loadMistakes() 返回模块级 cache 本身、clearMistake 就地删除后返回同一个引用，
 * 于是 MistakeBook 的 `setMistakes(clearMistake(path))` 拿到同一对象，React 直接 bail out：
 * 记录从 localStorage 删了，但行还在、计数不变、热力条不变，用户以为按钮坏了。
 */
describe('返回新对象（保证 setState 能触发重渲染）', () => {
  it('loadMistakes 每次返回不同的对象', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    expect(mod.loadMistakes()).not.toBe(mod.loadMistakes());
  });

  it('loadMistakes 返回的是浅拷贝：改返回值不会污染缓存', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    const snapshot = mod.loadMistakes();
    delete snapshot['p.md'];
    expect(mod.loadMistakes()['p.md']).toBeDefined();
  });

  it('clearMistake 返回新对象，且旧快照仍保留被删记录（React 才比较得出差异）', async () => {
    const mod = await load();
    const before = mod.recordMistake('p.md', '# T');
    const after = mod.clearMistake('p.md');

    expect(after).not.toBe(before);
    expect(after['p.md']).toBeUndefined();
    expect(before['p.md']).toBeDefined();
  });

  it('recordMistake 返回新对象', async () => {
    const mod = await load();
    const a = mod.recordMistake('p.md', '# T');
    const b = mod.recordMistake('p.md', '# T');
    expect(b).not.toBe(a);
    expect(b['p.md'].count).toBe(2);
  });
});
