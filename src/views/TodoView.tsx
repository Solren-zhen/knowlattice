/**
 * 待办清单（Todo）面板：本地优先，持久化到 localStorage。
 *
 * 功能面（参照 TodoMVC app-spec + Super Productivity，见 core/todos.ts 头注释）：
 *   - 短语法快速添加：`复习呼吸系统 @明天 !高 #呼吸系统 *每天`，边打边显示解析结果；
 *   - 到期分组（已逾期/今天/明天/之后/未排期/已完成）+ 手动/到期/优先级三种排序；
 *   - 子任务清单、重复任务（勾完成自动顺延下一条）、关联笔记（点一下跳过去）；
 *   - 行内编辑：双击文字进入，blur/Enter 保存，Esc 丢弃，清空即删除（TodoMVC 语义）；
 *   - 键盘优先：n 新建、↑↓/jk 选择、x 勾选、Enter 编辑、Delete 删除、Esc 分层退出；
 *   - 过滤与排序跨刷新保留。
 * 纯逻辑都在 core/todos.ts（可单测），这里只管画和事件。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc, isEditable } from './useEsc';
import { IconTrash, IconTodo, IconClose } from './icons';
import { toast, confirmBox } from '../core/feedback';
import { parseFrontmatterCached } from '../core/parser';
import {
  addSubtask, BUCKET_LABELS, clearCompleted, completeTodo, dayKey, dueLabel, editTodo, groupTodos,
  loadTodos, makeTodo, matchesQuery, moveTodo, parseQuickAdd, removeSubtask, removeTodo, saveTodos,
  sortTodos, todoStats, toggleAll, toggleSubtask, updateTodo,
  type SortMode, type Todo, type TodoPriority,
} from '../core/todos';

type Filter = 'all' | 'today' | 'active' | 'done';

const FILTER_KEY = 'knowlattice-todo-filter';
const SORT_KEY = 'knowlattice-todo-sort';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' },
];

const SORTS: Array<{ key: SortMode; label: string }> = [
  { key: 'manual', label: '手动' },
  { key: 'due', label: '到期' },
  { key: 'priority', label: '优先级' },
];

const PRIORITY_LABEL: Record<TodoPriority, string> = { 1: '高', 2: '中', 3: '低' };

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export default function TodoView({ onClose, docs, onOpenPath }: {
  onClose: () => void;
  docs: Map<string, string>;
  onOpenPath: (path: string) => void;
}) {
  const [list, setList] = useState<Todo[]>(loadTodos);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>(() => readPref(FILTER_KEY, FILTERS.map((f) => f.key), 'all'));
  const [sort, setSort] = useState<SortMode>(() => readPref(SORT_KEY, SORTS.map((s) => s.key), 'manual'));
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [subText, setSubText] = useState('');
  const composerRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const today = useMemo(() => dayKey(), []);

  /** 笔记名表：短语法 `#名字` 与关联笔记下拉都用它 */
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

  const parsed = useMemo(() => parseQuickAdd(text, today, notes), [text, today, notes]);
  const stats = todoStats(list, today);

  // Esc 分层：编辑中先丢弃编辑，详情开着先收详情，否则才关面板（输入框里先退出输入框）
  useEsc((e) => {
    if (isEditable(e.target)) {
      (e.target as HTMLElement).blur();
      return;
    }
    if (editingId) {
      setEditingId(null);
      return;
    }
    if (openId) {
      setOpenId(null);
      return;
    }
    onClose();
  });

  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  const commit = (next: Todo[]) => {
    setList(next);
    saveTodos(next);
  };

  const add = () => {
    if (!parsed.text) return;
    commit([makeTodo(parsed), ...list]);
    setText('');
    composerRef.current?.focus();
  };

  const shown = useMemo(() => {
    const q = list.filter((t) => matchesQuery(t, query));
    const byFilter = q.filter((t) =>
      filter === 'active' ? !t.done : filter === 'done' ? t.done : filter === 'today' ? !t.done && t.due === today : true
    );
    return byFilter;
  }, [list, query, filter, today]);

  const groups = useMemo(() => groupTodos(shown, today, sort), [shown, today, sort]);
  const flatIds = useMemo(() => groups.flatMap((g) => g.items.map((t) => t.id)), [groups]);

  const toggle = (id: string) => {
    const { list: next, spawned } = completeTodo(list, id, today);
    commit(next);
    if (spawned) toast(`重复任务：已顺延到下一条（${dueLabel(spawned.due, today)}）`, 'ok');
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
    const next: TodoPriority | undefined = t.priority === undefined ? 1 : t.priority === 1 ? 2 : t.priority === 2 ? 3 : undefined;
    commit(updateTodo(list, t.id, { priority: next }));
  };

  /** 键盘：列表里的上下移动 / 勾选 / 编辑 / 删除（输入框里不抢键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || editingId) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const idx = selId ? flatIds.indexOf(selId) : -1;
      const move = (d: number) => {
        if (!flatIds.length) return;
        const next = idx < 0 ? (d > 0 ? 0 : flatIds.length - 1) : Math.min(flatIds.length - 1, Math.max(0, idx + d));
        setSelId(flatIds[next]);
      };
      if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); move(1); return; }
      if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); move(-1); return; }
      if (k === 'n') { e.preventDefault(); composerRef.current?.focus(); return; }
      if (!selId) return;
      const sel = list.find((t) => t.id === selId);
      if (!sel) return;
      if (k === 'x' || k === ' ') { e.preventDefault(); toggle(selId); return; }
      if (k === 'Enter') { e.preventDefault(); startEdit(sel); return; }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); commit(removeTodo(list, selId)); setSelId(null); return; }
      if (k === 'e') { e.preventDefault(); setOpenId(openId === selId ? null : selId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDragDrop = (from: number, to: number) => {
    if (sort !== 'manual') {
      toast('先切到「手动」排序再拖拽调整顺序。', 'info');
      return;
    }
    const ids = groups.flatMap((g) => g.items.map((t) => t.id));
    commit(moveTodo(list, ids, from, to));
  };

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <div className="panel mistake-panel todo-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title">
            <IconTodo /> 待办清单
            <span className="muted"> · {stats.active} 项未完成{stats.overdue ? ` · ${stats.overdue} 项逾期` : ''}</span>
          </span>
          <button className="btn-small" onClick={() => commit(toggleAll(list, !list.every((t) => t.done)))}>
            {list.length > 0 && list.every((t) => t.done) ? '全部取消完成' : '全部完成'}
          </button>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="todo-progress" title={`已完成 ${stats.done}/${stats.total}`}>
          <div className="todo-progress-bar" style={{ width: `${Math.round(stats.progress * 100)}%` }} />
        </div>

        <div className="todo-composer">
          <input
            ref={composerRef}
            autoFocus
            className="todo-input"
            placeholder="加一条，如：复习呼吸系统 @明天 !高 #呼吸系统 *每天"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
              if (e.key === 'Escape') setText('');
            }}
          />
          <button className="btn-small" disabled={!parsed.text} onClick={add}>添加</button>
        </div>

        {/* 边打边显示短语法解析结果：认出来的词会从正文里消失，先让用户看见 */}
        {text.trim() && (
          <div className="todo-chips">
            {parsed.due && <span className="todo-chip due">@{dueLabel(parsed.due, today)}</span>}
            {parsed.priority && <span className="todo-chip pri">!{PRIORITY_LABEL[parsed.priority]}</span>}
            {parsed.repeat && <span className="todo-chip rep">*{parsed.repeat === 'daily' ? '每天' : '每周'}</span>}
            {parsed.note && <span className="todo-chip note">#{notes.find((n) => n.path === parsed.note)?.name ?? parsed.note}</span>}
            <span className="todo-chip text">正文：{parsed.text || '（空）'}</span>
          </div>
        )}
        <div className="todo-hint">
          短语法：<kbd>@今天</kbd> <kbd>@明天</kbd> <kbd>@周一</kbd> <kbd>@9-25</kbd> 定到期 ·
          <kbd>!高</kbd><kbd>!中</kbd><kbd>!低</kbd> 定优先级 · <kbd>#笔记名</kbd> 关联笔记 · <kbd>*每天</kbd><kbd>*每周</kbd> 重复
        </div>

        <div className="todo-filterbar">
          <input
            className="todo-search"
            placeholder="搜索待办 / 子任务 / 关联笔记"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="todo-sort">
            排序
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={`todo-filter ${sort === s.key ? 'on' : ''}`}
                onClick={() => { setSort(s.key); localStorage.setItem(SORT_KEY, s.key); }}
              >
                {s.label}
              </button>
            ))}
          </span>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`todo-filter ${filter === f.key ? 'on' : ''}`}
              onClick={() => { setFilter(f.key); localStorage.setItem(FILTER_KEY, f.key); }}
            >
              {f.label}
              {f.key === 'all' ? ` ${stats.total}` : f.key === 'active' ? ` ${stats.active}` : f.key === 'done' ? ` ${stats.done}` : ` ${stats.today}`}
            </button>
          ))}
          {stats.done > 0 && (
            <button
              className="todo-clear"
              onClick={async () => {
                const ok = await confirmBox({
                  title: `清空 ${stats.done} 条已完成待办？`,
                  detail: '只删已完成项，未完成的都留着。',
                  danger: true,
                  okText: '清空',
                });
                if (ok) commit(clearCompleted(list));
              }}
            >
              清空已完成
            </button>
          )}
        </div>

        <div className="panel__body mistake-list todo-list">
          {shown.length === 0 && (
            <div className="mistake-empty">
              <h2>{filter === 'done' ? '还没有已完成的待办' : query ? '没有匹配的待办' : '待办是空的'}</h2>
              <p className="muted">
                {query ? '换个词试试，搜索会匹配正文、子任务和关联笔记。' : '把要学的内容记下来，完成一项勾一项。按 n 直接开始输入。'}
              </p>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.bucket} className="todo-group">
              <div className="todo-group-head">
                {BUCKET_LABELS[g.bucket]}
                <span className="muted"> · {g.items.length}</span>
              </div>
              {g.items.map((t) => {
                const from = flatIds.indexOf(t.id);
                const sub = t.subtasks ?? [];
                return (
                  <div
                    key={t.id}
                    className={`mistake-item todo-item ${t.done ? 'done' : ''} ${selId === t.id ? 'sel' : ''}`}
                    draggable={sort === 'manual'}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', String(from))}
                    onDragOver={(e) => { if (sort === 'manual') e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = Number(e.dataTransfer.getData('text/plain'));
                      if (Number.isFinite(f)) onDragDrop(f, from);
                    }}
                    onClick={() => setSelId(t.id)}
                  >
                    <button
                      className={`todo-check ${t.done ? 'on' : ''}`}
                      aria-label={t.done ? '标记为未完成' : '标记为完成'}
                      onClick={(e) => { e.stopPropagation(); toggle(t.id); }}
                    >
                      {t.done ? '✓' : ''}
                    </button>

                    <div className="todo-main">
                      {editingId === t.id ? (
                        <input
                          ref={editRef}
                          className="todo-edit"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); }
                          }}
                        />
                      ) : (
                        <div
                          className="todo-text"
                          title="双击编辑"
                          onDoubleClick={() => startEdit(t)}
                        >
                          {t.text}
                        </div>
                      )}
                      <div className="todo-meta">
                        {t.due && (
                          <span className={`todo-badge due-${t.due < today ? 'over' : t.due === today ? 'today' : 'later'}`}>
                            {dueLabel(t.due, today)}
                          </span>
                        )}
                        {t.priority && <span className={`todo-badge pri-${t.priority}`}>优先级 {PRIORITY_LABEL[t.priority]}</span>}
                        {t.repeat && <span className="todo-badge rep">{t.repeat === 'daily' ? '每天' : '每周'}</span>}
                        {sub.length > 0 && <span className="todo-badge sub">子任务 {sub.filter((s) => s.done).length}/{sub.length}</span>}
                        {t.note && (
                          <button
                            className="todo-badge note"
                            title="打开关联笔记"
                            onClick={(e) => { e.stopPropagation(); onOpenPath(t.note!); }}
                          >
                            {t.note.replace(/\.md$/, '').split('/').pop()}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="todo-actions">
                      <button className="btn-small" onClick={(e) => { e.stopPropagation(); cyclePriority(t); }} title="点一下切换优先级：高 → 中 → 低 → 无">
                        优先级
                      </button>
                      <button className="btn-small" onClick={(e) => { e.stopPropagation(); setOpenId(openId === t.id ? null : t.id); }}>
                        {openId === t.id ? '收起' : '详情'}
                      </button>
                      <button className="btn-small" onClick={(e) => { e.stopPropagation(); startEdit(t); }}>编辑</button>
                      <button className="btn-icon" aria-label="删除" onClick={(e) => { e.stopPropagation(); commit(removeTodo(list, t.id)); }}>
                        <IconTrash />
                      </button>
                    </div>

                    {openId === t.id && (
                      <div className="todo-detail" onClick={(e) => e.stopPropagation()}>
                        <div className="todo-detail-row">
                          <label>到期日</label>
                          <input
                            type="date"
                            className="todo-date"
                            value={t.due ?? ''}
                            onChange={(e) => commit(updateTodo(list, t.id, { due: e.target.value || undefined }))}
                          />
                          <label>重复</label>
                          <select
                            className="todo-select"
                            value={t.repeat ?? ''}
                            onChange={(e) => commit(updateTodo(list, t.id, { repeat: (e.target.value || undefined) as Todo['repeat'] }))}
                          >
                            <option value="">不重复</option>
                            <option value="daily">每天</option>
                            <option value="weekly">每周</option>
                          </select>
                        </div>
                        <div className="todo-detail-row">
                          <label>关联笔记</label>
                          <input
                            className="todo-note-input"
                            list="todo-note-options"
                            placeholder="输入笔记名，或用短语法 #名字"
                            value={t.note ?? ''}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              const hit = notes.find((n) => n.name.toLowerCase() === v.toLowerCase() || n.path === v);
                              commit(updateTodo(list, t.id, { note: hit ? hit.path : v || undefined }));
                            }}
                          />
                          {t.note && (
                            <button className="btn-small" onClick={() => onOpenPath(t.note!)}>打开笔记</button>
                          )}
                        </div>
                        <div className="todo-detail-row todo-sub-add">
                          <label>子任务</label>
                          <input
                            className="todo-note-input"
                            placeholder="拆一步，回车添加（如：先看心电图诊断）"
                            value={openId === t.id ? subText : ''}
                            onChange={(e) => setSubText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && subText.trim()) {
                                commit(addSubtask(list, t.id, subText));
                                setSubText('');
                              }
                            }}
                          />
                        </div>
                        {sub.map((s) => (
                          <div key={s.id} className={`todo-sub ${s.done ? 'done' : ''}`}>
                            <button
                              className={`todo-check ${s.done ? 'on' : ''}`}
                              aria-label={s.done ? '标记子任务未完成' : '标记子任务完成'}
                              onClick={() => commit(toggleSubtask(list, t.id, s.id))}
                            >
                              {s.done ? '✓' : ''}
                            </button>
                            <span>{s.text}</span>
                            <button className="btn-icon" aria-label="删除子任务" onClick={() => commit(removeSubtask(list, t.id, s.id))}>
                              <IconTrash />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* 关联笔记下拉：原生 datalist，不额外引组件 */}
        <datalist id="todo-note-options">
          {notes.map((n) => (
            <option key={n.path + n.name} value={n.name} />
          ))}
        </datalist>

        <div className="todo-foot muted">
          快捷键：<kbd>n</kbd> 新建 · <kbd>↑</kbd><kbd>↓</kbd>/<kbd>j</kbd><kbd>k</kbd> 选择 · <kbd>x</kbd> 勾选 ·
          <kbd>Enter</kbd> 编辑 · <kbd>Delete</kbd> 删除 · <kbd>e</kbd> 详情 · 双击文字也能编辑
          {sortTodos(list, sort).length !== list.length ? '' : ''}
        </div>
      </div>
    </div>
  );
}
