// @vitest-environment jsdom
/**
 * 首页（没打开笔记时那一屏）的文案纪律与排版断言。
 *
 * 为什么要有这个测试：这块文案膨胀过一次——「Alt+A 加粗关键词；Alt+S 高亮重点、Alt+Z 斜体、
 * Alt+X 双链。四个键都挤在左手基准位，一只手就能按」一条 40+ 字，在 2 列网格里被撑成三行、
 * 右边缘参差，首屏被拉长。现在把「一行只说一件事、每条 ≤ 10 字」写成断言，
 * 免得下次又靠自觉。设计理由（为什么这四个键要挤在左手）属于 README，不属于首屏。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import Preview from '../Preview';
import { FORMAT_KEYS } from '../../core/mdFormat';

afterEach(cleanup);

describe('首页 hero · 文案与排版', () => {
  /** 计「词」不计分隔符：'加粗 / 高亮 / 斜体 / 双链' 是四个词的并列，空格与斜杠不该算进长度，
   *  否则规则会逼着把并列项写得更挤。要拦的是「一整句话挤进一格」，不是并列。 */
  const wordLen = (s: string) => s.replace(/[\s/·、,，]/g, '').length;

  it('教学条目一行只说一件事：每条 ≤ 10 个字', () => {
    const { container } = render(<Preview content={null} />);

    const spans = [...container.querySelectorAll('.teach-step span')];
    expect(spans.length).toBe(5);
    for (const s of spans) {
      const text = s.textContent ?? '';
      expect(wordLen(text), `教学条目「${text}」太长了（${wordLen(text)} 字）`).toBeLessThanOrEqual(10);
    }
  });

  it('格式键提示与 FORMAT_KEYS 同源：改了键位首页会跟着变', () => {
    const { container } = render(<Preview content={null} />);

    const hint = [...container.querySelectorAll('.teach-step kbd')].map((k) => k.textContent ?? '').join('|');
    for (const k of Object.values(FORMAT_KEYS)) {
      const letter = k.label.split('+')[1];
      expect(hint, `首页提示里没有 ${k.label}`).toContain(letter);
    }
  });

  it('最后一条教学跨两列（5 个格子在 2 列网格里不再留孤儿格）', () => {
    const { container } = render(<Preview content={null} />);

    const steps = [...container.querySelectorAll('.teach-step')];
    expect(steps[steps.length - 1].classList.contains('wide')).toBe(true);
  });

  it('副标题以三段概括产品价值，不暴露标记语法', () => {
    const { container } = render(<Preview content={null} />);

    const sub = container.querySelector('.hero-sub')?.textContent ?? '';
    expect(sub.split('·').length).toBe(3);
    expect(sub).toBe('笔记沉淀知识 · 层级梳理思路 · 双链串联全局');
    expect(sub).not.toContain('[[');
  });
});
