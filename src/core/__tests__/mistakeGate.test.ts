import { beforeEach, describe, expect, it, vi } from 'vitest';

// mistakes.ts 有模块级错题缓存，测试间用 resetModules 隔离（同 mistakes.test.ts）
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.useRealTimers();
});

async function load() {
  return await import('../mistakes');
}

const DAY = 86_400_000;
/** 固定基准：2026-01-10 10:00（本地时区），所有门控计算都以它为准 */
const T0 = new Date(2026, 0, 10, 10, 0, 0).getTime();

function freeze(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

describe('归档门控 · 记录与推进', () => {
  it('新错题从 0 阶段开始，立刻到期', async () => {
    freeze(T0);
    const m = await load();
    const map = m.recordMistake('a.md', '# A');
    expect(map['a.md']).toMatchObject({ stage: 0, dueAt: T0, lapses: 0 });
    expect(m.dueMistakes(T0).map((r) => r.path)).toEqual(['a.md']);
  });

  it('同一自然日内连对两次只推进一格', async () => {
    freeze(T0);
    const m = await load();
    m.recordMistake('a.md', '# A');
    m.advanceMistake('a.md', T0 + 60_000);
    expect(m.getMistake('a.md')!.stage).toBe(1);
    // 同一天稍晚再对一次：不推进（否则点两下就归档，门控等于没有）
    m.advanceMistake('a.md', T0 + 3_600_000);
    expect(m.getMistake('a.md')!.stage).toBe(1);
  });

  it('隔天再对推进一格，到期时间按 1/3/7 天递增', async () => {
    freeze(T0);
    const m = await load();
    m.recordMistake('a.md', '# A');

    const d1 = T0 + DAY;
    m.advanceMistake('a.md', d1);
    expect(m.getMistake('a.md')).toMatchObject({ stage: 1, dueAt: d1 + DAY });

    const d2 = d1 + 2 * DAY;
    m.advanceMistake('a.md', d2);
    expect(m.getMistake('a.md')).toMatchObject({ stage: 2, dueAt: d2 + 3 * DAY });

    const d3 = d2 + 4 * DAY;
    m.advanceMistake('a.md', d3);
    expect(m.getMistake('a.md')).toMatchObject({ stage: 3, dueAt: d3 + 7 * DAY });
  });

  it('到达 3 阶段即归档：之后不再进队列，也不再被推进', async () => {
    freeze(T0);
    const m = await load();
    m.recordMistake('a.md', '# A');
    for (const t of [T0 + DAY, T0 + 4 * DAY, T0 + 12 * DAY]) m.advanceMistake('a.md', t);
    const rec = m.getMistake('a.md')!;
    expect(m.isArchived(rec)).toBe(true);
    expect(m.dueMistakes(T0 + 400 * DAY)).toEqual([]);
    expect(m.advanceMistake('a.md', T0 + 800 * DAY)['a.md'].stage).toBe(3);
  });

  it('答错回落：阶段归零、立刻到期、lapses +1', async () => {
    freeze(T0);
    const m = await load();
    m.recordMistake('a.md', '# A');
    m.advanceMistake('a.md', T0 + DAY);
    expect(m.getMistake('a.md')!.stage).toBe(1);

    const t1 = T0 + 2 * DAY;
    m.lapseMistake('a.md', t1);
    expect(m.getMistake('a.md')).toMatchObject({ stage: 0, dueAt: t1, lapses: 1, lastAdvanceAt: 0 });
    expect(m.dueMistakes(t1).map((r) => r.path)).toEqual(['a.md']);
    // 回落当天仍可算作新一轮的第一次推进（lastAdvanceAt 已清零）
    m.advanceMistake('a.md', t1 + 60_000);
    expect(m.getMistake('a.md')!.stage).toBe(1);
  });

  it('又错一次（recordMistake）同样回落并累计 lapses，但不动已标错因', async () => {
    freeze(T0);
    const m = await load();
    m.recordMistake('a.md', '# A');
    m.setMistakeReason('a.md', 'confusion');
    m.advanceMistake('a.md', T0 + DAY);
    const after = m.recordMistake('a.md', '# A');
    expect(after['a.md']).toMatchObject({ stage: 0, dueAt: T0, lapses: 1, reason: 'confusion', count: 2 });
  });

  it('不存在的路径不凭空造记录', async () => {
    freeze(T0);
    const m = await load();
    expect(m.advanceMistake('nope.md', T0)).toEqual({});
    expect(m.lapseMistake('nope.md', T0)).toEqual({});
  });
});

describe('归档门控 · 队列与分池', () => {
  it('只返回到期且未归档的错题，逾期久的在前', async () => {
    freeze(T0);
    // 先落盘再 import：模块缓存建立后不会再读 localStorage，顺序写反就测不到东西
    localStorage.setItem(
      'knowlattice-mistakes',
      JSON.stringify({
        'late.md': { path: 'late.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 0, dueAt: T0 - 5 * DAY, lapses: 0 },
        'today.md': { path: 'today.md', chapter: '', title: '', count: 9, lastFailedAt: 0, stage: 0, dueAt: T0, lapses: 0 },
        'future.md': { path: 'future.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 1, dueAt: T0 + DAY, lapses: 0 },
        'done.md': { path: 'done.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 3, dueAt: T0 - 9 * DAY, lapses: 0 },
      }),
    );
    const m = await load();
    expect(m.dueMistakes(T0).map((r) => r.path)).toEqual(['late.md', 'today.md']);
  });

  it('分池：逾期优先于阶段，归档单独一池', async () => {
    freeze(T0);
    localStorage.setItem(
      'knowlattice-mistakes',
      JSON.stringify({
        'a.md': { path: 'a.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 0, dueAt: T0, lapses: 0 },
        'b.md': { path: 'b.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 1, dueAt: T0, lapses: 0 },
        'c.md': { path: 'c.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 2, dueAt: T0, lapses: 0 },
        'd.md': { path: 'd.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 0, dueAt: T0 - 2 * DAY, lapses: 0 },
        'e.md': { path: 'e.md', chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 3, dueAt: T0, lapses: 0 },
      }),
    );
    const m = await load();
    expect(m.mistakePools(T0, m.loadMistakes())).toEqual({
      overdue: 1,
      critical: 1,
      core: 1,
      review: 1,
      archived: 1,
      total: 5,
    });
  });

  it('今日队列按池配额截断：刚错池只出 5 条', async () => {
    freeze(T0);
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      map[`m${i}.md`] = { path: `m${i}.md`, chapter: '', title: '', count: 1, lastFailedAt: 0, stage: 0, dueAt: T0, lapses: 0 };
    }
    localStorage.setItem('knowlattice-mistakes', JSON.stringify(map));
    const m = await load();
    expect(m.takeDueMistakes(T0, m.loadMistakes())).toHaveLength(5);
  });

  it('旧数据没有门控字段：按刚错、立即到期处理', async () => {
    freeze(T0);
    localStorage.setItem(
      'knowlattice-mistakes',
      JSON.stringify({ 'old.md': { path: 'old.md', chapter: '生理', title: '氧解离', count: 3, lastFailedAt: T0 - DAY } }),
    );
    const m = await load();
    expect(m.stageOf(m.getMistake('old.md')!)).toBe(0);
    expect(m.dueMistakes(T0).map((r) => r.path)).toEqual(['old.md']);
    expect(m.mistakePools(T0).total).toBe(1);
  });
});
