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
 * 引用语义回归。
 * loadMistakes() 返回的若是模块级 cache 本身，clearMistake 就地删除后返回的还是同一个引用，
 * MistakeBook 的 `setMistakes(clearMistake(path))` 拿到同一对象，React 直接 bail out：
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

describe('错因标注 setMistakeReason / reasonCounts', () => {
  it('标注后 loadMistakes 与 localStorage 都能读到', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    const after = mod.setMistakeReason('p.md', 'confusion');

    expect(after['p.md'].reason).toBe('confusion');
    expect(mod.loadMistakes()['p.md'].reason).toBe('confusion');
    // 落盘：不能只活在模块缓存里，重开面板/刷新页面必须还在
    const raw = JSON.parse(localStorage.getItem('knowlattice-mistakes')!) as Record<string, { reason?: string }>;
    expect(raw['p.md'].reason).toBe('confusion');
  });

  it('传 null 取消标注，字段被删掉而不是留 undefined', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    mod.setMistakeReason('p.md', 'careless');
    const after = mod.setMistakeReason('p.md', null);

    expect(after['p.md'].reason).toBeUndefined();
    expect('reason' in after['p.md']).toBe(false);
    const raw = JSON.parse(localStorage.getItem('knowlattice-mistakes')!) as Record<string, object>;
    expect('reason' in raw['p.md']).toBe(false);
  });

  it('返回新对象且不就地改旧快照（setState 才比较得出差异）', async () => {
    const mod = await load();
    const before = mod.recordMistake('p.md', '# T');
    const after = mod.setMistakeReason('p.md', 'knowledge');

    expect(after).not.toBe(before);
    expect(before['p.md'].reason).toBeUndefined();
    expect(after['p.md'].reason).toBe('knowledge');
  });

  it('path 不在错题本里时不凭空建记录', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    const after = mod.setMistakeReason('不存在.md', 'knowledge');
    expect(after['不存在.md']).toBeUndefined();
    expect(Object.keys(after)).toEqual(['p.md']);
  });

  it('再次失败不丢掉已标注的错因', async () => {
    const mod = await load();
    mod.recordMistake('p.md', '# T');
    mod.setMistakeReason('p.md', 'reasoning');
    const after = mod.recordMistake('p.md', '# T');
    expect(after['p.md'].count).toBe(2);
    expect(after['p.md'].reason).toBe('reasoning');
  });

  it('reasonCounts 四档 + 未标注计数正确', async () => {
    const mod = await load();
    mod.recordMistake('a.md', '# A');
    mod.recordMistake('b.md', '# B');
    mod.recordMistake('c.md', '# C');
    mod.recordMistake('d.md', '# D');
    mod.setMistakeReason('a.md', 'knowledge');
    mod.setMistakeReason('b.md', 'knowledge');
    mod.setMistakeReason('c.md', 'careless');

    const rows = mod.reasonCounts();
    expect(rows.map((r) => r.reason)).toEqual(['knowledge', 'confusion', 'careless', 'reasoning']);
    expect(rows.map((r) => r.count)).toEqual([2, 0, 1, 0]);
    // 未标注（d.md）在每一行都能读到，分布条不必再查一次全表
    expect(rows.map((r) => r.unlabeled)).toEqual([1, 1, 1, 1]);
    expect(rows.reduce((s, r) => s + r.count, 0) + rows[0].unlabeled).toBe(4);
  });

  it('旧数据（无 reason 字段）照常读取，全部计入未标注', async () => {
    // 模拟本字段引入前的 localStorage / 备份：只有五个老字段
    localStorage.setItem('knowlattice-mistakes', JSON.stringify({
      'old.md': { path: 'old.md', chapter: '生理', title: '旧错题', count: 3, lastFailedAt: 1 },
    }));
    const mod = await load();
    expect(mod.loadMistakes()['old.md']).toMatchObject({ title: '旧错题', count: 3 });
    expect(mod.loadMistakes()['old.md'].reason).toBeUndefined();
    const rows = mod.reasonCounts();
    expect(rows.every((r) => r.count === 0)).toBe(true);
    expect(rows[0].unlabeled).toBe(1);
  });

  it('importMistakes 保留合法 reason、脏值降级为未标注', async () => {
    const mod = await load();
    mod.importMistakes({
      'ok.md': { path: 'ok.md', count: 1, chapter: 'x', title: 'y', lastFailedAt: 1, reason: 'reasoning' },
      'dirty.md': { path: 'dirty.md', count: 1, chapter: 'x', title: 'y', lastFailedAt: 1, reason: 'not-a-reason' },
    });
    const m = mod.loadMistakes();
    expect(m['ok.md'].reason).toBe('reasoning');
    expect(m['dirty.md'].reason).toBeUndefined();
  });
});
