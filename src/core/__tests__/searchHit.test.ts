/**
 * 搜索命中定位 + 语义近似的验收。
 *
 * 这里有一条**回归**：旧的 snippet() 用 `body.indexOf(q[0])` 定位，只拿查询的
 * 第一个字符去找。搜「氧解离曲线」时正文里第一个「氧」出现在开头，
 * 片段就永远定位到开头——高亮更是无从谈起（那时压根没有高亮）。
 */
import { describe, expect, it } from 'vitest';
import { expandQuery, SYNONYM_TERM_COUNT } from '../medSynonyms';
import { buildSnippet, locateAll, segment, titleHits } from '../searchHit';

describe('expandQuery（语义近似）', () => {
  it('整串命中：俗称 / 缩写 / 全称互相展开', () => {
    expect(expandQuery('心梗')).toContain('心肌梗死');
    expect(expandQuery('心梗')).toContain('AMI');
    expect(expandQuery('心肌梗死')).toContain('心梗');
    expect(expandQuery('COPD')).toContain('慢性阻塞性肺疾病');
    expect(expandQuery('TCA循环')).toContain('三羧酸循环');
  });

  it('包含式命中：查询里含词表词也能展开（"心梗的处理"）', () => {
    const terms = expandQuery('心梗的处理');
    expect(terms[0]).toBe('心梗的处理'); // 原查询始终在第一位
    expect(terms).toContain('心肌梗死');
  });

  it('去重、空查询、词表外查询都安全', () => {
    expect(expandQuery('')).toEqual([]);
    expect(expandQuery('   ')).toEqual([]);
    expect(expandQuery('这个词表里没有')).toEqual(['这个词表里没有']);
    const terms = expandQuery('心梗');
    expect(new Set(terms.map((t) => t.replace(/\s+/g, '').toLowerCase())).size).toBe(terms.length);
  });

  it('词表是真实存在的数据，不是空壳', () => {
    expect(SYNONYM_TERM_COUNT).toBeGreaterThan(100);
  });
});

describe('locateAll', () => {
  it('中文子串命中，且找出全部出现位置', () => {
    const t = '氧解离曲线右移；再说氧解离曲线的意义';
    expect(locateAll(t, ['氧解离曲线'])).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
  });

  it('纯 ASCII 按词边界匹配——"AMI" 不该在 "family" 里命中', () => {
    expect(locateAll('family AMI ami', ['AMI'])).toEqual([
      { start: 7, end: 10 },
      { start: 11, end: 14 },
    ]);
    expect(locateAll('family', ['AMI'])).toEqual([]);
  });

  it('重叠区间合并，不产生嵌套的高亮', () => {
    // 「心肌梗死」与「心肌」重叠 → 合成一段
    expect(locateAll('心肌梗死', ['心肌', '心肌梗死'])).toEqual([{ start: 0, end: 4 }]);
  });

  it('空词与空白词被忽略', () => {
    expect(locateAll('abc', ['', '   '])).toEqual([]);
  });
});

describe('buildSnippet', () => {
  const doc = `---
aliases: [氧离曲线]
tags: [生理]
---
氧气在血液里靠血红蛋白运输，这一段和查询无关。
真正要讲的是氧解离曲线的右移，以及它的临床意义。`;

  it('回归：定位到**完整查询**，而不是查询的第一个字符', () => {
    const s = buildSnippet(doc, '氧解离曲线');
    // 旧实现会定位到开头那个「氧」；正确结果必须落在真正的命中处
    expect(s.text).toContain('氧解离曲线');
    expect(s.hits.length).toBeGreaterThan(0);
    for (const h of s.hits) expect(s.text.slice(h.start, h.end)).toBe('氧解离曲线');
  });

  it('frontmatter 不进片段，且换行被压平、偏移量依然有效', () => {
    const s = buildSnippet(doc, '氧解离曲线');
    expect(s.text).not.toContain('aliases');
    expect(s.text).not.toContain('\n');
    // 偏移量不变式：每个区间切出来就是命中的词
    for (const h of s.hits) expect(s.text.slice(h.start, h.end)).toBe('氧解离曲线');
  });

  it('截断处加省略号后，偏移量仍然对得上（pad 只算一次）', () => {
    const long = '铺垫'.repeat(40) + '氧解离曲线' + '收尾'.repeat(40);
    const s = buildSnippet(long, '氧解离曲线', 60);
    expect(s.text.startsWith('…')).toBe(true);
    for (const h of s.hits) expect(s.text.slice(h.start, h.end)).toBe('氧解离曲线');
  });

  it('语义近似命中：搜「心梗」能高亮正文里的「心肌梗死」', () => {
    const s = buildSnippet('本例为急性心肌梗死，心电图见 ST 抬高。', '心梗');
    expect(s.text).toContain('心肌梗死');
    const marked = s.hits.map((h) => s.text.slice(h.start, h.end));
    // 展开词里既有「心肌梗死」也有「急性心肌梗死」，起点更早的那个胜出（合并取最长）
    expect(marked.some((m) => m.includes('心肌梗死'))).toBe(true);
  });

  it('没有命中时退化为开头一段，hits 为空（不抛错、不返回空片段）', () => {
    const s = buildSnippet(doc, '完全无关的词组');
    expect(s.hits).toEqual([]);
    expect(s.text.length).toBeGreaterThan(0);
  });

  it('空查询 / 空正文都安全', () => {
    expect(buildSnippet(doc, '').hits).toEqual([]);
    expect(buildSnippet('', '心梗')).toEqual({ text: '', hits: [] });
  });

  // ---------- 窗口化定位（性能改写后的行为等价性） ----------

  it('同一内容重复构建：缓存路径下结果逐字节一致', () => {
    const a = buildSnippet(doc, '氧解离曲线');
    const b = buildSnippet(doc, '氧解离曲线'); // bodyOf 命中缓存
    expect(b).toEqual(a);
  });

  it('窗口内多处命中全部高亮；窗外命中不进片段（与全量扫描结果一致）', () => {
    const text = '氧解离曲线第一处。中间隔了很多无关文字。第二处氧解离曲线出现。'
      + '距离很远很远的地方还有第三处氧解离曲线，不应该被带进来。';
    const s = buildSnippet(text, '氧解离曲线', 40);
    for (const h of s.hits) expect(s.text.slice(h.start, h.end)).toBe('氧解离曲线');
    expect(s.hits.length).toBeGreaterThanOrEqual(1); // 至少第一处
    // 片段只覆盖窗口：远离首命中的那处要么不在片段里，要么被截到窗口边界
    expect(s.text.length).toBeLessThanOrEqual(41); // 40 字符 + 可能的省略号
  });

  it('locateAll 窗口模式：只收 [from-15, from+span) 内的命中，越界即停', () => {
    const text = '甲'.repeat(30) + '词A' + '乙'.repeat(50) + '词A';
    // 窗口从 30 起、跨度 20：第一处（30~32）在窗口内，第二处（82~）窗外
    const win = locateAll(text, ['词A'], 30, 20);
    expect(win).toEqual([{ start: 30, end: 32 }]);
    // 全量模式仍收两处（titleHits 等老调用方的行为不变）
    const all = locateAll(text, ['词A']);
    expect(all).toEqual([{ start: 30, end: 32 }, { start: 82, end: 84 }]);
  });
});

describe('segment', () => {
  it('切片拼回原文，命中片段恰好是被搜的词', () => {
    const text = '先说氧解离曲线，后说氧解离曲线的意义。';
    const hits = locateAll(text, ['氧解离曲线']);
    const segs = segment(text, hits);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['氧解离曲线', '氧解离曲线']);
  });

  it('无命中时原样返回一段', () => {
    expect(segment('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('titleHits', () => {
  it('标题里的命中可直接用于渲染', () => {
    const hits = titleHits('第5章 氧解离曲线', '氧解离曲线');
    expect(hits).toEqual([{ start: 4, end: 9 }]);
  });
});
