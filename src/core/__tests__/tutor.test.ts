import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMastery, clampLevel, loadMastery, MASTERY_PASS, masteryReport, nextStepHint, saveMastery,
  TUTOR_PROMPT_LINES, TUTOR_TOOLS, type MasteryMap,
} from '../tutor';

beforeEach(() => localStorage.clear());

const EMPTY: MasteryMap = {};

describe('导师模式：掌握度等级', () => {
  it('非法值一律夹到 0–3（模型传 4 / -1 / 字符串都不会写坏台账）', () => {
    expect(clampLevel(3)).toBe(3);
    expect(clampLevel(4)).toBe(MASTERY_PASS);
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel('2')).toBe(2);
    expect(clampLevel(2.6)).toBe(3);
    expect(clampLevel('abc')).toBe(0);
    expect(clampLevel(undefined)).toBe(0);
  });

  it('applyMastery 不修改原对象、累加判定次数、清理 evidence', () => {
    const first = applyMastery(EMPTY, ' 心力衰竭的前负荷 ', 2, '  能说出三要素  ', 1_000);
    expect(Object.keys(EMPTY)).toEqual([]);
    expect(first['心力衰竭的前负荷']).toMatchObject({ level: 2, attempts: 1, evidence: '能说出三要素', updatedAt: 1_000 });
    const second = applyMastery(first, '心力衰竭的前负荷', 3, '', 2_000);
    expect(second['心力衰竭的前负荷']).toMatchObject({ level: 3, attempts: 2, evidence: '', updatedAt: 2_000 });
    expect(first['心力衰竭的前负荷'].level).toBe(2);
  });

  it('空主题不写入；超长 evidence 截断到 200 字', () => {
    expect(applyMastery(EMPTY, '   ', 3, 'x')).toBe(EMPTY);
    const map = applyMastery(EMPTY, '主题', 1, 'y'.repeat(300));
    expect(map['主题'].evidence).toHaveLength(200);
  });

  it('nextStepHint 按等级给出下一步，只有 3 放行', () => {
    expect(nextStepHint(3)).toContain('已过门槛');
    expect(nextStepHint(2)).toContain('变式');
    expect(nextStepHint(1)).toContain('回到讲解');
    expect(nextStepHint(0)).toContain('诊断');
  });
});

describe('导师模式：台账报告', () => {
  it('空台账如实说明，不编造进度', () => {
    expect(masteryReport(EMPTY)).toContain('还是空的');
  });

  it('先列没过的、再列已过的，并统计过门槛数量', () => {
    let map: MasteryMap = {};
    map = applyMastery(map, '已通', 3, '变式题答对', 5_000);
    map = applyMastery(map, '卡住', 1, '', 4_000);
    map = applyMastery(map, '半通', 2, '', 4_500);
    const out = masteryReport(map, 6_000);
    expect(out).toContain('3 个知识点，已过门槛 1 个，未过 2 个');
    expect(out.indexOf('卡住')).toBeLessThan(out.indexOf('半通'));
    expect(out.indexOf('半通')).toBeLessThan(out.indexOf('已通'));
    expect(out).toContain('依据：变式题答对');
  });

  it('超过上限时末尾注明省略数量', () => {
    let map: MasteryMap = {};
    for (let i = 0; i < 10; i++) map = applyMastery(map, `主题${i}`, 1, '', 1_000 + i);
    expect(masteryReport(map, 2_000, 8)).toContain('其余 2 个省略');
  });
});

describe('导师模式：存储与工具', () => {
  it('saveMastery / loadMastery 往返，坏数据回退为空台账', () => {
    saveMastery(applyMastery(EMPTY, '主题A', 2, '能复述', 1));
    expect(loadMastery()['主题A']).toMatchObject({ level: 2, attempts: 1 });
    localStorage.setItem('knowlattice-tutor-mastery', '{bad json');
    expect(loadMastery()).toEqual({});
    localStorage.setItem('knowlattice-tutor-mastery', '[]');
    expect(loadMastery()).toEqual({});
  });

  it('导师工具只新增两件：读台账 + 记判定；提示里写明「没有记录就等于没通过」', () => {
    expect(TUTOR_TOOLS.map((t) => t.name)).toEqual(['get_mastery', 'set_mastery']);
    const prompt = TUTOR_PROMPT_LINES.join('\n');
    expect(prompt).toContain('0 未测 / 1 有印象 / 2 能复述 / 3 能应用');
    expect(prompt).toContain('set_mastery');
    expect(prompt).toContain('没有记录就等于没通过');
  });
});
