/**
 * 待办清单（Todo）：本地优先，持久化到 localStorage，与 SRS / 题库 / 打卡同策略。
 *
 * 单独成模块的原因：待办原先只有 TodoView 自己知道 key 和数据形状，
 * Dashboard 又抄了一份 JSON.parse，整包备份则完全不知道它存在——
 * 结果就是「一键备份」备份不到待办。读写收在这里，视图、备份、演示数据共用一套。
 *
 * M8 · 做成熟：在「增/勾/删」之上补了到期日、优先级、关联笔记、子任务、重复、
 * 短语法快捷输入与分组排序。判断依据不是拍脑袋，是两份公开参照：
 *   - TodoMVC app-spec（github.com/tastejs/todomvc）：行内编辑双击进入、blur/Enter 保存、
 *     Esc 丢弃、清空即删除、全选完成、过滤状态要能跨刷新保留；
 *   - Super Productivity（github.com/johannesjo/super-productivity）：子任务、
 *     优先级、「短语法」快速输入、键盘优先。
 * 这里只做纯函数（解析/分组/排序/统计/完成态迁移），视图只管画——所以能一条条单测。
 */
export type TodoPriority = 1 | 2 | 3; // 1 高 / 2 中 / 3 低
export type TodoRepeat = 'daily' | 'weekly';

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  /** 到期日 `YYYY-MM-DD`（本地时区按天比较，不用 UTC 时间戳） */
  due?: string;
  /** 1 高 / 2 中 / 3 低；不设 = 无优先级 */
  priority?: TodoPriority;
  /** 关联笔记路径：点一下跳到那篇笔记 */
  note?: string;
  /** 重复：勾完成时自动生成下一条 */
  repeat?: TodoRepeat;
  /** 子任务清单 */
  subtasks?: Subtask[];
  /** 手动排序权重（拖拽重排时写入） */
  order?: number;
}

const KEY = 'knowlattice-todos';

// ---------- 日期 ----------

/** 本地时区的 `YYYY-MM-DD`。不要用 toISOString()：那是 UTC，晚上八点后日期会差一天 */
export function dayKey(d: Date | number = Date.now()): string {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` 加 n 天（用本地构造避免夏令时/时区偏移） */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}

/** 两个日期键相差多少天（b - a） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86_400_000);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 到期日的显示文字（今天/明天/昨天/逾期 N 天/9月25日/明年…） */
export function dueLabel(due: string | undefined, today: string): string {
  if (!due) return '';
  const diff = daysBetween(today, due);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  if (diff < 0) return `逾期 ${-diff} 天`;
  const [y, m, d] = due.split('-').map(Number);
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return sameYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

// ---------- 短语法 ----------

export interface QuickAdd {
  text: string;
  due?: string;
  priority?: TodoPriority;
  note?: string;
  repeat?: TodoRepeat;
}

const PRIORITY_WORDS: Record<string, TodoPriority> = {
  高: 1, 高优: 1, 1: 1,
  中: 2, 中优: 2, 2: 2,
  低: 3, 低优: 3, 3: 3,
};

const REPEAT_WORDS: Record<string, TodoRepeat> = { 每天: 'daily', 每日: 'daily', 每周: 'weekly' };

/** 把一个 `@…` 词解析成日期键；解析不出来返回 null（当普通文字处理，不吞内容） */
function parseDueWord(w: string, today: string): string | null {
  if (w === '今天' || w === '今日') return today;
  if (w === '明天' || w === '明日') return addDays(today, 1);
  if (w === '后天') return addDays(today, 2);
  if (w === '昨天') return addDays(today, -1);
  if (w === '本周' || w === '这周') return today;
  if (w === '下周') return addDays(today, 7);
  const wd = WEEKDAYS.indexOf(w);
  if (wd >= 0) {
    // 下一个该星期几（今天就是那天则算今天）
    const [y, m, d] = today.split('-').map(Number);
    const cur = new Date(y, m - 1, d).getDay();
    return addDays(today, (wd - cur + 7) % 7);
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(w);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[.\-/月](\d{1,2})日?$/.exec(w);
  if (m) return `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^\+(\d+)d?$/.exec(w);
  if (m) return addDays(today, Number(m[1]));
  return null;
}

/**
 * 短语法：一条输入同时定好文字、到期、优先级、关联笔记、重复。
 *
 *   `复习呼吸系统 @明天 !高 #呼吸系统 *每天`
 *
 * - `@今天 @明天 @后天 @昨天 @周一…@周日 @本周 @下周 @9-25 @2026-09-25 @+3`
 * - `!高 !中 !低`（也接受 `!1 !2 !3`）
 * - `#笔记名`：在传入的笔记名里精确匹配（短语法里 `#` 后不能有空格）；匹配不上就当普通文字
 * - `*每天 *每日 *每周`
 *
 * 认不出来的词一律留在正文里——宁可多几个字，也不能把用户写的内容吃掉。
 */
export function parseQuickAdd(input: string, today: string, notes: Array<{ name: string; path: string }> = []): QuickAdd {
  const out: QuickAdd = { text: '' };
  const rest: string[] = [];
  const byName = new Map(notes.map((n) => [n.name.trim().toLowerCase(), n.path]));
  for (const raw of input.split(/\s+/)) {
    const w = raw.trim();
    if (!w) continue;
    if (w.startsWith('@') && !out.due) {
      const d = parseDueWord(w.slice(1), today);
      if (d) {
        out.due = d;
        continue;
      }
    }
    if (w.startsWith('!') && !out.priority) {
      const p = PRIORITY_WORDS[w.slice(1)];
      if (p) {
        out.priority = p;
        continue;
      }
    }
    if (w.startsWith('*') && !out.repeat) {
      const r = REPEAT_WORDS[w.slice(1)];
      if (r) {
        out.repeat = r;
        continue;
      }
    }
    if (w.startsWith('#') && !out.note) {
      const hit = byName.get(w.slice(1).toLowerCase());
      if (hit) {
        out.note = hit;
        continue;
      }
    }
    rest.push(w);
  }
  out.text = rest.join(' ').trim();
  return out;
}

// ---------- 分组 / 排序 / 统计 ----------

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';

export function dueBucket(t: Todo, today: string): DueBucket {
  if (!t.due) return 'none';
  const diff = daysBetween(today, t.due);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return 'later';
}

export const BUCKET_LABELS: Record<DueBucket | 'done', string> = {
  overdue: '已逾期',
  today: '今天',
  tomorrow: '明天',
  later: '之后',
  none: '未排期',
  done: '已完成',
};

export type SortMode = 'manual' | 'due' | 'priority';

const PRIORITY_RANK = (t: Todo) => t.priority ?? 9; // 没设优先级的排最后

/** 排序：manual 用拖拽权重（缺省按创建时间倒序，新加的在上），due 按到期日，priority 按优先级 */
export function sortTodos(list: Todo[], mode: SortMode): Todo[] {
  const arr = [...list];
  if (mode === 'priority') {
    arr.sort((a, b) => PRIORITY_RANK(a) - PRIORITY_RANK(b) || b.createdAt - a.createdAt);
    return arr;
  }
  if (mode === 'due') {
    arr.sort((a, b) => {
      if (!a.due && !b.due) return b.createdAt - a.createdAt;
      if (!a.due) return 1; // 没排期的沉底
      if (!b.due) return -1;
      return a.due.localeCompare(b.due) || b.createdAt - a.createdAt;
    });
    return arr;
  }
  arr.sort((a, b) => {
    if (a.order !== undefined || b.order !== undefined) {
      return (a.order ?? 0) - (b.order ?? 0);
    }
    return b.createdAt - a.createdAt;
  });
  return arr;
}

/** 按到期分组（未完成的按 overdue→today→tomorrow→later→none；已完成的单独一组垫底） */
export function groupTodos(list: Todo[], today: string, mode: SortMode = 'manual'): Array<{ bucket: DueBucket | 'done'; items: Todo[] }> {
  const order: DueBucket[] = ['overdue', 'today', 'tomorrow', 'later', 'none'];
  const sorted = sortTodos(list, mode);
  const groups: Array<{ bucket: DueBucket | 'done'; items: Todo[] }> = order
    .map((bucket) => ({ bucket, items: sorted.filter((t) => !t.done && dueBucket(t, today) === bucket) }))
    .filter((g) => g.items.length > 0);
  const done = sorted.filter((t) => t.done);
  if (done.length) groups.push({ bucket: 'done', items: done });
  return groups;
}

export function subtaskProgress(t: Todo): { done: number; total: number } {
  const subs = t.subtasks ?? [];
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

export function todoStats(list: Todo[], today: string) {
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  const active = total - done;
  const overdue = list.filter((t) => !t.done && dueBucket(t, today) === 'overdue').length;
  const todayCount = list.filter((t) => !t.done && dueBucket(t, today) === 'today').length;
  const subDone = list.reduce((n, t) => n + subtaskProgress(t).done, 0);
  const subTotal = list.reduce((n, t) => n + subtaskProgress(t).total, 0);
  return {
    total,
    done,
    active,
    overdue,
    today: todayCount,
    progress: total ? done / total : 0,
    subDone,
    subTotal,
  };
}

/** 搜索：正文、子任务文字、关联笔记路径都算 */
export function matchesQuery(t: Todo, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (t.text.toLowerCase().includes(s)) return true;
  if (t.note?.toLowerCase().includes(s)) return true;
  return (t.subtasks ?? []).some((x) => x.text.toLowerCase().includes(s));
}

// ---------- 变更（纯函数，返回新列表）----------

export function toggleTodo(list: Todo[], id: string, now = Date.now()): Todo[] {
  return list.map((t) =>
    t.id === id ? { ...t, done: !t.done, completedAt: t.done ? undefined : now } : t
  );
}

/** 全部标为完成 / 全部标回未完成 */
export function toggleAll(list: Todo[], done: boolean, now = Date.now()): Todo[] {
  return list.map((t) => (t.done === done ? t : { ...t, done, completedAt: done ? now : undefined }));
}

export function editTodo(list: Todo[], id: string, text: string): Todo[] {
  const t = text.trim();
  if (!t) return list.filter((x) => x.id !== id); // 清空即删除（TodoMVC 语义）
  return list.map((x) => (x.id === id ? { ...x, text: t } : x));
}

export function updateTodo(list: Todo[], id: string, patch: Partial<Todo>): Todo[] {
  return list.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export function removeTodo(list: Todo[], id: string): Todo[] {
  return list.filter((t) => t.id !== id);
}

export function clearCompleted(list: Todo[]): Todo[] {
  return list.filter((t) => !t.done);
}

/** 拖拽重排：把 from 位置的条目插到 to 位置（按当前显示顺序），并整体写入 order 权重 */
export function moveTodo(list: Todo[], ids: string[], from: number, to: number): Todo[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return list;
  const order = [...ids];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const rank = new Map(order.map((id, i) => [id, i]));
  return list.map((t) => (rank.has(t.id) ? { ...t, order: rank.get(t.id)! } : t));
}

export function addSubtask(list: Todo[], id: string, text: string, now = Date.now()): Todo[] {
  const s = text.trim();
  if (!s) return list;
  return list.map((t) =>
    t.id === id ? { ...t, subtasks: [...(t.subtasks ?? []), { id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: s, done: false }] } : t
  );
}

export function toggleSubtask(list: Todo[], todoId: string, subId: string): Todo[] {
  return list.map((t) =>
    t.id === todoId
      ? { ...t, subtasks: (t.subtasks ?? []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) }
      : t
  );
}

export function removeSubtask(list: Todo[], todoId: string, subId: string): Todo[] {
  return list.map((t) => (t.id === todoId ? { ...t, subtasks: (t.subtasks ?? []).filter((s) => s.id !== subId) } : t));
}

/**
 * 勾完成；**重复任务**顺延生成下一条（新 id、子任务重置为未完成）。
 * 返回新列表与生成的那条（没有就是 undefined）。
 * 取消勾选不会回收已生成的下一条——那属于「改主意」，交给用户自己删，别替他做决定。
 */
export function completeTodo(list: Todo[], id: string, today: string, now = Date.now()): { list: Todo[]; spawned?: Todo } {
  const target = list.find((t) => t.id === id);
  if (!target) return { list };
  if (target.done) return { list: toggleTodo(list, id, now) }; // 取消完成
  const next = toggleTodo(list, id, now);
  if (!target.repeat) return { list: next };
  const base = target.due && daysBetween(today, target.due) > 0 ? target.due : today;
  const spawned: Todo = {
    ...target,
    id: newTodoId(),
    done: false,
    completedAt: undefined,
    createdAt: now,
    due: addDays(base, target.repeat === 'daily' ? 1 : 7),
    order: undefined,
    subtasks: target.subtasks?.map((s) => ({ ...s, done: false })),
  };
  return { list: [spawned, ...next], spawned };
}

// ---------- 存储 ----------

/** 单条清洗：形状不对的字段一律丢掉，坏备份不能把垃圾灌进界面 */
function sanitize(raw: unknown): Todo | null {
  const t = raw as Partial<Todo> | null;
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.text !== 'string') return null;
  const out: Todo = {
    id: t.id,
    text: t.text,
    done: t.done === true,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
  };
  if (typeof t.completedAt === 'number') out.completedAt = t.completedAt;
  if (typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due)) out.due = t.due;
  if (t.priority === 1 || t.priority === 2 || t.priority === 3) out.priority = t.priority;
  if (typeof t.note === 'string' && t.note) out.note = t.note;
  if (t.repeat === 'daily' || t.repeat === 'weekly') out.repeat = t.repeat;
  if (typeof t.order === 'number') out.order = t.order;
  if (Array.isArray(t.subtasks)) {
    const subs = t.subtasks
      .map((s) => s as Partial<Subtask> | null)
      .filter((s): s is Subtask => !!s && typeof s.id === 'string' && typeof s.text === 'string')
      .map((s) => ({ id: s.id, text: s.text, done: s.done === true }));
    if (subs.length) out.subtasks = subs;
  }
  return out;
}

export function loadTodos(): Todo[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(a)) return [];
    return a.map(sanitize).filter((t): t is Todo => t !== null);
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

/** 新建一条待办（短语法解析结果 + 默认值） */
export function makeTodo(q: QuickAdd, now = Date.now()): Todo {
  return {
    id: newTodoId(),
    text: q.text,
    done: false,
    createdAt: now,
    ...(q.due ? { due: q.due } : {}),
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.note ? { note: q.note } : {}),
    ...(q.repeat ? { repeat: q.repeat } : {}),
  };
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
    const t = sanitize(raw);
    if (t) incoming.push(t);
  }
  if (incoming.length === 0) return 0;
  const byId = new Map(loadTodos().map((t) => [t.id, t]));
  for (const t of incoming) byId.set(t.id, t);
  saveTodos([...byId.values()]);
  return incoming.length;
}
