/**
 * 类名守卫：视图里用到的类名，index.css 里必须有对应规则。
 *
 * 这条测试来自一次真实事故：CSS 写的是 `.panel.todo-panel`，而 JSX 里写的是 `todo-page`。
 * 选择器永远匹配不上 → 整页宽度/高度静默失效，界面还是旧的窄浮层；
 * 单元测试全绿、lint 全绿、构建也全绿，因为没有任何东西检查「类名有没有人接」。
 *
 * 只查 todo-/wb- 这两个前缀的类：它们是本模块自己的命名空间，
 * 通用类（active/done/sel/muted 之类）另有约定，不在这个守卫的职责里。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VIEWS = ['src/views/TodoView.tsx', 'src/views/TodoFocus.tsx', 'src/views/TodoStats.tsx'];
const CSS = 'src/index.css';

/** 故意只做测试钩子的类名（DOM 测试用它取元素），样式由别的类承担 */
const TEST_HOOKS = new Set(['todo-note-badge']);

/** 从 className="…" 与 className={`…`} 里抠出候选类名，去掉 ${…} 插值 */
function classesOf(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    for (const tok of raw.split(/[\s'"]+/)) {
      if (/^(todo|wb)-[a-z0-9_-]+$/.test(tok)) out.add(tok);
    }
  }
  return out;
}

describe('类名守卫（视图 ↔ CSS）', () => {
  const css = readFileSync(resolve(process.cwd(), CSS), 'utf8');

  for (const file of VIEWS) {
    it(`${file} 用到的 todo-/wb- 类名都有样式`, () => {
      const used = classesOf(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(used.size).toBeGreaterThan(0);
      const orphans = [...used].filter((c) => !TEST_HOOKS.has(c) && !css.includes(`.${c}`));
      expect(orphans).toEqual([]);
    });
  }

  it('整页面板的选择器与视图里的类名对得上（上一轮的事故）', () => {
    expect(css).toContain('.panel.todo-panel');
    expect(readFileSync(resolve(process.cwd(), 'src/views/TodoView.tsx'), 'utf8')).toContain('todo-panel');
  });
});
