import { describe, expect, it } from 'vitest';
import { buildNoteSystemPrompt } from '../aiAgent';

describe('导师模式：系统提示接线', () => {
  it('开启导师时注入掌握度契约与台账', () => {
    const prompt = buildNoteSystemPrompt(null, null, true, 0, '', '', true, '- 心力衰竭的前负荷：能复述（2/3）');
    expect(prompt).toContain('【导师模式】');
    expect(prompt).toContain('0 未测 / 1 有印象 / 2 能复述 / 3 能应用');
    expect(prompt).toContain('【当前掌握度台账】');
    expect(prompt).toContain('心力衰竭的前负荷：能复述（2/3）');
    // 陪练契约仍然在：导师是在陪练之上加门禁，不是替换
    expect(prompt).toContain('【陪练模式】');
  });

  it('台账为空时明说这是第一次，不假装有进度', () => {
    const prompt = buildNoteSystemPrompt(null, null, true, 0, '', '', true, '');
    expect(prompt).toContain('（台账为空，这是第一次导师会话。）');
  });

  it('未开导师时不出现掌握度相关段落', () => {
    const prompt = buildNoteSystemPrompt(null, null, true, 0, '', '');
    expect(prompt).not.toContain('【导师模式】');
    expect(prompt).not.toContain('【当前掌握度台账】');
  });
});
