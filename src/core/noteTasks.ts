/**
 * 笔记里的任务：`- [ ] 复习呼吸系统 📅 2026-09-25 ⏫`
 *
 * 为什么单独一层：任务面板里的是「我自己记下来的」，但学习任务真正长在笔记里
 * （跟着某一节、某一章）。让面板看得见笔记里的勾选框，才不用两边抄一遍。
 *
 * 约定对齐 Obsidian Tasks（github.com/obsidian-tasks-group/obsidian-tasks）：
 *   - 行首可缩进，`- [ ]` / `* [ ]` / `+ [ ]` / `1. [ ]` 都算任务；`[x]`/`[X]` 为已完成；
 *   - `📅 YYYY-MM-DD` 到期日（也认本应用的 `@今天` / `@明天` / `@2026-09-25` 写法）；
 *   - `⏫` 高 / `🔼` 中 / `🔽` 低（也认 `!高` / `!中` / `!低`）；
 *   - 勾选写回源文件：`[ ]` ⇄ `[x]`，完成时补 `✅ YYYY-MM-DD`，取消完成时把它去掉。
 *
 * 刻意不做（写在这里，免得下次又有人以为漏了）：
 *   - 只认**单行任务**，不解析嵌套子任务树（Obsidian Tasks 同样只支持单行）；
 *   - `🔁` 重复只当普通文字留着，不参与调度——真要重复就建成面板里的重复待办；
 *   - 写回前核对「那一行还是不是同一个任务」，笔记在别处被改过就不动它：宁可漏勾一次，不可写坏笔记。
 */
import { parseDueToken, parsePriorityToken, type TodoPriority } from './todos';

export interface NoteTask {
  path: string;
  noteTitle: string;
  /** 0 基行号，写回时用它定位 */
  line: number;
  /** 原始行：写回前拿它核对这一行有没有被改过 */
  raw: string;
  /** 剥掉勾选框与元数据后的正文（界面上显示这个） */
  text: string;
  done: boolean;
  due?: string;
  priority?: TodoPriority;
}

const TASK_RE = /^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/;
const DONE_DATE_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;
const EMOJI_DUE = '📅';
// Obsidian Tasks 的优先级符号（🔺最高 / ⏫高 / 🔼中 / 🔽低 / ⏬最低）。
// 本应用只有三档，所以 🔺 并到「高」、⏬ 并到「低」——别人的笔记照认，不丢信息。
const PRIORITY_EMOJI: Record<string, TodoPriority> = {
  '🔺': 1, '⏫': 1, '🔼': 2, '🔽': 3, '⏬': 3,
};
/** 变体选择符（U+FE0F）：有些输入法会在 emoji 后面补一个，比对前先去掉，但不动原文 */
const norm = (s: string) => s.replace(/\uFE0F/g, '');

/** 这一行是不是任务行（视图判断与写回校验共用一份口径） */
export function isNoteTaskLine(line: string): boolean {
  return TASK_RE.test(line);
}

/** 解析一行任务；不是任务行返回 null */
export function parseNoteTaskLine(
  raw: string,
  today: string
): { raw: string; text: string; done: boolean; due?: string; priority?: TodoPriority } | null {
  const m = TASK_RE.exec(raw);
  if (!m) return null;
  const done = m[3].toLowerCase() === 'x';
  // 完成日期是元数据，不留在正文里
  const body = m[4].replace(DONE_DATE_RE, '');
  let due: string | undefined;
  let priority: TodoPriority | undefined;
  const keep: string[] = [];
  const words = body.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const nw = norm(w); // 只用于比对，写回时仍用原文 w
    if (!due) {
      // `📅2026-09-25` 与 `📅 2026-09-25` 都要认：Obsidian 的惯例是**中间带空格**的写法
      const isDueEmoji = nw.startsWith(EMOJI_DUE);
      if (isDueEmoji && nw.length === EMOJI_DUE.length && i + 1 < words.length) {
        const d = parseDueToken(norm(words[i + 1]), today);
        if (d) {
          due = d;
          i++; // 日期那一格已经吃掉了
          continue;
        }
      }
      // 注意 📅 是代理对，不能用 slice(1) 切
      const bare = isDueEmoji ? nw.slice(EMOJI_DUE.length) : nw.startsWith('@') ? nw.slice(1) : null;
      if (bare) {
        const d = parseDueToken(bare, today);
        if (d) {
          due = d;
          continue;
        }
        if (isDueEmoji) {
          keep.push(w); // 📅 后面不是日期：原样留着，不吃内容
          continue;
        }
      }
    }
    if (!priority) {
      const p = Object.prototype.hasOwnProperty.call(PRIORITY_EMOJI, nw) ? PRIORITY_EMOJI[nw] : parsePriorityToken(nw);
      if (p) {
        priority = p;
        continue;
      }
    }
    keep.push(w);
  }
  return { raw, text: keep.join(' ').trim(), done, due, priority };
}

/** 扫全库笔记里的任务，按「笔记路径 → 行号」的自然顺序返回 */
export function collectNoteTasks(
  docs: Map<string, string>,
  today: string,
  titleOf: (path: string, content: string) => string
): NoteTask[] {
  const out: NoteTask[] = [];
  for (const [path, content] of docs) {
    if (!path.endsWith('.md')) continue;
    // 快速跳过：整篇连一个勾选框都没有就不用逐行正则
    if (!content.includes('[ ]') && !content.includes('[x]') && !content.includes('[X]')) continue;
    const title = titleOf(path, content);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseNoteTaskLine(lines[i], today);
      if (parsed) out.push({ ...parsed, path, noteTitle: title, line: i });
    }
  }
  return out;
}

/**
 * 勾选写回。返回**新的整篇内容**；返回 `null` 表示「不用写」，三种情况：
 *   1. 行号越界或那一行已经不是任务行（笔记在别处被改过）→ 调用方提示用户手动处理；
 *   2. 状态本来就是要写成的状态 → 无事发生（幂等）。
 */
export function setNoteTaskDone(content: string, line: number, done: boolean, today: string): string | null {
  const lines = content.split('\n');
  const cur = lines[line];
  if (cur === undefined) return null;
  const m = TASK_RE.exec(cur);
  if (!m) return null;
  const [, indent, bullet, mark] = m;
  if ((mark.toLowerCase() === 'x') === done) return null;
  const body = m[4].replace(DONE_DATE_RE, '').trimEnd();
  const nextBody = done ? `${body} ✅ ${today}` : body;
  lines[line] = `${indent}${bullet} [${done ? 'x' : ' '}] ${nextBody}`;
  return lines.join('\n');
}
