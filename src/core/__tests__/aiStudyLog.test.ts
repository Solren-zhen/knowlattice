import { describe, expect, it } from 'vitest';
import {
  appendStudyLogEntry, studyLogEntryFromArgs, studyLogPath,
} from '../aiStudyLog';
import { buildCards } from '../srsCards';

/** 固定时刻的 Date（本地时区构造，断言不受运行环境时区影响） */
const at = (h: number, m: number): Date => new Date(2026, 9, 11, h, m);

describe('studyLogPath', () => {
  it('按本地日期生成 学习日志/YYYY-MM-DD.md，月日补零', () => {
    expect(studyLogPath(at(9, 5))).toBe('学习日志/2026-10-11.md');
    expect(studyLogPath(new Date(2026, 0, 3, 23, 59))).toBe('学习日志/2026-01-03.md');
  });
});

describe('appendStudyLogEntry', () => {
  it('没有日志时先建文档：frontmatter 带 学习日志 标签 + H1 + 首个小节', () => {
    const doc = appendStudyLogEntry(undefined, {
      topic: '心力衰竭的前后负荷',
      weakPoints: ['前后负荷概念混淆（[[解剖/心脏]]）'],
      drill: '3 题对 2 题，错在洋地黄中毒的处理顺序',
      summary: '先利尿后强心',
    }, at(21, 34));
    expect(doc).toContain('tags: [学习日志]');
    expect(doc).toContain('# 学习日志 2026-10-11');
    expect(doc).toContain('## 21:34 心力衰竭的前后负荷');
    expect(doc).toContain('- 薄弱点：前后负荷概念混淆（[[解剖/心脏]]）');
    expect(doc).toContain('- 练习：3 题对 2 题，错在洋地黄中毒的处理顺序');
    expect(doc).toContain('- 小结：先利尿后强心');
  });

  it('已有日志只追加小节：原有内容一字不动，新小节在末尾', () => {
    const existing = appendStudyLogEntry(undefined, { topic: '肾小球肾炎', weakPoints: ['分型记不清'] }, at(8, 0));
    const doc = appendStudyLogEntry(existing, { topic: '心律失常', weakPoints: ['室上速 vs 室速'] }, at(20, 5));
    expect(doc).toContain('## 08:00 肾小球肾炎');
    expect(doc).toContain('## 20:05 心律失常');
    expect(doc.indexOf('## 08:00')).toBeLessThan(doc.indexOf('## 20:05'));
    // 追加不覆盖：早上的条目和 frontmatter 原样保留
    expect(doc).toContain('- 薄弱点：分型记不清');
  });

  it('可选字段缺省时不留空行项；主题去掉 # 前缀、只取一行', () => {
    const doc = appendStudyLogEntry(undefined, { topic: '## 洋地黄中毒\n的处理', weakPoints: [] }, at(9, 9));
    expect(doc).toContain('## 09:09 洋地黄中毒');
    expect(doc).not.toContain('的处理');
    expect(doc).not.toContain('- 练习：');
    expect(doc).not.toContain('- 小结：');
  });
});

describe('studyLogEntryFromArgs', () => {
  it('正常参数：weakPoints 去重、去空，可选字段收窄', () => {
    const e = studyLogEntryFromArgs({
      topic: ' 电解质紊乱 ',
      weak_points: ['低钾血症心电图', '', '低钾血症心电图', '  '],
      drill: ' ',
      summary: '先补钾后补镁',
    });
    expect(e).toEqual({
      topic: '电解质紊乱',
      weakPoints: ['低钾血症心电图'],
      drill: undefined,
      summary: '先补钾后补镁',
    });
  });

  it('缺 topic 或 weak_points 全空时返回给模型的错误文案', () => {
    expect(studyLogEntryFromArgs({ weak_points: ['x'] })).toContain('topic');
    expect(studyLogEntryFromArgs({ topic: 'x' })).toContain('weak_points');
    expect(studyLogEntryFromArgs({ topic: 'x', weak_points: ['  '] })).toContain('weak_points');
  });
});

describe('系统目录不进复习队列', () => {
  it('学习日志与 AI命令 下的笔记不会被 buildCards 切成卡', () => {
    const docs = new Map([
      ['学习日志/2026-10-11.md', '# 学习日志 2026-10-11\n\n## 21:34 心力衰竭\n\n- 薄弱点：前后负荷\n'],
      ['AI命令/出题.md', '你是出题人。围绕主题出 3-5 道自测题。'],
      ['解剖/心脏.md', '# 心脏\n\n## 生理\n\n泵血。'],
    ]);
    const cards = buildCards([...docs.keys()], docs);
    expect(cards.map((c) => c.path)).toEqual(['解剖/心脏.md']);
  });
});
