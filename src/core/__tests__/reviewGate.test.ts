import { describe, expect, it } from 'vitest';
import {
  RATIONALE_MIN_CHARS,
  REFLECTION_MIN_CHARS,
  gatePrompt,
  needsRationale,
  rationaleHint,
  rationaleReady,
  reflectionCounter,
  reflectionReady,
  shouldGateExplanation,
} from '../reviewGate';

describe('reviewGate', () => {
  it('只有答对且很确定才直接看解析', () => {
    expect(shouldGateExplanation(true, 5)).toBe(false);
    expect(shouldGateExplanation(true, 4)).toBe(true);
    // 没报把握度不算「没把握」，不 punitive 地挡解析
    expect(shouldGateExplanation(true, null)).toBe(false);
    expect(shouldGateExplanation(false, 5)).toBe(true);
  });

  it('反思够 10 字或勾了「我想过了」就放行', () => {
    expect(reflectionReady('不知道')).toBe(false);
    expect(reflectionReady('一二三四五六七八九')).toBe(false);
    expect(reflectionReady('一二三四五六七八九十')).toBe(true);
    expect(reflectionReady('短', true)).toBe(true);
    expect(REFLECTION_MIN_CHARS).toBe(10);
  });

  it('字数计数带达标标记', () => {
    expect(reflectionCounter('abc')).toBe('3/10 字');
    expect(reflectionCounter('  abcdefghij  ')).toBe('10/10 字 ✓');
  });

  it('闸门提示按对错分岔', () => {
    expect(gatePrompt(false)).toContain('错在哪');
    expect(gatePrompt(true)).toContain('推理链');
  });

  it('自证只在「对但可疑」时触发', () => {
    expect(needsRationale(true, 5, 2)).toBe(false);
    expect(needsRationale(true, 5, 1)).toBe(true);
    expect(needsRationale(true, 3, 3)).toBe(true);
    expect(needsRationale(false, 5, 3)).toBe(false);
  });

  it('自证门槛与按钮文案', () => {
    expect(rationaleReady('x'.repeat(RATIONALE_MIN_CHARS))).toBe(true);
    expect(rationaleReady('x'.repeat(RATIONALE_MIN_CHARS - 1))).toBe(false);
    expect(rationaleHint('abc')).toBe('还差 27 字');
    expect(rationaleHint('x'.repeat(RATIONALE_MIN_CHARS))).toBe('提交自证');
  });
});
