/**
 * 脚注与表格加行的纯函数测试。
 *
 * 重点钉住两类静默出错：脚注编号撞号（删过脚注后再插会重复）、表格加行插错位置
 * （插到分隔行上面，整张表在 markdown 里就散了）。
 */
import { describe, expect, it } from 'vitest';
import { appendTableRow, insertFootnote, notesMarkdown, splitFootnotes } from '../footnote';

describe('脚注', () => {
  it('摘出文末定义，正文里留下引用占位符', () => {
    const doc = '静息电位靠钾外流。[^1]\n\n[^1]: 生理学第 2 章';
    const { body, notes } = splitFootnotes(doc);
    expect(notes).toEqual([{ label: '1', body: '生理学第 2 章' }]);
    expect(body).not.toContain('[^1]:');
    expect(body).toContain('\uE020' + '1' + '\uE021');
  });

  it('代码块里的 [^1] 不当脚注', () => {
    const doc = '```\n[^1]: 这是代码\n```\n正文[^1]\n\n[^1]: 真的脚注';
    const { notes } = splitFootnotes(doc);
    expect(notes).toEqual([{ label: '1', body: '真的脚注' }]);
  });

  it('重复定义只留第一条', () => {
    const { notes } = splitFootnotes('正文[^a]\n\n[^a]: 第一\n[^a]: 第二');
    expect(notes).toEqual([{ label: 'a', body: '第一' }]);
  });

  it('插脚注时编号取已有最大值 +1，不与旧号撞', () => {
    const doc = '正文一[^1]\n\n[^1]: 一\n';
    const edit = insertFootnote(doc, doc.length, doc.length);
    expect(edit.changes[0].insert).toBe('[^2]');
    expect(edit.changes[1].insert).toContain('[^2]:');
  });

  it('选中文字插脚注时，文字搬进脚注正文', () => {
    const doc = '静息电位由钾外流决定。';
    const edit = insertFootnote(doc, 0, 11);
    expect(edit.changes[0]).toMatchObject({ from: 0, to: 11, insert: '[^1]' });
    expect(edit.changes[1].insert).toContain('[^1]: 静息电位由钾外流决定。');
  });

  it('没有脚注时不追任何内容（不留一条光秃秃的分隔线）', () => {
    expect(notesMarkdown([])).toBe('');
  });
});

describe('表格加行', () => {
  const table = '前文\n\n| 结构 | 数量 |\n| --- | --- |\n| 颈髓 | 8 |\n\n后文';

  it('在表格末尾追加一行，列数与表头一致', () => {
    const edit = appendTableRow(table, table.indexOf('颈髓'))!;
    expect(edit).not.toBeNull();
    const at = edit.changes[0].from;
    const after = table.slice(0, at) + edit.changes[0].insert + table.slice(at);
    expect(after).toContain('| 颈髓 | 8 |\n|  |  |\n');
    // 后文不能被挤进表格
    expect(after.endsWith('\n\n后文')).toBe(true);
  });

  it('光标不在表格里返回 null', () => {
    expect(appendTableRow(table, 0)).toBeNull();
    expect(appendTableRow(table, table.length - 1)).toBeNull();
  });

  it('列数按表头算：某行少一个竖线也不带偏整张表', () => {
    const ragged = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n';
    const edit = appendTableRow(ragged, ragged.indexOf('| 1'))!;
    const at = edit.changes[0].from;
    const after = ragged.slice(0, at) + edit.changes[0].insert + ragged.slice(at);
    expect(after).toContain('|  |  |  |');
  });
});
