/**
 * Callout 语法解析：用户的 Obsidian 库里 1500+ 处，写法是
 *   `> [!warning] 网络问题`、`> [!question]- 为什么…`、`>> [!note] 嵌套`
 * 认不出来的话，编辑器里就只剩一条普通引用（颜色/标题都没了）。
 */
import { describe, expect, it } from 'vitest';
import { calloutLabel, isKnownCalloutType, parseCallout } from '../callout';

describe('parseCallout', () => {
  it('类型 + 同一行的自定义标题', () => {
    expect(parseCallout('> [!warning] 网络问题')).toEqual({ type: 'warning', title: '网络问题', fold: null });
  });

  it('没有标题时只用类型的默认名（title 为空）', () => {
    expect(parseCallout('> [!note]')).toEqual({ type: 'note', title: '', fold: null });
  });

  it('折叠标记：`-` 折叠 / `+` 展开', () => {
    expect(parseCallout('> [!question]- 为什么图像用 512 维？')?.fold).toBe('closed');
    expect(parseCallout('> [!goal]+ 🎯 本篇学习要求')?.fold).toBe('open');
  });

  it('类型名大小写归一，允许横线（如 [!bug-report]）', () => {
    expect(parseCallout('> [!WARNING] x')?.type).toBe('warning');
    expect(parseCallout('> [!bug-report] x')?.type).toBe('bug-report');
  });

  it('嵌套引用与 `> ` 无空格都认', () => {
    expect(parseCallout('>> [!tip] 双保险')?.type).toBe('tip');
    expect(parseCallout('>[!example]紧凑写法')?.type).toBe('example');
    expect(parseCallout('  >  [!info]   前后空格  ')?.title).toBe('前后空格');
  });

  it('普通引用、代码里的尖括号、缺类型的方括号都不算 callout', () => {
    expect(parseCallout('> 这是一句普通引用')).toBeNull();
    expect(parseCallout('> [x] 不是 callout')).toBeNull();
    expect(parseCallout('> [!]')).toBeNull();
    expect(parseCallout('正文 [!note] 不在引用里')).toBeNull();
  });
});

describe('calloutLabel', () => {
  it('常见类型给中文默认名（与界面语言一致）', () => {
    expect(calloutLabel('question')).toBe('问题');
    expect(calloutLabel('success')).toBe('成功');
    expect(calloutLabel('warning')).toBe('注意');
    expect(calloutLabel('abstract')).toBe('摘要');
  });

  it('没收录的类型原样显示，不编造', () => {
    expect(calloutLabel('bug-report')).toBe('bug-report');
    expect(isKnownCalloutType('bug-report')).toBe(false);
    expect(isKnownCalloutType('warning')).toBe(true);
  });
});
