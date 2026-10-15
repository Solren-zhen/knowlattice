import { beforeEach, describe, expect, it } from 'vitest';
import {
  bumpRecallHits,
  clearRecall,
  exportRecall,
  importRecall,
  loadRecall,
  lookupRecall,
  MAX_RECALL_ENTRIES,
  normalizeQuestion,
  recallCount,
  removeRecall,
  saveRecall,
} from '../localRecall';

beforeEach(() => {
  localStorage.clear();
});

describe('localRecall · 问题归一化', () => {
  it('折叠空白、去首尾、全角转半角、小写', () => {
    expect(normalizeQuestion('  心  输出量  ')).toBe('心 输出量');
    expect(normalizeQuestion('Heart  Rate')).toBe('heart rate');
    // 全角字母经 NFKC 归一，避免"看起来一样却查不到"
    expect(normalizeQuestion('ＡＢＣ')).toBe('abc');
  });

  it('换行与制表符等同普通空白', () => {
    expect(normalizeQuestion('a\tb\nc')).toBe('a b c');
  });
});

describe('localRecall · 命中与保存', () => {
  it('排版差异也能命中同一条', () => {
    saveRecall('解释一下 心输出量', '答案正文');
    expect(lookupRecall('  解释一下   心输出量 ')?.a).toBe('答案正文');
    expect(lookupRecall('完全不相干的问题')).toBeNull();
  });

  it('空问题或空答案不写入', () => {
    saveRecall('', '答案');
    saveRecall('问题', '   ');
    expect(recallCount()).toBe(0);
  });

  it('重复保存同一条会覆盖答案但保留复用计数', () => {
    saveRecall('问', '第一次');
    bumpRecallHits('问');
    saveRecall('问', '第二次');
    const e = lookupRecall('问')!;
    expect(e.a).toBe('第二次');
    expect(e.hits).toBe(1);
  });

  it('原始问题保留给用户看，键是归一化后的', () => {
    saveRecall('  心输出量 是什么 ', 'x');
    const e = lookupRecall('心输出量 是什么')!;
    expect(e.raw).toBe('心输出量 是什么');
    expect(e.q).toBe('心输出量 是什么');
  });

  it('复用计数可累加', () => {
    saveRecall('问', '答');
    bumpRecallHits('问');
    bumpRecallHits('问');
    expect(lookupRecall('问')!.hits).toBe(2);
  });

  it('不存在的键做 bump 不会凭空造记录', () => {
    bumpRecallHits('没有这条');
    expect(recallCount()).toBe(0);
  });

  it('删除与清空', () => {
    saveRecall('a', '1');
    saveRecall('b', '2');
    removeRecall('a');
    expect(lookupRecall('a')).toBeNull();
    expect(recallCount()).toBe(1);
    clearRecall();
    expect(recallCount()).toBe(0);
    expect(loadRecall()).toEqual({});
  });
});

describe('localRecall · 容量上限', () => {
  it('超过上限时淘汰最旧的，不无限增长', () => {
    for (let i = 0; i < MAX_RECALL_ENTRIES + 5; i++) saveRecall(`问题 ${i}`, `答案 ${i}`, 1000 + i);
    expect(recallCount()).toBe(MAX_RECALL_ENTRIES);
    // 前 5 条（时间最早）应被淘汰
    expect(lookupRecall('问题 0')).toBeNull();
    expect(lookupRecall('问题 4')).toBeNull();
    expect(lookupRecall('问题 5')).not.toBeNull();
    expect(lookupRecall(`问题 ${MAX_RECALL_ENTRIES + 4}`)).not.toBeNull();
  });
});

describe('localRecall · 导出与恢复', () => {
  it('导出/恢复往返一致', () => {
    saveRecall('甲', '内容甲');
    const dump = exportRecall();
    clearRecall();
    expect(importRecall(dump)).toBe(1);
    expect(lookupRecall('甲')?.a).toBe('内容甲');
  });

  it('恢复时同问题保留较大的复用计数', () => {
    saveRecall('甲', '旧');
    bumpRecallHits('甲');
    bumpRecallHits('甲');
    importRecall({ 甲: { q: '甲', raw: '甲', a: '新', at: 5, hits: 1 } });
    expect(lookupRecall('甲')!.hits).toBe(2);
    expect(lookupRecall('甲')!.a).toBe('新');
  });

  it('非法输入不写入', () => {
    expect(importRecall(null)).toBe(0);
    expect(importRecall('不是对象')).toBe(0);
    expect(importRecall({ x: { a: '' } })).toBe(0);
    expect(recallCount()).toBe(0);
  });
});
