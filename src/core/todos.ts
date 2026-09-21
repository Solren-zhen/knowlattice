/**
 * 待办清单（Todo）：本地优先，持久化到 localStorage，与 SRS / 题库 / 打卡同策略。
 *
 * 单独成模块的原因：待办原先只有 TodoView 自己知道 key 和数据形状，
 * Dashboard 又抄了一份 JSON.parse，整包备份则完全不知道它存在——
 * 结果就是「一键备份」备份不到待办。读写收在这里，视图、备份、演示数据共用一套。
 */
export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
}

const KEY = 'knowlattice-todos';

export function loadTodos(): Todo[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function saveTodos(list: Todo[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** 导出待办为纯数据（供整包备份） */
export function exportTodos(): Todo[] {
  return loadTodos();
}

/** 新待办 id（视图与演示数据共用同一形状） */
export function newTodoId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 从备份导入待办。合并模式：按 id 去重，备份里的条目覆盖同 id 的本地条目，
 * 其余本地条目保留（与笔记、题库、错题的「合并导入」语义一致）。
 * 返回本次并入的条数。
 */
export function importTodos(state: unknown): number {
  if (!Array.isArray(state)) return 0;
  const incoming: Todo[] = [];
  for (const raw of state) {
    const t = raw as Partial<Todo> | null;
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.text !== 'string') continue;
    incoming.push({
      id: t.id,
      text: t.text,
      done: t.done === true,
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      ...(typeof t.completedAt === 'number' ? { completedAt: t.completedAt } : {}),
    });
  }
  if (incoming.length === 0) return 0;
  const byId = new Map(loadTodos().map((t) => [t.id, t]));
  for (const t of incoming) byId.set(t.id, t);
  saveTodos([...byId.values()]);
  return incoming.length;
}
