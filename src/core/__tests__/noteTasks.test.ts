/**
 * 笔记里的任务（core/noteTasks.ts）：解析、勾选写回、冲突保护。
 * 约定对齐 Obsidian Tasks（📅 到期 / ⏫🔼🔽 优先级 / ✅ 完成日期）。
 */
import { describe, expect, it } from 'vitest';
import { collectNoteTasks, isNoteTaskLine, parseNoteTaskLine, setNoteTaskDone } from '../noteTasks';

const TODAY = '2026-09-21';

describe('解析笔记任务行', () => {
  it('认 `- [ ]` / `* [ ]` / `1. [ ]` / 缩进，以及 `[x]` 完成态', () => {
    expect(isNoteTaskLine('- [ ] 复习')).toBe(true);
    expect(isNoteTaskLine('  * [x] 复习')).toBe(true);
    expect(isNoteTaskLine('1. [ ] 复习')).toBe(true);
    expect(isNoteTaskLine('- 普通列表项')).toBe(false);
    expect(isNoteTaskLine('正文里写 [ ] 不算')).toBe(false);
  });

  it('剥掉勾选框与元数据，只留正文', () => {
    const t = parseNoteTaskLine('- [ ] 背氧解离曲线 📅 2026-09-25 ⏫', TODAY)!;
    expect(t.text).toBe('背氧解离曲线');
    expect(t.due).toBe('2026-09-25');
    expect(t.priority).toBe(1);
    expect(t.done).toBe(false);
    expect(t.raw).toBe('- [ ] 背氧解离曲线 📅 2026-09-25 ⏫');
  });

  it('也认本应用的 @日期 / !优先级，且 🔼🔽 映射中/低', () => {
    expect(parseNoteTaskLine('- [ ] 背单词 @明天 !高', TODAY)).toMatchObject({ due: '2026-09-22', priority: 1 });
    expect(parseNoteTaskLine('- [ ] 甲 🔼', TODAY)).toMatchObject({ priority: 2 });
    expect(parseNoteTaskLine('- [ ] 乙 🔽', TODAY)).toMatchObject({ priority: 3 });
  });

  it('优先级符号全认：🔺/⏫ 高、🔼 中、🔽/⏬ 低', () => {
    expect(parseNoteTaskLine('- [ ] 甲 🔺', TODAY)).toMatchObject({ priority: 1 });
    expect(parseNoteTaskLine('- [ ] 乙 ⏫', TODAY)).toMatchObject({ priority: 1 });
    expect(parseNoteTaskLine('- [ ] 丙 ⏬', TODAY)).toMatchObject({ priority: 3 });
  });

  it('带变体选择符（U+FE0F）也认，但正文里不会多出字符', () => {
    const p = parseNoteTaskLine('- [ ] 丁 ⏫\uFE0F', TODAY)!;
    expect(p.priority).toBe(1);
    expect(p.text).toBe('丁');
    expect(parseNoteTaskLine('- [ ] 戊 📅\uFE0F 2026-09-25', TODAY)).toMatchObject({ due: '2026-09-25', text: '戊' });
  });

  it('📅 后面不是日期就原样留着，不吃内容', () => {
    const t = parseNoteTaskLine('- [ ] 看图 📅 待定', TODAY)!;
    expect(t.text).toBe('看图 📅 待定');
    expect(t.due).toBeUndefined();
  });

  it('✅ 完成日期不留在正文里', () => {
    const t = parseNoteTaskLine('- [x] 复习 ✅ 2026-09-20', TODAY)!;
    expect(t.text).toBe('复习');
    expect(t.done).toBe(true);
  });

  it('不是任务行返回 null', () => {
    expect(parseNoteTaskLine('## 标题', TODAY)).toBeNull();
  });
});

describe('扫全库笔记', () => {
  const docs = new Map<string, string>([
    ['内科学/呼吸系统.md', '# 呼吸系统\n\n- [ ] 甲\n\n- [x] 乙\n'],
    ['内科学/循环系统.md', '# 循环系统\n\n这里没有任务\n'],
    ['附件/图.png', '- [ ] 不是笔记'],
  ]);
  const titleOf = (p: string, c: string) => c.split('\n')[0].replace(/^#\s*/, '') || p;

  it('只扫 .md；行号 0 基；标题与原始行都带上', () => {
    const out = collectNoteTasks(docs, TODAY, titleOf);
    expect(out.map((t) => [t.path, t.line, t.text, t.done])).toEqual([
      ['内科学/呼吸系统.md', 2, '甲', false],
      ['内科学/呼吸系统.md', 4, '乙', true],
    ]);
    expect(out[0].noteTitle).toBe('呼吸系统');
    expect(out[0].raw).toBe('- [ ] 甲');
  });

  it('没有勾选框的笔记整篇跳过', () => {
    const only = new Map([['a.md', '# 标题\n\n正文\n']]);
    expect(collectNoteTasks(only, TODAY, titleOf)).toEqual([]);
  });
});

describe('勾选写回源文件', () => {
  const src = '# 标题\n- [ ] 甲\n- [x] 乙\n正文\n';

  it('勾上：`[ ]` → `[x]` 并补 ✅ 日期', () => {
    expect(setNoteTaskDone(src, 1, true, TODAY)).toBe('# 标题\n- [x] 甲 ✅ 2026-09-21\n- [x] 乙\n正文\n');
  });

  it('取消：`[x]` → `[ ]` 并把 ✅ 去掉', () => {
    const done = '# 标题\n- [ ] 甲\n- [x] 乙 ✅ 2026-09-20\n正文\n';
    expect(setNoteTaskDone(done, 2, false, TODAY)).toBe('# 标题\n- [ ] 甲\n- [ ] 乙\n正文\n');
  });

  it('保持缩进与列表符号', () => {
    expect(setNoteTaskDone('  * [ ] 甲', 0, true, TODAY)).toBe('  * [x] 甲 ✅ 2026-09-21');
  });

  it('状态本来就对：返回 null（幂等，不做无谓写盘）', () => {
    expect(setNoteTaskDone(src, 1, false, TODAY)).toBeNull();
    expect(setNoteTaskDone(src, 2, true, TODAY)).toBeNull();
  });

  it('行号越界或那一行已不是任务行：返回 null（宁可漏勾，不可写坏笔记）', () => {
    expect(setNoteTaskDone(src, 99, true, TODAY)).toBeNull();
    expect(setNoteTaskDone('# 标题\n刚才那行被改成正文了\n', 1, true, TODAY)).toBeNull();
  });

  it('写回后能再解析回来（往返一致）', () => {
    const next = setNoteTaskDone(src, 1, true, TODAY)!;
    const again = parseNoteTaskLine(next.split('\n')[1], TODAY)!;
    expect(again).toMatchObject({ text: '甲', done: true });
  });
});
