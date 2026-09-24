/**
 * 番茄工作台（整页）：把「专注 / 待办 / 统计」装进一个工作面，三者共用一份数据。
 *
 * 布局：顶部标签切模块 + 常驻计时条（切到哪一页都在走，一眼看得到还剩多久）
 *   专注  计时环 + 开始/暂停/重置/跳过 + 关联待办 + 今日累计 + 时长设置
 *   待办  左栏智能列表 / 中栏列表+批量 / 右栏详情+统计（详见下面）
 *   统计  番茄总览 + 近 7 天趋势 + 待办完成率 + 学习打卡热力图
 *
 * 工作台形态参照 github.com/GarryLiang/pomodoro-workbench：番茄钟与待办联动——
 * 专注前选一条待办，每完成一个番茄它 +1。落地时按本仓库的数据模型做了两处取舍：
 *   - 不另做一套手动「习惯打卡」：复习评卡 / 题库作答已经在记打卡（core/stats），
 *     热力图直接画那份真实学习记录，避免两套「连续天数」互相打架；
 *   - 计时按真实时间戳算（core/pomodoro）：关掉面板也在走，重开按时间接上，不漂移。
 *
 * 待办模块的参照方案（不是拍脑袋想的）：
 *   - TodoMVC app-spec：行内编辑三出口（blur/Enter 保存、Esc 丢弃、清空即删）、全选完成、清空已完成、过滤持久化；
 *   - Super Productivity：一句话短语法（`复习呼吸 @明天 !高 #呼吸系统 *每天`）；
 *   - Obsidian Tasks：笔记里的 `- [ ]` 任务也能看见、勾选直接写回源文件（`[ ]` ⇄ `[x]`，完成补 `✅ 日期`）。
 *
 * 纯逻辑在 core/todos.ts / core/noteTasks.ts / core/pomodoro.ts（都可单测），这里只管画和事件。
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useEsc, isEditable } from './useEsc';
import { IconTrash, IconTodo, IconClose, IconTimer, IconPlay, IconPause, IconChart } from './icons';
import { toast, confirmBox } from '../core/feedback';
import { parseFrontmatterCached } from '../core/parser';
import { collectNoteTasks, setNoteTaskDone, type NoteTask } from '../core/noteTasks';
import {
  addRecord, formatClock, loadConfig, loadRecords, loadState as loadPomoState, pause as pausePomo, PHASE_LABELS,
  pomoStats, pomoTrend, progressOf, remainingMs, reset as resetPomo, sanitizeConfig, saveConfig,
  saveState as savePomoState, skip as skipPomo, start as startPomo, tick,
  type PomodoroConfig, type PomodoroRecord, type PomodoroState,
} from '../core/pomodoro';
import { heatmap, streak as studyStreak, studyDays } from '../core/stats';
import TodoFocus from './TodoFocus';
import TodoStats from './TodoStats';
import DialogSurface from './DialogSurface';
import {
  addDays, addSubtask, BUCKET_LABELS, bulkComplete, bulkRemove, bulkUpdate, bumpPomo, clearCompleted, completeTodo,
  dayKey, editTodo, groupByNote, groupTodos, inSmartList, loadTodos, makeTodo, matchesQuery, moveTodo,
  parseQuickAdd, removeSubtask, removeTodo, REPEAT_LABELS, rollover, saveTodos, SMART_EMPTY, SMART_LABELS,
  SMART_ORDER, smartCounts, sortTodos, subtaskProgress, todoStats, todoStreak, todoTrend, toggleAll,
  toggleSubtask, updateTodo,
  type SmartList, type SortMode, type Todo, type TodoPriority, type TodoRepeat,
} from '../core/todos';

type View = SmartList | 'notes';

/** 工作台模块：专注（番茄钟）/ 待办（本来的面板）/ 统计 */
type Module = 'focus' | 'board' | 'stats';

const MODULE_KEY = 'knowlattice-todo-module';
const MODULES: Array<{ key: Module; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { key: 'focus', label: '专注', Icon: IconTimer },
  { key: 'board', label: '待办', Icon: IconTodo },
  { key: 'stats', label: '统计', Icon: IconChart },
];

const VIEW_KEY = 'knowlattice-todo-filter';
const SORT_KEY = 'knowlattice-todo-sort';
const GROUP_KEY = 'knowlattice-todo-group';

const VIEWS: View[] = [...SMART_ORDER, 'notes'];

const SORTS: Array<{ key: SortMode; label: string }> = [
  { key: 'manual', label: '手动' },
  { key: 'due', label: '到期' },
  { key: 'priority', label: '优先级' },
  { key: 'created', label: '创建时间' },
  { key: 'title', label: '标题' },
];

const PRIORITY_LABEL: Record<TodoPriority, string> = { 1: '高', 2: '中', 3: '低' };
const PRIORITY_ORDER: TodoPriority[] = [1, 2, 3];

/** 面板底部的短语法说明：符号 → 含义 → 能点的示例（点了直接插进输入框） */
const SYNTAX: Array<{ sign: string; desc: string; examples: string[] }> = [
  { sign: '@', desc: '日期', examples: ['@今天', '@明天', '@周一', '@9-25', '@2026-09-25', '@+3'] },
  { sign: '!', desc: '优先级', examples: ['!高', '!中', '!低'] },
  { sign: '#', desc: '关联笔记', examples: ['#呼吸系统'] },
  { sign: '*', desc: '重复', examples: ['*每天', '*工作日', '*每周', '*每两周', '*每月'] },
];

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下写不进去也不该崩 */
  }
}

/** 短语法预览里那颗日期 chip 的写法（和用户敲的 `@明天` 对齐，别显示成一串日期） */
function dueChip(due: string, today: string): string {
  if (due === today) return '@今天';
  if (due === addDays(today, 1)) return '@明天';
  if (due === addDays(today, 2)) return '@后天';
  return `@${due}`;
}

export default function TodoView({ onClose, docs, onOpenPath, onSaveNote }: {
  onClose: () => void;
  docs: Map<string, string>;
  onOpenPath: (path: string) => void;
  onSaveNote: (path: string, content: string) => void | Promise<void>;
}) {
  const [list, setList] = useState<Todo[]>(loadTodos);
  const [text, setText] = useState('');
  const [view, setView] = useState<View>(() => readPref(VIEW_KEY, VIEWS, 'all'));
  const [sort, setSort] = useState<SortMode>(() => readPref(SORT_KEY, SORTS.map((s) => s.key), 'manual'));
  const [groupBy, setGroupBy] = useState<'due' | 'note'>(() => readPref(GROUP_KEY, ['due', 'note'], 'due'));
  const [query, setQuery] = useState('');
  const [noteFilter, setNoteFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [subText, setSubText] = useState('');
  /** 删除后的撤销快照：存整份旧列表，撤销就是原样放回去（比记「删了哪几条」更不容易错） */
  const [undo, setUndo] = useState<Todo[] | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLInputElement>(null);

  const today = useMemo(() => dayKey(), []);

  /** 笔记名表：短语法 `#名字`、关联笔记下拉、分组标题都用它 */
  const notes = useMemo(() => {
    const out: Array<{ name: string; path: string }> = [];
    for (const [path, content] of docs) {
      if (!path.endsWith('.md')) continue;
      const title = parseFrontmatterCached(path, content).title;
      const base = path.replace(/\.md$/, '').split('/').pop() ?? path;
      out.push({ name: (title || base).trim(), path });
      if (base.trim() !== (title || base).trim()) out.push({ name: base.trim(), path });
    }
    return out;
  }, [docs]);

  /** 笔记里的任务（`- [ ] …`）：docs 变了就重扫，勾选写回后 docs 会换新引用，列表自动跟上 */
  const noteTasks = useMemo(
    () => collectNoteTasks(docs, today, (path, content) => parseFrontmatterCached(path, content).title || path.replace(/\.md$/, '').split('/').pop() || path),
    [docs, today]
  );

  const parsed = useMemo(() => parseQuickAdd(text, today, notes), [text, today, notes]);
  const stats = todoStats(list, today);
  const counts = useMemo(() => smartCounts(list, today), [list, today]);
  const trend = useMemo(() => todoTrend(list, today, 7), [list, today]);
  const streak = useMemo(() => todoStreak(list, today), [list, today]);

  const openNoteTasks = noteTasks.filter((t) => !t.done);
  const noteGroups = useMemo(() => groupByNote(list.filter((t) => !t.done), notes), [list, notes]);

  // Esc 分层：编辑中先丢弃编辑 → 多选 → 选中 → 笔记筛选 → 才关面板（输入框里先退出输入框）
  useEsc((e) => {
    if (isEditable(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    if (editingId) {
      setEditingId(null);
      return;
    }
    if (picked.length) {
      setPicked([]);
      return;
    }
    if (selId) {
      setSelId(null);
      return;
    }
    if (noteFilter !== null) {
      setNoteFilter(null);
      return;
    }
    onClose();
  });

  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  // 撤销条 8 秒后自己消失
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const commit = (next: Todo[], opts: { undoable?: boolean } = {}) => {
    if (opts.undoable) setUndo(list);
    setList(next);
    saveTodos(next);
  };

  const add = () => {
    if (!parsed.text) return;
    commit([makeTodo(parsed), ...list]);
    setText('');
    composerRef.current?.focus();
  };

  /** 点一下底部的短语法示例就插进输入框（末尾补空格），省得手打 */
  const insertToken = (tok: string) => {
    setText((t) => (t.trim() === '' ? `${tok} ` : `${t.trimEnd()} ${tok} `));
    composerRef.current?.focus();
  };

  // ---------- 番茄钟（工作台常驻：切模块不停，关掉面板也在走）----------
  const [module, setModule] = useState<Module>(() => readPref(MODULE_KEY, MODULES.map((m) => m.key), 'board'));
  const [cfg, setCfg] = useState<PomodoroConfig>(loadConfig);
  const [timer, setTimer] = useState<PomodoroState>(loadPomoState);
  const [records, setRecords] = useState<PomodoroRecord[]>(loadRecords);
  const [now, setNow] = useState(() => Date.now());

  // 定时器回调要读最新值：用 ref 同步，避免闭包读到旧的 list/timer/cfg。
  // 同步放在 effect 里（每次渲染后跑一次），不在渲染期间写 ref——渲染期间写 ref 在并发渲染下不安全。
  const timerRef = useRef(timer);
  const cfgRef = useRef(cfg);
  const recordsRef = useRef(records);
  const listRef = useRef(list);
  const commitRef = useRef(commit);
  useEffect(() => {
    timerRef.current = timer;
    cfgRef.current = cfg;
    recordsRef.current = records;
    listRef.current = list;
    commitRef.current = commit;
  });

  const applyTimer = (next: PomodoroState) => {
    timerRef.current = next;
    setTimer(next);
    savePomoState(next);
  };

  const toggleTimer = () => {
    const t = Date.now();
    applyTimer(timerRef.current.running ? pausePomo(timerRef.current, t) : startPomo(timerRef.current, t));
    setNow(t);
  };
  const resetTimer = () => applyTimer(resetPomo(timerRef.current));
  const skipTimer = () => {
    applyTimer(skipPomo(timerRef.current, cfgRef.current, Date.now()));
    setNow(Date.now());
  };
  const pickTask = (id: string | null) => applyTimer({ ...timerRef.current, taskId: id });
  const changeConfig = (patch: Partial<PomodoroConfig>) => {
    const next = sanitizeConfig({ ...cfgRef.current, ...patch });
    cfgRef.current = next;
    setCfg(next);
    saveConfig(next);
  };

  useEffect(() => {
    if (!timer.running) return;
    const step = () => {
      const t = Date.now();
      setNow(t);
      const r = tick(timerRef.current, cfgRef.current, t);
      if (!r.finished) return;
      applyTimer(r.state);
      if (r.record) {
        const next = addRecord(recordsRef.current, r.record);
        recordsRef.current = next;
        setRecords(next);
        if (r.record.taskId) {
          const bumped = bumpPomo(listRef.current, r.record.taskId);
          if (bumped !== listRef.current) commitRef.current(bumped);
        }
        toast(`完成 1 个番茄（${r.record.minutes} 分钟）· ${PHASE_LABELS[r.state.phase]}开始`, 'ok', 3200);
      } else {
        toast(`${PHASE_LABELS[r.state.phase]}开始`, 'info', 2200);
      }
    };
    const id = window.setInterval(step, 500);
    // 立刻对一次表：面板关着的时候到点了，重开就补上。
    // 用 0ms 定时器而不是直接调用 step()——effect 里同步 setState 会触发级联渲染（lint 规则也是这么判的）。
    const kick = window.setTimeout(step, 0);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(kick);
    };
  }, [timer.running]);

  const pomo = useMemo(() => pomoStats(records, today), [records, today]);
  const pomoTrendData = useMemo(() => pomoTrend(records, today, 7), [records, today]);
  const heat = useMemo(() => heatmap(today, 12), [today]);
  // 打卡在别的页面写入（复习评卡 / 题库作答），所以切到统计页时重新读一次
  const [study, setStudy] = useState(() => ({ streak: studyStreak(), days: studyDays().length }));
  const remaining = remainingMs(timer, cfg, now);
  const progress = progressOf(timer, cfg, now);

  const shown = useMemo(() => {
    if (view === 'notes') return [];
    const q = list.filter((t) => matchesQuery(t, query));
    const byView = q.filter((t) => inSmartList(t, view, today));
    return noteFilter === null ? byView : byView.filter((t) => (t.note ?? '') === noteFilter);
  }, [list, query, view, noteFilter, today]);

  const shownNoteTasks = useMemo(() => {
    const q = noteTasks.filter((t) => !query.trim() || t.text.toLowerCase().includes(query.trim().toLowerCase()));
    const byNote = noteFilter === null ? q : q.filter((t) => t.path === noteFilter);
    // 未勾选的排前面；勾过的留在下面（点错了还能取消），同档按到期日
    return [...byNote].sort(
      (a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99')
    );
  }, [noteTasks, query, noteFilter]);

  const sections = useMemo(() => {
    if (groupBy === 'note') {
      return groupByNote(sortTodos(shown, sort), notes).map((g) => ({
        key: `note:${g.key}`,
        label: g.label,
        items: g.items,
      }));
    }
    return groupTodos(shown, today, sort).map((g) => ({
      key: `due:${g.bucket}`,
      label: BUCKET_LABELS[g.bucket],
      items: g.items,
    }));
  }, [shown, groupBy, notes, sort, today]);

  const flatIds = useMemo(() => sections.flatMap((g) => g.items.map((t) => t.id)), [sections]);

  const toggle = (id: string) => {
    const { list: next, spawned } = completeTodo(list, id, today);
    commit(next);
    if (spawned) toast(`重复任务：已顺延到下一条（${spawned.due ?? ''}）`, 'ok');
  };

  const removeOne = (id: string) => {
    commit(removeTodo(list, id), { undoable: true });
    setPicked((p) => p.filter((x) => x !== id));
    if (selId === id) setSelId(null);
  };

  const startEdit = (t: Todo) => {
    setEditingId(t.id);
    setEditText(t.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const before = list.some((t) => t.id === editingId);
    const emptied = !editText.trim();
    commit(editTodo(list, editingId, editText));
    setEditingId(null);
    if (before && emptied) toast('内容清空，该待办已删除。', 'info');
  };

  const cyclePriority = (t: Todo) => {
    const next: TodoPriority | undefined =
      t.priority === undefined ? 1 : t.priority === 1 ? 2 : t.priority === 2 ? 3 : undefined;
    commit(updateTodo(list, t.id, { priority: next }));
  };

  // ---------- 批量 ----------

  const pickedSet = useMemo(() => new Set(picked), [picked]);

  const onRowClick = (t: Todo, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setPicked((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]));
      setSelId(t.id);
      return;
    }
    if (e.shiftKey && selId) {
      const from = flatIds.indexOf(selId);
      const to = flatIds.indexOf(t.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from <= to ? [from, to] : [to, from];
        setPicked((p) => [...new Set([...p, ...flatIds.slice(a, b + 1)])]);
      }
      return;
    }
    setSelId(t.id);
  };

  const batchComplete = (done: boolean) => {
    const r = bulkComplete(list, picked, done, today);
    commit(r.list);
    if (r.spawned.length) toast(`重复任务：已顺延 ${r.spawned.length} 条`, 'ok');
    setPicked([]);
  };

  const batchDue = (kind: 'today' | 'tomorrow' | 'clear') => {
    const patch = kind === 'clear' ? { due: undefined } : { due: kind === 'today' ? today : addDays(today, 1) };
    commit(bulkUpdate(list, picked, patch));
    setPicked([]);
  };

  const batchRemove = async () => {
    const ok = await confirmBox({ title: `删除选中的 ${picked.length} 条待办？`, danger: true, okText: '删除' });
    if (!ok) return;
    commit(bulkRemove(list, picked), { undoable: true });
    setPicked([]);
    setSelId(null);
  };

  const clearDone = async () => {
    const n = list.filter((t) => t.done).length;
    if (!n) return;
    const ok = await confirmBox({ title: `清空 ${n} 条已完成的待办？`, danger: true, okText: '清空' });
    if (!ok) return;
    commit(clearCompleted(list), { undoable: true });
  };

  const doRollover = () => {
    const r = rollover(list, today);
    if (!r.moved) return;
    commit(r.list);
    toast(`已把 ${r.moved} 条逾期的顺延到今天`, 'ok');
  };

  const undoDelete = () => {
    if (!undo) return;
    setList(undo);
    saveTodos(undo);
    setUndo(null);
    toast('已恢复', 'ok');
  };

  // ---------- 笔记里的任务 ----------

  const toggleNoteTask = async (t: NoteTask, done: boolean) => {
    const content = docs.get(t.path);
    if (content === undefined) return;
    const next = setNoteTaskDone(content, t.line, done, today);
    if (next === null) {
      toast('这篇笔记已经变了，没有动它——打开笔记手动勾一下吧', 'err');
      return;
    }
    try {
      await onSaveNote(t.path, next);
    } catch (e) {
      toast(`写回失败：${(e as Error).message}`, 'err');
    }
  };

  // ---------- 键盘 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || editingId) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      // 专注页只吃自己的键：空格 开始/暂停、S 跳过。待办那套 x/Enter/Delete 在这一页没有意义，
      // 更不能让「空格」同时触发两件事。
      if (module === 'focus') {
        if (k === ' ') { e.preventDefault(); toggleTimer(); return; }
        if (k === 's' || k === 'S') { e.preventDefault(); skipTimer(); return; }
        return;
      }
      if (module !== 'board') return;
      const idx = selId ? flatIds.indexOf(selId) : -1;
      const move = (d: number) => {
        if (!flatIds.length) return;
        const next = idx < 0 ? (d > 0 ? 0 : flatIds.length - 1) : Math.min(flatIds.length - 1, Math.max(0, idx + d));
        setSelId(flatIds[next]);
      };
      if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); move(1); return; }
      if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); move(-1); return; }
      if (k === 'n') { e.preventDefault(); composerRef.current?.focus(); return; }
      if (k === '/') { e.preventDefault(); setView('all'); return; }
      if (!selId) return;
      const sel = list.find((t) => t.id === selId);
      if (!sel) return;
      if (k === 'x' || k === ' ') { e.preventDefault(); toggle(selId); return; }
      if (k === 'Enter') { e.preventDefault(); startEdit(sel); return; }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeOne(selId); return; }
      if (k === 'e') { e.preventDefault(); detailRef.current?.focus(); return; }
      if (k === '1' || k === '2' || k === '3') {
        e.preventDefault();
        commit(updateTodo(list, selId, { priority: Number(k) as TodoPriority }));
        return;
      }
      if (k === '0') { e.preventDefault(); commit(updateTodo(list, selId, { priority: undefined })); return; }
      if (k === 'm') {
        e.preventDefault();
        setPicked((p) => (p.includes(selId) ? p.filter((x) => x !== selId) : [...p, selId]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const detail = list.find((t) => t.id === selId) ?? null;
  const detailSub = detail ? subtaskProgress(detail) : null;
  const maxTrend = Math.max(1, ...trend.map((d) => d.done));

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <DialogSurface className="panel mistake-panel todo-panel" label="工作台" onClick={(e) => e.stopPropagation()}>
        <header className="panel__head">
          <span className="panel__title">
            <IconTimer /> 工作台
            <span className="muted">
              {' '}· {stats.active} 项未完成
              {stats.overdue ? ` · ${stats.overdue} 项逾期` : ''}
              {openNoteTasks.length ? ` · 笔记里 ${openNoteTasks.length} 项` : ''}
            </span>
          </span>
          <nav className="wb-tabs">
            {MODULES.map((m) => (
              <button
                key={m.key}
                className={`wb-tab${module === m.key ? ' active' : ''}`}
                aria-current={module === m.key ? 'page' : undefined}
                onClick={() => {
                  setModule(m.key);
                  writePref(MODULE_KEY, m.key);
                  if (m.key === 'stats') setStudy({ streak: studyStreak(), days: studyDays().length });
                }}
              >
                <m.Icon size={14} /> {m.label}
              </button>
            ))}
          </nav>
          <div className="panel__actions">
            <button
              className={`wb-chip${timer.running ? ' running' : ''}`}
              onClick={toggleTimer}
              aria-label={`${PHASE_LABELS[timer.phase]} ${formatClock(remaining)}，点击${timer.running ? '暂停' : '开始'}`}
              title="开始 / 暂停"
            >
              <span className="wb-chip__phase">{PHASE_LABELS[timer.phase]}</span>
              <span className="wb-chip__time">{formatClock(remaining)}</span>
              {timer.running ? <IconPause size={13} /> : <IconPlay size={13} />}
            </button>
            {module === 'board' && (
              <>
                <button className="btn-small" onClick={() => commit(toggleAll(list, true))}>全部完成</button>
                <button className="btn-small" onClick={() => commit(toggleAll(list, false))}>全部取消完成</button>
                <button className="btn-small" onClick={clearDone} disabled={!stats.done}>清空已完成</button>
              </>
            )}
            <button className="btn-icon" aria-label="关闭任务面板" onClick={onClose}><IconClose /></button>
          </div>
        </header>

        {module === 'board' && (<>
        <div className="todo-progress" title={`完成 ${stats.done} / ${stats.total}`}>
          <span className="todo-progress-bar" style={{ width: `${Math.round(stats.progress * 100)}%` }} />
        </div>

        {undo && (
          <div className="todo-undo">
            已删除，可撤销
            <button className="btn-small" onClick={undoDelete}>撤销</button>
          </div>
        )}

        <div className="todo-body">
          {/* ---------- 左栏 ---------- */}
          <aside className="todo-side">
            <div className="todo-side__group">
              <div className="todo-side__title">智能列表</div>
              {SMART_ORDER.map((k) => (
                <button
                  key={k}
                  className={`todo-side__item${view === k ? ' active' : ''}`}
                  onClick={() => { setView(k); writePref(VIEW_KEY, k); }}
                >
                  <span>{SMART_LABELS[k]}</span>{' '}
                  <span className="todo-count">{counts[k]}</span>
                </button>
              ))}
            </div>

            <div className="todo-side__group">
              <div className="todo-side__title">笔记里的任务</div>
              <button
                className={`todo-side__item${view === 'notes' ? ' active' : ''}`}
                onClick={() => { setView('notes'); writePref(VIEW_KEY, 'notes'); }}
              >
                <span>待勾选</span>{' '}
                <span className="todo-count">{openNoteTasks.length}</span>
              </button>
            </div>

            {noteGroups.length > 0 && (
              <div className="todo-side__group">
                <div className="todo-side__title">按笔记</div>
                {noteGroups.map((g) => (
                  <button
                    key={g.key || '(none)'}
                    className={`todo-side__item${noteFilter === g.key ? ' active' : ''}`}
                    onClick={() => setNoteFilter(noteFilter === g.key ? null : g.key)}
                  >
                    <span className="todo-side__label">{g.label}</span>{' '}
                    <span className="todo-count">{g.items.length}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          {/* ---------- 中栏 ---------- */}
          <section className="todo-main-col">
            {view !== 'notes' && (
              <div className="todo-composer">
                <input
                  ref={composerRef}
                  className="todo-input"
                  value={text}
                  placeholder="加一条待办…（@明天 !高 #笔记名 *每周 都能认）"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') add();
                  }}
                />
                <button className="btn-small todo-add-btn" onClick={add} disabled={!parsed.text}>添加</button>
              </div>
            )}

            {view !== 'notes' && text.trim() !== '' && (
              <div className="todo-chips">
                {parsed.due && <span className="todo-chip">{dueChip(parsed.due, today)}</span>}
                {parsed.priority && <span className="todo-chip">!{PRIORITY_LABEL[parsed.priority]}</span>}
                {parsed.note && <span className="todo-chip">#{notes.find((n) => n.path === parsed.note)?.name ?? parsed.note}</span>}
                {parsed.repeat && <span className="todo-chip">*{REPEAT_LABELS[parsed.repeat]}</span>}
                <span className="todo-chip todo-chip--text">正文：{parsed.text}</span>
              </div>
            )}

            <div className="todo-toolbar">
              <input
                className="todo-search"
                value={query}
                placeholder="搜索待办（正文/备注/子任务/关联笔记）"
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="todo-sort" value={sort} onChange={(e) => { const v = e.target.value as SortMode; setSort(v); writePref(SORT_KEY, v); }}>
                {SORTS.map((s) => <option key={s.key} value={s.key}>排序：{s.label}</option>)}
              </select>
              <select className="todo-group" value={groupBy} onChange={(e) => { const v = e.target.value as 'due' | 'note'; setGroupBy(v); writePref(GROUP_KEY, v); }}>
                <option value="due">分组：到期</option>
                <option value="note">分组：笔记</option>
              </select>
              {stats.overdue > 0 && <button className="btn-small" onClick={doRollover}>顺延到今天</button>}
              <button className="btn-small" onClick={() => setPicked(flatIds)} disabled={!flatIds.length}>全选</button>
            </div>

            {noteFilter !== null && (
              <div className="todo-filter-chip">
                只看：{notes.find((n) => n.path === noteFilter)?.name ?? (noteFilter || '未关联笔记')}
                <button className="btn-icon" aria-label="清除笔记筛选" onClick={() => setNoteFilter(null)}><IconClose /></button>
              </div>
            )}

            {picked.length > 0 && (
              <div className="todo-batch">
                <span className="todo-batch__count">已选 {picked.length} 项</span>
                <button className="btn-small" onClick={() => batchComplete(true)}>完成</button>
                <button className="btn-small" onClick={() => batchComplete(false)}>取消完成</button>
                <button className="btn-small" onClick={() => batchDue('today')}>改今天</button>
                <button className="btn-small" onClick={() => batchDue('tomorrow')}>改明天</button>
                <button className="btn-small" onClick={() => batchDue('clear')}>清除日期</button>
                <button className="btn-small danger" onClick={batchRemove}>删除</button>
                <button className="btn-small" onClick={() => setPicked([])}>取消选择</button>
              </div>
            )}

            <div className="todo-list">
              {view === 'notes' ? (
                shownNoteTasks.length === 0 ? (
                  <p className="muted todo-empty">笔记里没有未勾选的 `- [ ]` 任务</p>
                ) : (
                  shownNoteTasks.map((t) => (
                    <div className="todo-item todo-note-task" key={`${t.path}#${t.line}`} title={t.raw}>
                      <button
                        className={`todo-check${t.done ? ' on' : ''}`}
                        aria-label={t.done ? '取消勾选笔记任务' : '勾选笔记任务'}
                        onClick={() => void toggleNoteTask(t, !t.done)}
                      />
                      <span className={`todo-text${t.done ? ' done' : ''}`}>{t.text}</span>
                      <span className="todo-meta">
                        <span className="todo-badge">{t.noteTitle}</span>
                        {t.due && <span className="todo-badge">{t.due}</span>}
                        {t.priority && <span className="todo-badge">优先级 {PRIORITY_LABEL[t.priority]}</span>}
                        <button className="btn-small" onClick={() => onOpenPath(t.path)}>打开笔记</button>
                      </span>
                    </div>
                  ))
                )
              ) : sections.length === 0 ? (
                <p className="muted todo-empty">{SMART_EMPTY[view]}</p>
              ) : (
                sections.map((g) => {
                  const isCollapsed = collapsed.includes(g.key);
                  return (
                    <div className="todo-group" key={g.key}>
                      <button
                        className="todo-group-head"
                        onClick={() => setCollapsed((c) => (isCollapsed ? c.filter((x) => x !== g.key) : [...c, g.key]))}
                      >
                        <span>{isCollapsed ? '▸' : '▾'} {g.label}</span>
                        <span className="todo-count">{g.items.length}</span>
                      </button>
                      {!isCollapsed && g.items.map((t) => (
                        <div
                          className={`todo-item${selId === t.id ? ' sel' : ''}${t.done ? ' done' : ''}${pickedSet.has(t.id) ? ' picked' : ''}`}
                          key={t.id}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = flatIds.indexOf(e.dataTransfer.getData('text/plain'));
                            const to = flatIds.indexOf(t.id);
                            if (from >= 0 && to >= 0 && from !== to) commit(moveTodo(list, [flatIds[from]], from, to));
                          }}
                          onClick={(e) => onRowClick(t, e)}
                        >
                          <button
                            className="todo-check"
                            aria-label={t.done ? '标记为未完成' : '标记为完成'}
                            onClick={(e) => { e.stopPropagation(); toggle(t.id); }}
                          />
                          {editingId === t.id ? (
                            <input
                              ref={editRef}
                              className="todo-edit"
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={commitEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                // preventDefault 是必须的：不然事件继续冒到 window，
                                // escStack 会把它当「焦点在输入框里」→ blur() → onBlur 把修改存了
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setEditingId(null);
                                }
                              }}
                            />
                          ) : (
                            <span className="todo-text" onDoubleClick={() => startEdit(t)}>{t.text}</span>
                          )}
                          <span className="todo-meta">
                            {t.priority && (
                              <button
                                className="todo-badge todo-badge--btn"
                                aria-label={`优先级 ${PRIORITY_LABEL[t.priority]}，点击切换`}
                                onClick={(e) => { e.stopPropagation(); cyclePriority(t); }}
                              >
                                优先级 {PRIORITY_LABEL[t.priority]}
                              </button>
                            )}
                            {t.due && <span className="todo-badge">{t.due}</span>}
                            {t.repeat && <span className="todo-badge">{REPEAT_LABELS[t.repeat]}</span>}
                            {t.note && (
                              <button
                                className="todo-badge todo-badge--btn todo-note-badge"
                                onClick={(e) => { e.stopPropagation(); onOpenPath(t.note!); }}
                              >
                                {notes.find((n) => n.path === t.note)?.name ?? t.note.replace(/\.md$/, '').split('/').pop()}
                              </button>
                            )}
                            {subtaskProgress(t).total > 0 && (
                              <span className="todo-badge">
                                {subtaskProgress(t).done}/{subtaskProgress(t).total} 子任务
                              </span>
                            )}
                            {t.pomos ? (
                              <span className="todo-badge todo-badge--pomo" aria-label={`已投入 ${t.pomos} 个番茄`}>
                                <IconTimer size={11} /> {t.pomos}
                              </span>
                            ) : null}
                            {!t.done && (
                              <button
                                className="todo-badge todo-badge--btn todo-focus-btn"
                                title="把这条设为本次专注的待办，并切到专注页"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pickTask(t.id);
                                  setModule('focus');
                                  writePref(MODULE_KEY, 'focus');
                                }}
                              >
                                专注
                              </button>
                            )}
                            <button className="btn-small" onClick={(e) => { e.stopPropagation(); setSelId(t.id); detailRef.current?.focus(); }}>详情</button>
                            <button className="btn-icon" aria-label="删除这条待办" onClick={(e) => { e.stopPropagation(); removeOne(t.id); }}><IconTrash /></button>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* ---------- 右栏 ---------- */}
          <aside className="todo-detail">
            {detail ? (
              <div className="todo-detail__inner">
                <input
                  ref={detailRef}
                  className="todo-detail-title"
                  value={detail.text}
                  onChange={(e) => commit(updateTodo(list, detail.id, { text: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !detail.text.trim()) removeOne(detail.id);
                  }}
                />

                <label className="todo-field">
                  <span>到期日</span>
                  <input
                    type="date"
                    className="todo-date"
                    value={detail.due ?? ''}
                    onChange={(e) => commit(updateTodo(list, detail.id, { due: e.target.value || undefined }))}
                  />
                </label>
                <div className="todo-quick">
                  <button className="btn-small" onClick={() => commit(updateTodo(list, detail.id, { due: today }))}>今天</button>
                  <button className="btn-small" onClick={() => commit(updateTodo(list, detail.id, { due: addDays(today, 1) }))}>明天</button>
                  <button className="btn-small" onClick={() => commit(updateTodo(list, detail.id, { due: undefined }))}>清除</button>
                </div>

                <label className="todo-field">
                  <span>优先级</span>
                  <span className="todo-quick">
                    {PRIORITY_ORDER.map((p) => (
                      <button
                        key={p}
                        className={`btn-small${detail.priority === p ? ' active' : ''}`}
                        onClick={() => commit(updateTodo(list, detail.id, { priority: detail.priority === p ? undefined : p }))}
                      >
                        {PRIORITY_LABEL[p]}
                      </button>
                    ))}
                  </span>
                </label>

                <label className="todo-field">
                  <span>重复</span>
                  <select
                    className="todo-select"
                    value={detail.repeat ?? ''}
                    onChange={(e) => commit(updateTodo(list, detail.id, { repeat: (e.target.value || undefined) as TodoRepeat | undefined }))}
                  >
                    <option value="">不重复</option>
                    {(Object.keys(REPEAT_LABELS) as TodoRepeat[]).map((r) => (
                      <option key={r} value={r}>{REPEAT_LABELS[r]}</option>
                    ))}
                  </select>
                </label>

                <label className="todo-field">
                  <span>关联笔记</span>
                  <input
                    className="todo-note-input"
                    list="todo-note-options"
                    value={notes.find((n) => n.path === detail.note)?.name ?? ''}
                    placeholder="笔记名"
                    onChange={(e) => {
                      const hit = notes.find((n) => n.name.toLowerCase() === e.target.value.trim().toLowerCase());
                      commit(updateTodo(list, detail.id, { note: hit?.path }));
                    }}
                  />
                </label>

                <label className="todo-field todo-field--col">
                  <span>备注</span>
                  <textarea
                    className="todo-memo"
                    rows={3}
                    value={detail.memo ?? ''}
                    placeholder="补充说明（搜索也认它）"
                    onChange={(e) => commit(updateTodo(list, detail.id, { memo: e.target.value || undefined }))}
                  />
                </label>

                <div className="todo-subs">
                  <div className="todo-side__title">
                    子任务 {detailSub ? `${detailSub.done}/${detailSub.total}` : '0/0'}
                  </div>
                  {(detail.subtasks ?? []).map((s) => (
                    <div className="todo-sub" key={s.id}>
                      <button
                        className={`todo-check${s.done ? ' done' : ''}`}
                        aria-label="标记子任务完成"
                        onClick={() => commit(toggleSubtask(list, detail.id, s.id))}
                      />
                      <span className={s.done ? 'done' : ''}>{s.text}</span>
                      <button className="btn-icon" aria-label="删除子任务" onClick={() => commit(removeSubtask(list, detail.id, s.id))}><IconTrash /></button>
                    </div>
                  ))}
                  <input
                    className="todo-sub-input"
                    value={subText}
                    placeholder="拆一步…（回车添加）"
                    onChange={(e) => setSubText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || !subText.trim()) return;
                      commit(addSubtask(list, detail.id, subText));
                      setSubText('');
                    }}
                  />
                </div>

                <div className="todo-quick">
                  <button className="btn-small" onClick={() => onOpenPath(detail.note!)} disabled={!detail.note}>打开笔记</button>
                  <button className="btn-small danger" onClick={() => removeOne(detail.id)}>删除</button>
                </div>
              </div>
            ) : (
              <div className="todo-stats">
                <div className="todo-side__title">进度</div>
                <div className="todo-stats__row"><span>未完成</span><b>{stats.active}</b></div>
                <div className="todo-stats__row"><span>逾期</span><b>{stats.overdue}</b></div>
                <div className="todo-stats__row"><span>今天到期</span><b>{stats.today}</b></div>
                <div className="todo-stats__row"><span>完成数</span><b>{stats.done}</b></div>
                <div className="todo-stats__row"><span>子任务</span><b>{stats.subDone}/{stats.subTotal}</b></div>
                <div className="todo-side__title">近 7 天完成</div>
                <div className="todo-trend">
                  {trend.map((d) => (
                    <span
                      key={d.day}
                      className="todo-trend__bar"
                      title={`${d.day}：完成 ${d.done}`}
                      style={{ height: `${Math.max(6, Math.round((d.done / maxTrend) * 100))}%` }}
                    />
                  ))}
                </div>
                <div className="todo-stats__row"><span>连续完成</span><b>{streak} 天</b></div>
                <p className="muted todo-stats__tip">点中一条待办，这里就变成它的详情。</p>
              </div>
            )}
          </aside>
        </div>

        {/* 关联笔记下拉：原生 datalist，不额外引组件 */}
        <datalist id="todo-note-options">
          {notes.map((n) => (
            <option key={n.path + n.name} value={n.name} />
          ))}
        </datalist>

        <footer className="todo-foot">
          <div className="todo-foot__lead muted">
            短语法：一句话记一条，边打边认。没认出来的词原样留在正文里，不会被吃掉。
          </div>
          <div className="todo-foot__grid">
            {SYNTAX.map((g) => (
              <div className="todo-foot__item" key={g.sign}>
                <span className="todo-foot__sign">{g.sign}</span>
                <span className="todo-foot__desc">{g.desc}</span>
                <span className="todo-foot__examples">
                  {g.examples.map((ex) => (
                    <button
                      key={ex}
                      className="todo-foot__ex"
                      title={`插到输入框：${ex}`}
                      onClick={() => insertToken(ex)}
                    >
                      {ex}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </footer>
        </>)}

        {module === 'focus' && (
          <TodoFocus
            state={timer}
            cfg={cfg}
            remaining={remaining}
            progress={progress}
            stats={pomo}
            todos={list}
            onStart={() => { applyTimer(startPomo(timerRef.current, Date.now())); setNow(Date.now()); }}
            onPause={() => { applyTimer(pausePomo(timerRef.current, Date.now())); setNow(Date.now()); }}
            onReset={resetTimer}
            onSkip={skipTimer}
            onPickTask={pickTask}
            onChangeConfig={changeConfig}
          />
        )}

        {module === 'stats' && (
          <TodoStats
            stats={pomo}
            trend={pomoTrendData}
            heat={heat}
            todos={{ done: stats.done, total: stats.total, overdue: stats.overdue }}
            study={study}
          />
        )}
      </DialogSurface>
    </div>
  );
}
