/**
 * 反链增强的纯函数：位置 / 分类 / 修复建议 / 忽略清单。
 *
 * 这些判据都来自真实使用场景：「这条引用在原文哪一句」「名字改了所以链断了」
 * 「修的时候别把 #锚点 和 |别名 吃掉」。
 */
import { describe, expect, it } from 'vitest';
import {
  applyLinkFix,
  backlinkSummary,
  classifyBacklink,
  collectBacklinkHits,
  contextWindow,
  editDistance,
  ignoreKey,
  lineOfIndex,
  scanWikiOccurrences,
  splitIgnored,
  suggestTarget,
} from '../backlinks';

describe('scanWikiOccurrences', () => {
  it('普通链接 / 别名 / 锚点都拆对', () => {
    const occ = scanWikiOccurrences('见 [[心衰|心功能]] 与 [[心衰#治疗]] 与 [[心衰#^abc]]');
    expect(occ.map((o) => [o.target, o.label, o.anchor])).toEqual([
      ['心衰', '心功能', ''],
      ['心衰', '', '治疗'],
      ['心衰', '', '^abc'],
    ]);
  });

  it('跳过嵌入语法 ![[图.png]]', () => {
    expect(scanWikiOccurrences('![[图.png]] [[心衰]]')).toHaveLength(1);
  });

  it('跨行不匹配（未闭合的 [[ 不吞正文）', () => {
    expect(scanWikiOccurrences('[[心衰\n]]')).toHaveLength(0);
  });

  it('记录字符偏移与原文', () => {
    const [o] = scanWikiOccurrences('abc [[心衰]] def');
    expect(o.index).toBe(4);
    expect(o.raw).toBe('[[心衰]]');
    expect(o.length).toBe(6);
  });
});

describe('上下文与行号', () => {
  const text = '第一行\n' + '一'.repeat(60) + '[[心衰]]' + '二'.repeat(60) + '\n第三行';
  const idx = text.indexOf('[[心衰]]');

  it('前后各 40 字，超长补省略号', () => {
    const c = contextWindow(text, idx, 6, 40);
    expect(c.match).toBe('[[心衰]]');
    expect(c.before.startsWith('…')).toBe(true);
    expect(c.before.length).toBeLessThanOrEqual(41);
    expect(c.after.endsWith('…')).toBe(true);
  });

  it('空白折叠', () => {
    const c = contextWindow('a   b   [[x]]   c', 8, 5, 20);
    expect(c.before).toBe('a b');
    expect(c.after).toBe('c');
  });

  it('行号按换行计', () => {
    expect(lineOfIndex(text, idx)).toBe(2);
  });
});

describe('collectBacklinkHits', () => {
  const docs = new Map<string, string>([
    ['内科/心衰.md', '# 心衰\n讲泵血'],
    ['内科/心律失常.md', '# 心律失常\n见 [[心衰]] 的前负荷'],
    ['外科/夹层.md', '# 夹层\n见 [[心衰#治疗|治疗要点]]'],
  ]);
  const resolve = (name: string) => (name === '心衰' ? '内科/心衰.md' : null);

  it('收集指向当前笔记的引用，带上下文与行号', () => {
    const hits = collectBacklinkHits('内科/心衰.md', docs, resolve);
    expect(hits).toHaveLength(2);
    const hit = hits.find((h) => h.fromPath === '内科/心律失常.md')!;
    expect(hit.kind).toBe('link');
    expect(hit.line).toBe(2);
    expect(hit.excerpt.match).toBe('[[心衰]]');
    expect(hit.excerpt.before).toContain('见');
  });

  it('目标名等于当前标题但解析不到 → 标记 unresolved', () => {
    const broken = new Map(docs);
    broken.set('外科/夹层.md', '# 夹层\n见 [[心衰]]'); // resolve 仍会解析到心衰
    const noResolve = () => null;
    const hits = collectBacklinkHits('内科/心衰.md', broken, noResolve, ['心衰']);
    const unresolved = hits.filter((h) => h.kind === 'unresolved');
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('解析器抛错时退化为 unresolved，不冒泡', () => {
    const hits = collectBacklinkHits('内科/心衰.md', docs, () => {
      throw new Error('boom');
    }, ['心衰']);
    expect(hits.every((h) => h.kind === 'unresolved')).toBe(true);
  });

  it('不把笔记自身算成反链', () => {
    const self = new Map(docs);
    self.set('内科/心衰.md', '# 心衰\n自引用 [[心衰]]');
    const hits = collectBacklinkHits('内科/心衰.md', self, resolve);
    expect(hits.some((h) => h.fromPath === '内科/心衰.md')).toBe(false);
  });

  it('块引用单独分类', () => {
    const block = new Map(docs);
    block.set('外科/夹层.md', '见 [[心衰#^abc]]');
    const hits = collectBacklinkHits('内科/心衰.md', block, resolve);
    expect(hits.find((h) => h.fromPath === '外科/夹层.md')!.kind).toBe('block');
  });
});

describe('classifyBacklink', () => {
  it('未解析一律 unresolved，即使带锚点', () => {
    expect(classifyBacklink('#x', false)).toBe('unresolved');
    expect(classifyBacklink('^abc', true)).toBe('block');
    expect(classifyBacklink('治疗', true)).toBe('link');
  });
});

describe('修复建议', () => {
  const names = ['心衰', '心律失常', '室上速 vs 室速', '心肌梗死'];

  it('完全匹配优先', () => {
    expect(suggestTarget('心衰', names)).toBe('心衰');
  });

  it('包含关系取最短候选', () => {
    expect(suggestTarget('心律失常', names)).toBe('心律失常');
    expect(suggestTarget('心律', names)).toBe('心律失常');
  });

  it('编辑距离在阈值内才给建议', () => {
    expect(suggestTarget('心肌梗塞', names)).toBe('心肌梗死');
    expect(suggestTarget('完全不相干的东西', names)).toBeNull();
  });

  it('空目标不给建议', () => {
    expect(suggestTarget('  ', names)).toBeNull();
  });

  it('编辑距离本身正确', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('替换时保留 #锚点 与 |别名', () => {
    const body = '前 [[心衰#治疗|要点]] 后';
    const [occ] = scanWikiOccurrences(body);
    expect(applyLinkFix(body, occ, '心力衰竭')).toBe('前 [[心力衰竭#治疗|要点]] 后');
  });

  it('越界索引不抛（防御性）', () => {
    const body = '[[x]]';
    expect(() => applyLinkFix(body, { index: 999, raw: '[[x]]', anchor: '', label: '', target: 'x' }, 'y')).not.toThrow();
  });
});

describe('忽略清单与摘要', () => {
  const docs = new Map([['a.md', '[[心衰]] 与 [[心衰|泵血]]']]);
  const hits = collectBacklinkHits('心衰.md', docs, (n) => (n === '心衰' ? '心衰.md' : null), ['心衰']);

  it('忽略键带来源路径（同一篇里的同一条）', () => {
    expect(ignoreKey(hits[0])).toBe('a.md::[[心衰]]');
  });

  it('按忽略清单拆分', () => {
    const { active, hidden } = splitIgnored(hits, [ignoreKey(hits[0])]);
    expect(active).toHaveLength(hits.length - 1);
    expect(hidden).toHaveLength(1);
  });

  it('同一篇里原文完全相同的两条共用一个忽略键（已知取舍：键要跟编辑走，不能用行号）', () => {
    const same = new Map([['b.md', '[[心衰]] 与 [[心衰]]']]);
    const two = collectBacklinkHits('心衰.md', same, (n) => (n === '心衰' ? '心衰.md' : null), ['心衰']);
    expect(ignoreKey(two[0])).toBe(ignoreKey(two[1]));
    expect(splitIgnored(two, [ignoreKey(two[0])]).hidden).toHaveLength(2);
  });

  it('摘要数出块引用与失效', () => {
    expect(backlinkSummary([])).toBe('0 条引用');
    expect(backlinkSummary(hits)).toBe('2 条引用');
  });
});
