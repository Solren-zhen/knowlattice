// @vitest-environment jsdom
/**
 * 首页（没打开笔记时那一屏）的文案纪律与排版断言。
 *
 * 首屏在 2026-10 做过两次减法：品牌图腾、能力标签行、副标题、格式键与底部快捷键全部移出，
 * 只留标题 / 两个入口 / 一行键位提示。这个测试盯住剩下的部分：
 * 每条提示 ≤ 10 字（旧的 5 行网格曾被 40+ 字的长文案撑成三行），以及被删掉的块不会再长回来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import Preview from '../Preview';

afterEach(cleanup);

describe('首页 hero · 文案与排版', () => {
  /** 计「词」不计分隔符：'加粗 / 高亮 / 斜体 / 双链' 是四个词的并列，空格与斜杠不该算进长度。 */
  const wordLen = (s: string) => s.replace(/[\s/·、,，]/g, '').length;

  it('键位提示一行只说一件事：四条，每条 ≤ 10 个字', () => {
    const { container } = render(<Preview content={null} />);

    const spans = [...container.querySelectorAll('.teach-strip span')];
    expect(spans.length).toBe(4);
    for (const s of spans) {
      const text = s.textContent ?? '';
      expect(wordLen(text), `键位提示「${text}」太长了（${wordLen(text)} 字）`).toBeLessThanOrEqual(10);
    }
  });

  it('首页不再出现品牌图腾、副标题与能力标签行', () => {
    const { container } = render(<Preview content={null} />);

    expect(container.querySelector('.hero-brand')).toBeNull();
    expect(container.querySelector('.hero-sub')).toBeNull();
    expect(container.querySelector('.hero-proof')).toBeNull();
  });
});
