import { beforeEach, describe, expect, it } from 'vitest';
import { exportTodos, importTodos, loadTodos, newTodoId, saveTodos, type Todo } from '../todos';

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
