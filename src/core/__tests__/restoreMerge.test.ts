/**
 * core/restoreMerge 的纯函数测试（不搭任何存储后端：存在性由假 lookup 提供）。
 *
 * 守用户要求「备份与恢复时不要覆盖已有内容，新增的内容单独增加」的核心：
 *   ① 路径不存在 → 新增；② 已存在且内容相同 → 跳过；③ 已存在且内容不同 → 另存冲突副本（谁都不丢）。
 * 以及冲突命名的**稳定可复现**：同一批同一时间戳、同一批内（乃至库里已有副本时）不撞车。
 */
import { describe, expect, it } from 'vitest';
import {
  formatConflictStamp,
  pickNewListItems,
  pickNewObjectKeys,
  planMerge,
  type ExistingFile,
} from '../restoreMerge';

/** 由「路径 → 内容」表构造一个假 lookup；表里没有的路径即不存在 */
function lookupFrom(map: Record<string, string>): (path: string) => ExistingFile {
  return (path) => (path in map ? { exists: true, content: map[path] } : { exists: false, content: null });
}

const naming = { conflictRoot: '恢复冲突', conflictLabel: '恢复', timestamp: '2026-10-13 2215' };

describe('planMerge：只补不覆盖的三分类', () => {
  it('路径不存在 → 新增；内容相同 → 跳过；内容不同 → 另存（三分类各归各位）', async () => {
    const lookup = lookupFrom({
      '生理/循环.md': '# 循环（用户改过的版本）\n', // 与来源不同 → conflict
      '生理/呼吸.md': '# 呼吸\n', // 与来源逐字相同 → same
      // '生理/消化.md' 不存在 → add
    });
    const plan = await planMerge(
      [
        { path: '生理/循环.md', content: '# 循环（备份里的版本）\n' },
        { path: '生理/呼吸.md', content: '# 呼吸\n' },
        { path: '生理/消化.md', content: '# 消化\n' },
      ],
      lookup,
      naming,
    );

    expect(plan.added).toBe(1);
    expect(plan.conflicts).toBe(1);
    expect(plan.unchanged).toBe(1);
    expect(plan.toAdd.map((e) => e.path)).toEqual(['生理/消化.md']);
    expect(plan.same).toEqual(['生理/呼吸.md']);
    expect(plan.toConflict.map((e) => e.path)).toEqual([
      '恢复冲突/生理/循环（恢复 2026-10-13 2215）.md',
    ]);
    // 另存副本的**内容**是来源（备份）里那一份，不是现有那一份
    expect(plan.toConflict[0].content).toBe('# 循环（备份里的版本）\n');
    // 逐条明细的判定
    expect(plan.entries.map((e) => e.verdict)).toEqual(['conflict', 'same', 'add']);
  });

  it('时间戳稳定可复现（同一批同一命名），带目录与标题', async () => {
    const plan = await planMerge(
      [{ path: 'A/B/标题.md', content: '来源' }],
      lookupFrom({ 'A/B/标题.md': '现有' }),
      naming,
    );
    expect(plan.entries[0].conflictPath).toBe('恢复冲突/A/B/标题（恢复 2026-10-13 2215）.md');
  });

  it('同批内同名条目不会撞车：第二条顺延编号，两个副本都留', async () => {
    // 两条路径不同但去掉目录后标题相同，都会被命名到同一冲突路径 → 必须顺延
    const plan = await planMerge(
      [
        { path: 'X/标题.md', content: '来源1' },
        { path: 'X/标题.md', content: '来源2' },
      ],
      lookupFrom({ 'X/标题.md': '现有' }),
      naming,
    );
    expect(plan.conflicts).toBe(2);
    expect(plan.toConflict.map((e) => e.path)).toEqual([
      '恢复冲突/X/标题（恢复 2026-10-13 2215）.md',
      '恢复冲突/X/标题（恢复 2026-10-13 2215） (2).md',
    ]);
  });

  it('冲突目标在库里已存在时也顺延：绝不覆盖上一次留下的副本', async () => {
    const plan = await planMerge(
      [{ path: 'X/标题.md', content: '来源' }],
      lookupFrom({
        'X/标题.md': '现有',
        '恢复冲突/X/标题（恢复 2026-10-13 2215）.md': '上一次恢复留下的副本',
      }),
      naming,
    );
    expect(plan.toConflict[0].path).toBe('恢复冲突/X/标题（恢复 2026-10-13 2215） (2).md');
  });

  it('拿不到现有内容（只知道存在）时保守按冲突处理，绝不静默覆盖', async () => {
    const lookup = (path: string): ExistingFile =>
      path === '只知存在.md' ? { exists: true, content: null } : { exists: false, content: null };
    const plan = await planMerge([{ path: '只知存在.md', content: '来源' }], lookup, naming);
    expect(plan.conflicts).toBe(1);
    expect(plan.added).toBe(0);
    expect(plan.same).toEqual([]);
  });

  it('formatConflictStamp：YYYY-MM-DD HHmm，稳定可复现', () => {
    expect(formatConflictStamp(new Date(2026, 9, 13, 22, 15))).toBe('2026-10-13 2215');
    expect(formatConflictStamp(new Date(2026, 0, 3, 9, 5))).toBe('2026-01-03 0905');
  });
});

describe('pickNewObjectKeys / pickNewListItems：键已存在保留现有值、只补新键', () => {
  it('对象型：现有键保留（不进 fresh），只挑新键', () => {
    const { fresh, added, kept } = pickNewObjectKeys(
      { a: '备份-a', b: '备份-b', c: '备份-c' },
      { a: '现有-a', b: '现有-b' },
    );
    expect(fresh).toEqual({ c: '备份-c' });
    expect(added).toBe(1);
    expect(kept).toBe(2);
  });

  it('数组型：按身份键判重，现有键保留、只挑新项', () => {
    const { fresh, added, kept } = pickNewListItems(
      [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }],
      new Set(['a', 'b']),
      (it) => (typeof it.id === 'string' ? it.id : undefined),
    );
    expect(fresh).toEqual([{ id: 'c', v: 3 }]);
    expect(added).toBe(1);
    expect(kept).toBe(2);
  });

  it('非对象 / 非数组输入一律当空表处理（坏备份不毁数据、也不抛错）', () => {
    expect(pickNewObjectKeys('不是对象', {}).added).toBe(0);
    expect(pickNewObjectKeys(null, {}).added).toBe(0);
    expect(pickNewObjectKeys([1, 2], {}).added).toBe(0);
    expect(pickNewListItems('不是数组', new Set(), () => undefined).added).toBe(0);
    expect(pickNewListItems(undefined, new Set(), () => undefined).added).toBe(0);
  });
});
