import { describe, expect, it } from 'vitest';
import { buildCards, cardHints, splitNoteIntoCards } from '../srsCards';

/** 真实笔记的骨架（取自 内科学/7 循环系统/7.8 心律失常… 的缩略版） */
const NOTE = `---
aliases: [心律失常, 心脏骤停]
tags: [内科学, 循环系统]
chapter: 内科学·循环系统
source: 26精编版笔记（内科学 7.8）
exam: [2023N45]
created: 2026-09-17
---

# 7.8 心律失常全+心脏骤停

- 主线: ==心律失常==（首选心电图→机制）
- 性感认识: 心肺脑复苏 ==C→A→B==

## 考频

- 题型分布: A 型为主

## 一、首选检查——心电图

- 首选: 心电图
- 机制: 自律性异常

### 1.心电图诊断

- 适用范围: 心律失常、心绞痛

## 二、正常心电图

- 一小格: 0.04s
`;

describe('splitNoteIntoCards · 按小节切卡', () => {
  const cards = splitNoteIntoCards('内科学/7.8 心律失常全+心脏骤停.md', NOTE);

  it('有 ## 时按 ## 切，### 留在所属小节里（不单独成卡）', () => {
    expect(cards.map((c) => c.heading)).toEqual(['总览', '考频', '一、首选检查——心电图', '二、正常心电图']);
  });

  it('第一个小节标题之前的正文成为「总览」卡', () => {
    const intro = cards[0];
    expect(intro.heading).toBe('总览');
    expect(intro.body).toContain('主线');
    expect(intro.body).not.toContain('## 考频');
  });

  it('每张卡只含本小节正文（### 子标题连内容一起带上）', () => {
    const sec = cards.find((c) => c.heading === '一、首选检查——心电图')!;
    expect(sec.body).toContain('首选: 心电图');
    expect(sec.body).toContain('### 1.心电图诊断');
    expect(sec.body).toContain('适用范围: 心律失常');
    // 不能串到下一节
    expect(sec.body).not.toContain('一小格');
  });

  it('卡键 = 路径 + 小节标题（改名=新卡，重排序不串卡）', () => {
    expect(cards[2].key).toBe('内科学/7.8 心律失常全+心脏骤停.md#一、首选检查——心电图');
    // 同一篇所有卡键互不相同，且都不是裸路径
    expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
    expect(cards.every((c) => c.key !== c.path)).toBe(true);
  });

  it('首张卡带上旧的整篇卡键（迁移用），其余不带', () => {
    expect(cards[0].legacyKey).toBe('内科学/7.8 心律失常全+心脏骤停.md');
    expect(cards.slice(1).every((c) => c.legacyKey === undefined)).toBe(true);
  });

  it('正面提示：每张卡带本节的属性键（值不给）', () => {
    expect(cards[0].hints).toEqual(['主线', '性感认识']);
    expect(cards.find((c) => c.heading === '考频')!.hints).toEqual(['题型分布']);
    expect(cards.find((c) => c.heading === '一、首选检查——心电图')!.hints).toEqual(['首选', '机制', '适用范围']);
  });

  it('笔记标题取自 H1，供正面「出自」显示', () => {
    expect(cards[0].noteTitle).toBe('7.8 心律失常全+心脏骤停');
  });
});

describe('splitNoteIntoCards · 边界', () => {
  it('没有 ## 时退回 ###', () => {
    const cards = splitNoteIntoCards('a.md', '# 甲\n\n### 一\n\n- 定义: 甲\n\n### 二\n\n- 定义: 乙\n');
    expect(cards.map((c) => c.heading)).toEqual(['一', '二']);
    expect(cards[0].key).toBe('a.md#一');
  });

  it('完全没有小节标题 → 整篇一张卡，键就是路径（旧数据同键，零迁移）', () => {
    const cards = splitNoteIntoCards('a.md', '# 甲\n\n- 定义: 甲\n');
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe('a.md');
    expect(cards[0].heading).toBe('');
    expect(cards[0].legacyKey).toBeUndefined();
  });

  it('只有标题、没有正文 → 仍出一张整篇卡（别让笔记从队列里消失）', () => {
    const cards = splitNoteIntoCards('a.md', '# 甲\n\n## 一\n\n## 二\n');
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe('a.md');
  });

  it('空小节不出卡，但不影响其它小节', () => {
    const cards = splitNoteIntoCards('a.md', '# 甲\n\n## 空\n\n## 有\n\n- 定义: x\n');
    expect(cards.map((c) => c.heading)).toEqual(['有']);
  });

  it('同名小节补序号，键不冲突', () => {
    const cards = splitNoteIntoCards('a.md', '# 甲\n\n## 同名\n\n- 定义: 1\n\n## 同名\n\n- 定义: 2\n');
    expect(cards.map((c) => c.key)).toEqual(['a.md#同名', 'a.md#同名#2']);
  });

  it('没有 frontmatter 也能切（标题回退文件名）', () => {
    const cards = splitNoteIntoCards('内科学/甲.md', '## 一\n\n- 定义: x\n');
    expect(cards[0].noteTitle).toBe('甲');
    expect(cards[0].heading).toBe('一');
  });

  it('属性键只认「- 键: 」且键里无空格（整句正文不算键）', () => {
    expect(cardHints('- 定义: 甲\n- 这是一个没有冒号键的长句\n- 太长的一个键名称超过十二个字: x\n普通行\n')).toEqual(['定义']);
  });
});

describe('buildCards · 全库建卡', () => {
  it('只取 .md，按传入顺序展开（一篇多卡）', () => {
    const docs = new Map([
      ['a.md', '# 甲\n\n## 一\n\n- 定义: x\n\n## 二\n\n- 定义: y\n'],
      ['b.png', 'binary'],
      ['c.md', '# 丙\n\n- 定义: z\n'],
    ]);
    const cards = buildCards(['a.md', 'b.png', 'c.md'], docs);
    expect(cards.map((c) => c.key)).toEqual(['a.md#一', 'a.md#二', 'c.md']);
  });

  it('缺内容的路径按空笔记处理（仍出一张卡，不会崩）', () => {
    const cards = buildCards(['missing.md'], new Map());
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe('missing.md');
  });
});
