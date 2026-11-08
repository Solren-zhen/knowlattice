/**
 * 生成内容 grounding：模型写的 [[双链]] 必须指向真实笔记。
 *
 * 这条规则的代价是「模型多查一次」，收益是「用户库里不会留下凭印象编的坏链」。
 */
import { describe, expect, it } from 'vitest';
import { extractWikilinkTargets, groundingIssue, missingLinksMessage, missingWikilinks } from '../grounding';
import { studyLogEntryFromArgs } from '../aiStudyLog';

const EXISTS = new Set(['心衰', '内科/心衰', '心律失常', '室上速 vs 室速']);

describe('extractWikilinkTargets', () => {
  it('普通链接 / 别名 / 锚点都只取目标', () => {
    expect(extractWikilinkTargets('见 [[心衰]]、[[心律失常|心律]]、[[心衰#治疗]]')).toEqual(['心衰', '心律失常']);
  });

  it('去重且保序', () => {
    expect(extractWikilinkTargets('[[b]] [[a]] [[b]]')).toEqual(['b', 'a']);
  });

  it('空链接与嵌入语法不产生目标', () => {
    expect(extractWikilinkTargets('[[ ]] ![[图片.png]]')).toEqual([]);
  });

  it('跨行不吞内容（`[[` 未闭合时不匹配）', () => {
    expect(extractWikilinkTargets('[[心衰\n]]')).toEqual([]);
  });
});

describe('missingWikilinks', () => {
  it('全部存在 → 空数组', () => {
    expect(missingWikilinks(['[[心衰]] 与 [[心律失常]]'], { resolve: (t) => EXISTS.has(t) })).toEqual([]);
  });

  it('编出来的名字被抓出来', () => {
    expect(missingWikilinks(['[[不存在的笔记]]'], { resolve: (t) => EXISTS.has(t) })).toEqual(['不存在的笔记']);
  });

  it('没给 resolve 时不假装校验过（否则会拦掉一切）', () => {
    expect(missingWikilinks(['[[随便什么]]'])).toEqual([]);
  });

  it('索引实现抛错按「无法确认」处理，不冒泡', () => {
    expect(
      missingWikilinks(['[[x]]'], {
        resolve: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual(['x']);
  });
});

describe('错误文案', () => {
  it('列出前 3 个并给下一步动作', () => {
    const msg = missingLinksMessage(['a', 'b', 'c', 'd']);
    expect(msg).toContain('「a」、「b」、「c」');
    expect(msg).toContain('等 4 个');
    expect(msg).toContain('search_notes');
  });
});

describe('propose_study_log 接线', () => {
  const args = (weak: string[]) => ({ topic: '心力衰竭', weak_points: weak });

  it('链接都能解析 → 正常返回条目', () => {
    const out = studyLogEntryFromArgs(args(['[[心衰]] 的前后负荷']), { resolve: (t) => EXISTS.has(t) });
    expect(typeof out).toBe('object');
    expect((out as { weakPoints: string[] }).weakPoints[0]).toContain('心衰');
  });

  it('编了一个不存在的笔记 → 返回错误文案而不是落库', () => {
    const out = studyLogEntryFromArgs(args(['[[心肌淀粉样变]] 的分型']), { resolve: (t) => EXISTS.has(t) });
    expect(typeof out).toBe('string');
    expect(out).toContain('不存在');
    expect(out).toContain('心肌淀粉样变');
  });

  it('不传 resolve 时保持原行为（不引入回归）', () => {
    const out = studyLogEntryFromArgs(args(['[[任何名字]]']));
    expect(typeof out).toBe('object');
  });

  it('summary / drill 里的坏链也要拦', () => {
    const out = studyLogEntryFromArgs(
      { ...args(['[[心衰]]']), summary: '再看 [[室速鉴别]]' },
      { resolve: (t) => EXISTS.has(t) },
    );
    expect(typeof out).toBe('string');
    expect(out).toContain('室速鉴别');
  });

  it('grounding 失败时不影响原有必填校验的顺序', () => {
    expect(studyLogEntryFromArgs({}, { resolve: () => false })).toContain('topic');
    expect(studyLogEntryFromArgs({ topic: 'x' }, { resolve: () => false })).toContain('weak_points');
  });

  it('groundingIssue 是 pure 入口（学习日志之外也能复用）', () => {
    expect(groundingIssue(['[[心衰]]'], { resolve: (t) => EXISTS.has(t) })).toBeNull();
    expect(groundingIssue(['[[坏链]]'], { resolve: (t) => EXISTS.has(t) })).toContain('坏链');
  });
});
