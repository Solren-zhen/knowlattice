/**
 * 待办清单（Todo）：本地优先的简单待办，持久化到 localStorage。
 * 增 / 勾完成 / 删 / 全部·进行中·已完成过滤 / 清空已完成。
 */
import { useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import { IconTrash, IconTodo, IconClose } from './icons';
import { loadTodos, saveTodos, newTodoId, type Todo } from '../core/todos';

type Filter = 'all' | 'active' | 'done';

export default function TodoView({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Todo[]>(loadTodos);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // Esc 关闭。走全局 Esc 栈；焦点在新增输入框里时先退出输入框，再按一次才关面板
  useEsc(escThenClose(onClose));

  const add = () => {
    const t = text.trim();
    if (!t) return;
    const next = [{ id: newTodoId(), text: t, done: false, createdAt: Date.now() }, ...list];
    setList(next);
    saveTodos(next);
    setText('');
  };

  const toggle = (id: string) => {
    const next = list.map((t) =>
      t.id === id ? { ...t, done: !t.done, completedAt: t.done ? undefined : Date.now() } : t
    );
    setList(next);
    saveTodos(next);
  };

  const remove = (id: string) => {
    const next = list.filter((t) => t.id !== id);
    setList(next);
    saveTodos(next);
  };

  const clearDone = () => {
    const next = list.filter((t) => !t.done);
    setList(next);
    saveTodos(next);
  };

  const shown = list.filter((t) =>
    filter === 'active' ? !t.done : filter === 'done' ? t.done : true
  );
  const active = list.filter((t) => !t.done).length;
  const done = list.length - active;

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <div className="panel mistake-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title"><IconTodo /> 待办清单 <span className="muted">· {list.length} 项</span></span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="todo-add">
          <input
            autoFocus
            className="todo-input"
            placeholder="添加一条待办，如：复习生理学·呼吸章节"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn-small" disabled={!text.trim()} onClick={add}>添加</button>
        </div>

        <div className="todo-filterbar">
          {(['all', 'active', 'done'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`todo-filter ${filter === f ? 'on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? '全部' : f === 'active' ? '进行中' : '已完成'}
              {f === 'all' ? ` ${list.length}` : f === 'active' ? ` ${active}` : ` ${done}`}
            </button>
          ))}
          {done > 0 && <button className="todo-clear" onClick={clearDone}>清空已完成</button>}
        </div>

        <div className="panel__body mistake-list">
          {shown.length === 0 && (
            <div className="mistake-empty">
              <h2>{filter === 'done' ? '还没有已完成的待办' : '待办是空的'}</h2>
              <p className="muted">把要学的内容记下来，完成一项勾一项。</p>
            </div>
          )}
          {shown.map((t) => (
            <div key={t.id} className={`mistake-item todo-item ${t.done ? 'done' : ''}`}>
              <button
                className={`todo-check ${t.done ? 'on' : ''}`}
                aria-label={t.done ? '标记为未完成' : '标记为完成'}
                onClick={() => toggle(t.id)}
              >
                {t.done ? '✓' : ''}
              </button>
              <div className="mistake-item-main todo-text">{t.text}</div>
              <button className="btn-icon" aria-label="删除" onClick={() => remove(t.id)}>
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
