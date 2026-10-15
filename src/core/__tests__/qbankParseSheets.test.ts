/**
 * qbankParse 的 Excel 分支：**多表题库**只读第一张表时必须说清楚。
 *
 * 为什么单独钉：中医院校的题库 Excel 常按题型分表（单选 / 多选 / 判断）。只读第一张而报告里
 * 只说「题库「X」：N 题」的话，用户会以为整份文件都进来了——静默少导是本项目最忌讳的失败形态。
 * 这里不测「自动合并多表」（那是另一个决定：章节归属、去重口径都要先定），只测**说出来**。
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseQbankFile } from '../qbankParse';

/** 造一份真的 xlsx 字节（SheetJS 在 node 下可用，不必手写二进制） */
function xlsxFile(name: string, sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>): File {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows), s.name);
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

describe('parseQbankFile · Excel 多工作表', () => {
  it('只有一张表：不问「其余哪去了」，note 里不出现未读取的提示', async () => {
    const f = xlsxFile('题库甲.xlsx', [
      { name: '单选', rows: [{ 题干: '题干甲？', 答案: '甲' }] },
    ]);
    const r = await parseQbankFile(f);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.questions).toHaveLength(1);
    expect(r.note ?? '').not.toContain('未读取');
  });

  it('多张表：只读第一张，并把「哪几张没读」写进 note（调用方会显示在导入报告里）', async () => {
    const f = xlsxFile('题库甲.xlsx', [
      { name: '单选', rows: [{ 题干: '题干甲？', 答案: '甲' }] },
      { name: '多选', rows: [{ 题干: '题干乙？', 答案: '乙' }] },
      { name: '判断', rows: [{ 题干: '题干丙？', 答案: '对' }] },
    ]);
    const r = await parseQbankFile(f);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.questions).toHaveLength(1); // 只吃第一张：题数与改动前一致
    expect(r.note).toContain('只读了第一张工作表「单选」');
    expect(r.note).toContain('另有 2 张未读取');
    expect(r.note).toContain('多选');
    expect(r.note).toContain('判断');
  });
});
