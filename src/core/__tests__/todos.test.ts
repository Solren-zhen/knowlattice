import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDays, addSubtask, BUCKET_LABELS, bulkComplete, bulkRemove, bulkUpdate, clearCompleted, completeTodo,
  dayKey, daysBetween, dueBucket, dueLabel, editTodo, exportTodos, groupByNote, groupTodos, importTodos,
  inSmartList, loadTodos, makeTodo, matchesQuery, moveTodo, newTodoId, nextDue, parseQuickAdd, removeSubtask,
  removeTodo, rollover, saveTodos, smartCounts, sortTodos, subtaskProgress, todoStats, todoStreak, todoTrend,
  toggleAll, toggleSubtask, updateTodo, type Todo,
} from '../todos';

beforeEach(() => localStorage.clear());

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'a',
  text: '复习呼吸章节',
  done: false,
  createdAt: 1,
  ...over,
});

describe('todos', () => {
  it('读写往返', () => {
    saveTodos([todo(), todo({ id: 'b', text: '整理糖代谢', done: true, completedAt: 9 })]);
    expect(loadTodos()).toHaveLength(2);
    expect(loadTodos()[1]).toMatchObject({ id: 'b', done: true, completedAt: 9 });
  });

  it('损坏或非数组数据回退为空', () => {
    localStorage.setItem('knowlattice-todos', 'not-json');
    expect(loadTodos()).toEqual([]);
    localStorage.setItem('knowlattice-todos', '{"id":"a"}');
    expect(loadTodos()).toEqual([]);
  });

  it('exportTodos 导出的就是当前列表', () => {
    saveTodos([todo()]);
    expect(exportTodos()).toEqual([todo()]);
  });

  it('importTodos 合并：同 id 覆盖、其余本地条目保留', () => {
    saveTodos([todo({ id: 'keep', text: '本地保留' }), todo({ id: 'a', text: '旧文本' })]);
    const n = importTodos([todo({ id: 'a', text: '新文本' }), todo({ id: 'new', text: '备份新增' })]);
    expect(n).toBe(2);
    const list = loadTodos();
    expect(list).toHaveLength(3);
    expect(list.find((t) => t.id === 'keep')?.text).toBe('本地保留');
    expect(list.find((t) => t.id === 'a')?.text).toBe('新文本');
    expect(list.find((t) => t.id === 'new')?.text).toBe('备份新增');
  });

  it('importTodos 跳过形状不对的条目，并补齐缺失字段', () => {
    const n = importTodos([
      null,
      { text: '没有 id' },
      { id: 'x' },
      '字符串',
      { id: 'ok', text: '正常' },
    ]);
    expect(n).toBe(1);
    expect(loadTodos()).toEqual([
      { id: 'ok', text: '正常', done: false, createdAt: expect.any(Number) },
    ]);
  });

  it('importTodos 对非数组输入返回 0 且不动本地数据', () => {
    saveTodos([todo()]);
    expect(importTodos(null)).toBe(0);
    expect(importTodos({ id: 'a', text: 'x' })).toBe(0);
    expect(loadTodos()).toEqual([todo()]);
  });

  it('importTodos 空数组不改写存储', () => {
    saveTodos([todo()]);
    expect(importTodos([])).toBe(0);
    expect(loadTodos()).toEqual([todo()]);
  });

  it('newTodoId 带 t- 前缀且连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTodoId()));
    expect(ids.size).toBe(200);
    expect([...ids].every((id) => id.startsWith('t-'))).toBe(true);
  });
});

describe('M8 日期工具', () => {
  it('dayKey 用本地时区（不能用 UTC，否则晚上八点后差一天）', () => {
    expect(dayKey(new Date(2026, 8, 21, 23, 30))).toBe('2026-09-21');
    expect(dayKey(new Date(2026, 0, 3))).toBe('2026-01-03');
  });

  it('addDays 跨月跨年正确', () => {
    expect(addDays('2026-09-21', 1)).toBe('2026-09-22');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2026-09-21', 7)).toBe('2026-09-28');
  });

  it('daysBetween 正负号与跨月', () => {
    expect(daysBetween('2026-09-21', '2026-09-21')).toBe(0);
    expect(daysBetween('2026-09-21', '2026-09-24')).toBe(3);
    expect(daysBetween('2026-09-21', '2026-09-19')).toBe(-2);
    expect(daysBetween('2026-09-30', '2026-10-02')).toBe(2);
  });

  it('dueLabel：今天/明天/后天/昨天/逾期/同年省年份', () => {
    expect(dueLabel(undefined, '2026-09-21')).toBe('');
    expect(dueLabel('2026-09-21', '2026-09-21')).toBe('今天');
    expect(dueLabel('2026-09-22', '2026-09-21')).toBe('明天');
    expect(dueLabel('2026-09-23', '2026-09-21')).toBe('后天');
    expect(dueLabel('2026-09-20', '2026-09-21')).toBe('昨天');
    expect(dueLabel('2026-09-18', '2026-09-21')).toBe('逾期 3 天');
    expect(dueLabel('2026-09-25', '2026-09-21')).toBe('9月25日');
    expect(dueLabel('2027-01-05', '2026-09-21')).toBe('2027年1月5日');
  });
});

describe('M8 短语法 parseQuickAdd', () => {
  const today = '2026-09-21'; // 周一
  const notes = [{ name: '呼吸系统', path: '内科学/呼吸系统.md' }];

  it('一次解析出正文、到期、优先级、关联笔记、重复', () => {
    const q = parseQuickAdd('复习呼吸系统 @明天 !高 #呼吸系统 *每天', today, notes);
    expect(q).toEqual({
      text: '复习呼吸系统',
      due: '2026-09-22',
      priority: 1,
      note: '内科学/呼吸系统.md',
      repeat: 'daily',
    });
  });

  it('认不出来的词留在正文里（宁可多几个字，也不吞内容）', () => {
    expect(parseQuickAdd('看 @下辈子 的书 !特高 #没这篇 *每分钟', today, notes)).toEqual({
      text: '看 @下辈子 的书 !特高 #没这篇 *每分钟',
    });
  });

  it('@今天/@后天/@昨天/@+3 都认', () => {
    expect(parseQuickAdd('a @今天', today).due).toBe('2026-09-21');
    expect(parseQuickAdd('a @后天', today).due).toBe('2026-09-23');
    expect(parseQuickAdd('a @昨天', today).due).toBe('2026-09-20');
    expect(parseQuickAdd('a @+3', today).due).toBe('2026-09-24');
  });

  it('@周一…@周日 取下一个该星期几（今天就是那天则算今天）', () => {
    expect(parseQuickAdd('a @周一', today).due).toBe('2026-09-21');
    expect(parseQuickAdd('a @周三', today).due).toBe('2026-09-23');
    expect(parseQuickAdd('a @周日', today).due).toBe('2026-09-27');
  });

  it('@9-25 与 @2026-09-25 两种写法', () => {
    expect(parseQuickAdd('a @9-25', today).due).toBe('2026-09-25');
    expect(parseQuickAdd('a @9月25日', today).due).toBe('2026-09-25');
    expect(parseQuickAdd('a @2026-10-01', today).due).toBe('2026-10-01');
  });

  it('优先级接受中文与数字；重复接受每天/每周', () => {
    expect(parseQuickAdd('a !中', today).priority).toBe(2);
    expect(parseQuickAdd('a !3', today).priority).toBe(3);
    expect(parseQuickAdd('a !低', today).priority).toBe(3);
    expect(parseQuickAdd('a *每周', today).repeat).toBe('weekly');
  });

  it('同一种标记出现两次时只取第一个，多出来的留在正文', () => {
    const q = parseQuickAdd('a @今天 @明天', today);
    expect(q.due).toBe('2026-09-21');
    expect(q.text).toBe('a @明天');
  });

  it('笔记名大小写不敏感；正文多余空格被规整', () => {
    expect(parseQuickAdd('x  #呼吸系统', today, notes).note).toBe('内科学/呼吸系统.md');
    expect(parseQuickAdd('  看   书  ', today).text).toBe('看 书');
  });

  it('空输入得到空正文', () => {
    expect(parseQuickAdd('   ', today)).toEqual({ text: '' });
  });
});

describe('M8 分组 / 排序 / 统计', () => {
  const today = '2026-09-21';

  it('dueBucket 五档', () => {
    expect(dueBucket(todo({ due: '2026-09-20' }), today)).toBe('overdue');
    expect(dueBucket(todo({ due: '2026-09-21' }), today)).toBe('today');
    expect(dueBucket(todo({ due: '2026-09-22' }), today)).toBe('tomorrow');
    expect(dueBucket(todo({ due: '2026-09-30' }), today)).toBe('later');
    expect(dueBucket(todo(), today)).toBe('none');
  });

  it('groupTodos：未完成按 逾期→今天→明天→之后→未排期，已完成单独垫底', () => {
    const list = [
      todo({ id: 'later', due: '2026-09-30' }),
      todo({ id: 'done', done: true, due: '2026-09-21' }),
      todo({ id: 'over', due: '2026-09-19' }),
      todo({ id: 'none' }),
      todo({ id: 'today', due: today }),
      todo({ id: 'tom', due: '2026-09-22' }),
    ];
    const groups = groupTodos(list, today);
    expect(groups.map((g) => g.bucket)).toEqual(['overdue', 'today', 'tomorrow', 'later', 'none', 'done']);
    expect(groups.map((g) => g.items.map((t) => t.id))).toEqual([
      ['over'], ['today'], ['tom'], ['later'], ['none'], ['done'],
    ]);
    expect(BUCKET_LABELS.done).toBe('已完成');
  });

  it('groupTodos 丢掉空分组', () => {
    expect(groupTodos([todo()], today).map((g) => g.bucket)).toEqual(['none']);
  });

  it('sortTodos：优先级高在前、没设的沉底；到期按日期、没排期沉底', () => {
    const list = [todo({ id: 'none' }), todo({ id: 'low', priority: 3 }), todo({ id: 'high', priority: 1 })];
    expect(sortTodos(list, 'priority').map((t) => t.id)).toEqual(['high', 'low', 'none']);
    const due = [todo({ id: 'none' }), todo({ id: 'late', due: '2026-09-30' }), todo({ id: 'soon', due: '2026-09-22' })];
    expect(sortTodos(due, 'due').map((t) => t.id)).toEqual(['soon', 'late', 'none']);
  });

  it('sortTodos：手动排序用 order 权重，没权重的按创建时间倒序', () => {
    const list = [todo({ id: 'a', createdAt: 1 }), todo({ id: 'b', createdAt: 2 }), todo({ id: 'c', createdAt: 3 })];
    expect(sortTodos(list, 'manual').map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect(sortTodos([todo({ id: 'a', order: 2 }), todo({ id: 'b', order: 1 })], 'manual').map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('todoStats 统计未完成/逾期/今天/子任务与进度', () => {
    const list = [
      todo({ id: 'a', due: '2026-09-19' }),
      todo({ id: 'b', due: today, subtasks: [{ id: 's1', text: 'x', done: true }, { id: 's2', text: 'y', done: false }] }),
      todo({ id: 'c', done: true }),
    ];
    const s = todoStats(list, today);
    expect(s).toMatchObject({ total: 3, done: 1, active: 2, overdue: 1, today: 1, subDone: 1, subTotal: 2 });
    expect(s.progress).toBeCloseTo(1 / 3);
    expect(todoStats([], today).progress).toBe(0);
  });

  it('subtaskProgress 无子任务时为 0/0', () => {
    expect(subtaskProgress(todo())).toEqual({ done: 0, total: 0 });
  });

  it('matchesQuery 命中正文、子任务、关联笔记', () => {
    const t = todo({ text: '复习呼吸', note: '内科学/循环.md', subtasks: [{ id: 's', text: '画氧解离曲线', done: false }] });
    expect(matchesQuery(t, '')).toBe(true);
    expect(matchesQuery(t, '呼吸')).toBe(true);
    expect(matchesQuery(t, '循环')).toBe(true);
    expect(matchesQuery(t, '解离')).toBe(true);
    expect(matchesQuery(t, '不存在')).toBe(false);
  });
});

describe('M8 变更函数', () => {
  it('toggleAll 全部完成 / 全部取消，并维护 completedAt', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b', done: true, completedAt: 5 })];
    const all = toggleAll(list, true, 9);
    expect(all.every((t) => t.done)).toBe(true);
    // 已经完成的条目不重写完成时间：别篡改历史
    expect(all.find((t) => t.id === 'b')?.completedAt).toBe(5);
    expect(all.find((t) => t.id === 'a')?.completedAt).toBe(9);
    const none = toggleAll(all, false, 10);
    expect(none.every((t) => !t.done && t.completedAt === undefined)).toBe(true);
  });

  it('editTodo 保存文本；清空即删除（TodoMVC 语义）', () => {
    expect(editTodo([todo()], 'a', '  新文本  ')[0].text).toBe('新文本');
    expect(editTodo([todo()], 'a', '   ')).toEqual([]);
  });

  it('moveTodo 按显示顺序重排并写入 order 权重', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b' }), todo({ id: 'c' })];
    const moved = moveTodo(list, ['a', 'b', 'c'], 2, 0);
    expect(sortTodos(moved, 'manual').map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('moveTodo 越界或原地不动时原样返回', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b' })];
    expect(moveTodo(list, ['a', 'b'], 0, 0)).toBe(list);
    expect(moveTodo(list, ['a', 'b'], 0, 9)).toBe(list);
    expect(moveTodo(list, ['a', 'b'], -1, 1)).toBe(list);
  });

  it('updateTodo / removeTodo / clearCompleted', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b', done: true })];
    expect(updateTodo(list, 'a', { priority: 1, due: '2026-09-25' })[0]).toMatchObject({ priority: 1, due: '2026-09-25' });
    expect(removeTodo(list, 'a').map((t) => t.id)).toEqual(['b']);
    expect(clearCompleted(list).map((t) => t.id)).toEqual(['a']);
  });

  it('子任务：增 / 勾 / 删，且只动目标待办', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b' })];
    const added = addSubtask(list, 'a', '  第一步  ', 100);
    expect(added[0].subtasks).toHaveLength(1);
    expect(added[0].subtasks![0].text).toBe('第一步');
    expect(added[1].subtasks).toBeUndefined();

    const subId = added[0].subtasks![0].id;
    expect(toggleSubtask(added, 'a', subId)[0].subtasks![0].done).toBe(true);
    expect(removeSubtask(added, 'a', subId)[0].subtasks).toEqual([]);
  });

  it('addSubtask 空文本不新增', () => {
    expect(addSubtask([todo()], 'a', '   ')[0].subtasks).toBeUndefined();
  });
});

describe('M8 重复任务 completeTodo', () => {
  const today = '2026-09-21';

  it('普通待办勾完成 / 取消完成', () => {
    const list = [todo({ id: 'a' })];
    const { list: done, spawned } = completeTodo(list, 'a', today, 5);
    expect(done[0]).toMatchObject({ done: true, completedAt: 5 });
    expect(spawned).toBeUndefined();
    expect(completeTodo(done, 'a', today, 6).list[0].done).toBe(false);
  });

  it('每天重复：完成时顺延生成下一条（新 id、未完成、子任务重置）', () => {
    const list = [todo({ id: 'a', repeat: 'daily', due: today, subtasks: [{ id: 's', text: 'x', done: true }] })];
    const { list: next, spawned } = completeTodo(list, 'a', today, 5);
    expect(spawned).toMatchObject({ done: false, due: '2026-09-22', repeat: 'daily' });
    expect(spawned!.id).not.toBe('a');
    expect(spawned!.subtasks![0].done).toBe(false);
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe(spawned!.id); // 新的一条排在最前
  });

  it('每周重复顺延 7 天；未来到期的按原到期日顺延', () => {
    expect(completeTodo([todo({ id: 'a', repeat: 'weekly', due: today })], 'a', today, 1).spawned!.due).toBe('2026-09-28');
    expect(completeTodo([todo({ id: 'a', repeat: 'daily', due: '2026-09-30' })], 'a', today, 1).spawned!.due).toBe('2026-10-01');
  });

  it('未找到该 id 时原样返回', () => {
    const list = [todo({ id: 'a' })];
    expect(completeTodo(list, 'zzz', today).list).toBe(list);
  });
});

describe('M8 存储清洗与备份', () => {
  it('loadTodos 丢掉形状不对的字段（坏备份灌不进界面）', () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      // 'yearly' 不在合法重复规则里（M9 起合法值是 daily/weekdays/weekly/biweekly/monthly）
      { id: 'a', text: 'ok', done: false, createdAt: 1, due: '9/25', priority: 9, repeat: 'yearly', order: 'x', subtasks: [{ text: '无 id' }] },
      // 撞原型链的键也必须丢掉：直接 `REPEAT_LABELS[key]` 取值会拿到函数，灌进界面就是灾难
      { id: 'b', text: 'ok2', done: false, createdAt: 2, repeat: 'toString' },
    ]));
    expect(loadTodos()).toEqual([
      { id: 'a', text: 'ok', done: false, createdAt: 1 },
      { id: 'b', text: 'ok2', done: false, createdAt: 2 },
    ]);
  });

  it('loadTodos 保留 M9 的备注与新重复规则', () => {
    saveTodos([todo({ id: 'a', memo: '重点看氧解离曲线', repeat: 'monthly' })]);
    expect(loadTodos()[0]).toMatchObject({ memo: '重点看氧解离曲线', repeat: 'monthly' });
  });

  it('loadTodos 保留合法的新字段', () => {
    const t = todo({ id: 'a', due: '2026-09-25', priority: 1, note: 'x.md', repeat: 'weekly', order: 2, subtasks: [{ id: 's', text: '子', done: true }] });
    saveTodos([t]);
    expect(loadTodos()[0]).toEqual(t);
  });

  it('importTodos 带着新字段一起并入', () => {
    const n = importTodos([todo({ id: 'a', due: '2026-09-25', priority: 2, note: 'n.md', repeat: 'daily', subtasks: [{ id: 's', text: '子', done: false }] })]);
    expect(n).toBe(1);
    expect(loadTodos()[0]).toMatchObject({ due: '2026-09-25', priority: 2, note: 'n.md', repeat: 'daily' });
  });

  it('makeTodo 由短语法结果生成，空字段不写入', () => {
    const t = makeTodo({ text: '看书' }, 7);
    expect(t).toEqual({ id: expect.any(String), text: '看书', done: false, createdAt: 7 });
    const full = makeTodo({ text: '看书', due: '2026-09-25', priority: 1, note: 'n.md', repeat: 'weekly' }, 7);
    expect(full).toMatchObject({ due: '2026-09-25', priority: 1, note: 'n.md', repeat: 'weekly' });
  });
});

// ============================================================ M9

const TODAY = '2026-09-21';

describe('M9 重复规则 nextDue', () => {
  it('每天 / 每周 / 每两周', () => {
    expect(nextDue(TODAY, 'daily')).toBe('2026-09-22');
    expect(nextDue(TODAY, 'weekly')).toBe('2026-09-28');
    expect(nextDue(TODAY, 'biweekly')).toBe('2026-10-05');
  });

  it('工作日：周五跳到下周一，周六跳到周一，周一到周二', () => {
    expect(nextDue('2026-09-25', 'weekdays')).toBe('2026-09-28'); // 周五 → 周一
    expect(nextDue('2026-09-26', 'weekdays')).toBe('2026-09-28'); // 周六 → 周一
    expect(nextDue('2026-09-21', 'weekdays')).toBe('2026-09-22'); // 周一 → 周二
  });

  it('每月同一天；短月夹到月末，不会溢出到下下月', () => {
    expect(nextDue(TODAY, 'monthly')).toBe('2026-10-21');
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDue('2026-08-31', 'monthly')).toBe('2026-09-30');
  });

  it('短语法认 *工作日 / *每两周 / *每月', () => {
    expect(parseQuickAdd('背单词 *工作日', TODAY).repeat).toBe('weekdays');
    expect(parseQuickAdd('背单词 *每两周', TODAY).repeat).toBe('biweekly');
    expect(parseQuickAdd('背单词 *每月', TODAY).repeat).toBe('monthly');
  });

  it('completeTodo 走新规则顺延（每月）', () => {
    const r = completeTodo([todo({ id: 'a', repeat: 'monthly', due: '2026-09-30' })], 'a', TODAY, 1);
    expect(r.spawned!.due).toBe('2026-10-30');
  });
});

describe('M9 智能列表 / 趋势 / 分组', () => {
  const list: Todo[] = [
    todo({ id: 'a', due: '2026-09-19' }),                                    // 逾期
    todo({ id: 'b', due: TODAY }),                                            // 今天
    todo({ id: 'c', due: '2026-09-22' }),                                     // 明天
    todo({ id: 'd', due: '2026-09-30' }),                                     // 更远
    todo({ id: 'e' }),                                                        // 未排期
    todo({ id: 'f', done: true, due: TODAY, completedAt: Date.parse('2026-09-21T10:00:00') }),
  ];

  it('inSmartList 口径：今天含逾期，明天之前含今天，本周内不含没排期的', () => {
    expect(inSmartList(list[0], 'today', TODAY)).toBe(true); // 逾期也算今天该做
    expect(inSmartList(list[3], 'today', TODAY)).toBe(false);
    expect(inSmartList(list[2], 'tomorrow', TODAY)).toBe(true);
    expect(inSmartList(list[3], 'week', TODAY)).toBe(false); // 9-30 超出 7 天
    expect(inSmartList(list[4], 'week', TODAY)).toBe(false); // 没排期不算「本周内」
    expect(inSmartList(list[5], 'done', TODAY)).toBe(true);
    expect(inSmartList(list[5], 'active', TODAY)).toBe(false);
    expect(inSmartList(list[4], 'all', TODAY)).toBe(true);
  });

  it('smartCounts 与左栏计数同一口径', () => {
    const c = smartCounts(list, TODAY);
    expect(c).toMatchObject({ overdue: 1, today: 2, tomorrow: 3, week: 3, active: 5, done: 1, all: 6 });
  });

  it('todoTrend 近 7 天按完成日期归档', () => {
    const t = todoTrend(list, TODAY, 7);
    expect(t).toHaveLength(7);
    expect(t[6]).toEqual({ day: '2026-09-21', done: 1 });
    expect(t[5]).toEqual({ day: '2026-09-20', done: 0 });
  });

  it('todoStreak：今天还没完成不算断，从昨天往前数', () => {
    const done = (day: string) => todo({ id: day, done: true, completedAt: Date.parse(`${day}T09:00:00`) });
    expect(todoStreak([done('2026-09-21'), done('2026-09-20'), done('2026-09-19')], TODAY)).toBe(3);
    expect(todoStreak([done('2026-09-20'), done('2026-09-19')], TODAY)).toBe(2); // 今天还没做
    expect(todoStreak([done('2026-09-19')], TODAY)).toBe(0);                     // 断了
    expect(todoStreak([], TODAY)).toBe(0);
  });

  it('groupByNote：按关联笔记分组，未关联的单独一组，多的在前', () => {
    const g = groupByNote(
      [todo({ id: 'a', note: 'n.md' }), todo({ id: 'b', note: 'n.md' }), todo({ id: 'c' })],
      [{ name: '内科学', path: 'n.md' }]
    );
    expect(g.map((x) => [x.label, x.items.length])).toEqual([['内科学', 2], ['未关联笔记', 1]]);
  });
});

describe('M9 批量操作 / 顺延', () => {
  it('批量完成：重复任务照样顺延出下一条', () => {
    const base = [todo({ id: 'a' }), todo({ id: 'b', repeat: 'daily', due: TODAY }), todo({ id: 'c' })];
    const r = bulkComplete(base, ['a', 'b'], true, TODAY, 5);
    expect(r.list.filter((t) => t.done).map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0].due).toBe('2026-09-22');
    // 批量取消完成
    const back = bulkComplete(r.list, ['a', 'b'], false, TODAY, 6);
    expect(back.list.filter((t) => t.done)).toHaveLength(0);
  });

  it('批量改字段只动选中项', () => {
    const base = [todo({ id: 'a' }), todo({ id: 'b' }), todo({ id: 'c' })];
    expect(bulkUpdate(base, ['a', 'c'], { due: TODAY }).map((t) => t.due)).toEqual([TODAY, undefined, TODAY]);
    expect(bulkUpdate(base, ['a'], { priority: 1 })[0].priority).toBe(1);
    expect(bulkRemove(base, ['b']).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('rollover 只把逾期的未完成项挪到今天', () => {
    const base = [
      todo({ id: 'a', due: '2026-09-19' }),
      todo({ id: 'b', due: '2026-09-22' }),
      todo({ id: 'c', due: '2026-09-19', done: true }),
      todo({ id: 'd' }),
    ];
    const r = rollover(base, TODAY);
    expect(r.moved).toBe(1);
    expect(r.list.map((t) => t.due)).toEqual([TODAY, '2026-09-22', '2026-09-19', undefined]);
  });

  it('排序多了创建时间与标题', () => {
    const base = [todo({ id: 'a', text: '乙', createdAt: 2 }), todo({ id: 'b', text: '甲', createdAt: 1 })];
    expect(sortTodos(base, 'created').map((t) => t.id)).toEqual(['a', 'b']);
    expect(sortTodos(base, 'title').map((t) => t.text)).toEqual(['甲', '乙']);
  });

  it('搜索也认备注', () => {
    expect(matchesQuery(todo({ id: 'a', memo: '重点看氧解离曲线' }), '氧解离')).toBe(true);
    expect(matchesQuery(todo({ id: 'a', memo: '重点看氧解离曲线' }), '心电图')).toBe(false);
  });
});
