import { describe, expect, it } from 'vitest';
import { insertTable, tableSkeleton, textToTable, TABLE_MAX_COLS, TABLE_MAX_ROWS } from '../mdTable';

describe('tableSkeleton', () => {
  it('生成表头 + 分隔行 + 数据行的 GFM 表格', () => {
    const lines = tableSkeleton(2, 3).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('| 列1 | 列2 | 列3 |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('|  |  |  |');
    expect(lines[3]).toBe('|  |  |  |');
  });

  it('0 数据行时只出表头与分隔行', () => {
    expect(tableSkeleton(0, 2).split('\n')).toHaveLength(2);
  });

  it('行列数被夹在允许范围内', () => {
    const lines = tableSkeleton(999, 999).split('\n');
    expect(lines).toHaveLength(TABLE_MAX_ROWS + 2); // 表头 + 分隔 + 最大数据行
    expect(lines[0].split('|').filter((c) => c.trim()).length).toBe(TABLE_MAX_COLS);
  });
});

describe('textToTable', () => {
  it('制表符分隔的多行 → 表头 + 数据行', () => {
    const t = textToTable('疾病\t特点\nCOPD\t持续气流受限\n哮喘\t可逆');
    expect(t!.split('\n')).toEqual([
      '| 疾病 | 特点 |',
      '| --- | --- |',
      '| COPD | 持续气流受限 |',
      '| 哮喘 | 可逆 |',
    ]);
  });

  it('逗号 / 中文顿号 / 分号都能识别', () => {
    expect(textToTable('a, b\n1, 2')!.split('\n')[1]).toBe('| --- | --- |');
    expect(textToTable('a、b\n1、2')!.split('\n')[0]).toBe('| a | b |');
    expect(textToTable('a；b\n1；2')!.split('\n')[0]).toBe('| a | b |');
  });

  it('各行列数不一致时不硬拆，返回 null', () => {
    expect(textToTable('a\tb\nc')).toBeNull();
  });

  it('单列文本不转表格', () => {
    expect(textToTable('第一行\n第二行\n第三行')).toBeNull();
  });

  it('单元格里的竖线被转义，避免破坏表格结构', () => {
    const t = textToTable('名称\t说明\na|b\t含竖线');
    expect(t).toContain('a\\|b');
  });

  it('空文本返回 null', () => {
    expect(textToTable('   \n  ')).toBeNull();
  });
});

describe('insertTable', () => {
  it('插到空文档开头，光标选中表头第一个单元格', () => {
    const edit = insertTable('', 0, 0, tableSkeleton(1, 2));
    expect(edit.changes[0].insert).toBe('| 列1 | 列2 |\n| --- | --- |\n|  |  |');
    expect(edit.selection).toEqual({ anchor: 2, head: 4 });
  });

  it('光标停在文字行中间时，先另起一段再插入', () => {
    const doc = '正文';
    const edit = insertTable(doc, 2, 2, tableSkeleton(1, 2));
    expect(edit.changes[0].insert.startsWith('\n\n| 列1 | 列2 |')).toBe(true);
  });

  it('已有空行铺垫时不再多加空行', () => {
    const doc = '正文\n\n';
    const edit = insertTable(doc, doc.length, doc.length, tableSkeleton(1, 2));
    expect(edit.changes[0].insert.startsWith('| 列1')).toBe(true);
  });

  it('替换选中文字，并在表格前空开一行', () => {
    const doc = '前\n旧内容\n后';
    const from = doc.indexOf('旧内容');
    const edit = insertTable(doc, from, from + 3, tableSkeleton(1, 2));
    expect(edit.changes[0]).toMatchObject({ from, to: from + 3 });
    expect(edit.changes[0].insert.startsWith('\n| 列1')).toBe(true);
  });

  it('CRLF 文档沿用 CRLF', () => {
    const doc = '前\r\n\r\n';
    const edit = insertTable(doc, doc.length, doc.length, tableSkeleton(1, 2));
    expect(edit.changes[0].insert).toContain('\r\n');
    expect(edit.changes[0].insert).not.toContain('\n\n|');
  });
});
