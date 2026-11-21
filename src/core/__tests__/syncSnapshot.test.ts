import { describe, expect, it, beforeEach } from 'vitest';
import {
  applySnapshot, buildSnapshot, parseSnapshot, reportLine, snapshotToJson,
  SNAPSHOT_PARTS, SNAPSHOT_VERSION,
} from '../syncSnapshot';
import { importDays } from '../stats';
import { loadMistakes } from '../mistakes';

describe('syncSnapshot', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('打包 → JSON → 解析 → 合并，学习天数原样回来', async () => {
    importDays({ '2026-11-10': 42 });
    const snap = await buildSnapshot(['studyDays']);
    expect(snap.kind).toBe('study-snapshot');
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    const parsed = parseSnapshot(snapshotToJson(snap));
    importDays({});
    const report = await applySnapshot(parsed, ['studyDays']);
    expect(report.applied.map((a) => a.key)).toEqual(['studyDays']);
    const back = await buildSnapshot(['studyDays']);
    expect(back.parts.studyDays).toEqual({ '2026-11-10': 42 });
  });

  it('错题按合并语义导入，重复导入不会翻倍', async () => {
    const seed = {
      'a.md': { path: 'a.md', chapter: '一', title: 't', count: 2, lastFailedAt: 1, stage: 1, dueAt: 1 },
    };
    const snap = { app: 'knowlattice' as const, kind: 'study-snapshot' as const, version: 1, exportedAt: 0, parts: { mistakes: seed } };
    await applySnapshot(snap, ['mistakes']);
    await applySnapshot(snap, ['mistakes']);
    expect(loadMistakes()['a.md'].count).toBe(2);
  });

  it('快照里没带的部件记进 missing，不是失败', async () => {
    const snap = parseSnapshot(JSON.stringify({ kind: 'study-snapshot', version: 1, parts: { studyDays: {} } }));
    const report = await applySnapshot(snap, ['studyDays', 'todos']);
    expect(report.applied.map((a) => a.key)).toEqual(['studyDays']);
    expect(report.missing).toEqual(['todos']);
    expect(report.failed).toEqual([]);
    expect(reportLine(report)).toContain('1 类未包含');
  });

  it('单个部件写失败不影响其它部件，并进 failed 报告', async () => {
    let calls = 0;
    const parts: Record<string, unknown> = {};
    for (const part of SNAPSHOT_PARTS) parts[part.key] = {};
    const snap = { app: 'knowlattice' as const, kind: 'study-snapshot' as const, version: 1, exportedAt: 0, parts };
    // 让 studyDays 的写入抛错：模拟某类数据损坏
    const origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k: string, v: string) => {
      if (k === 'knowlattice-days') { calls += 1; throw new Error('quota'); }
      origSet(k, v);
    };
    const report = await applySnapshot(snap);
    localStorage.setItem = origSet;
    expect(calls).toBeGreaterThan(0);
    expect(report.failed.some((f) => f.key === 'studyDays')).toBe(true);
    expect(report.applied.length).toBeGreaterThan(0);
  });

  it('解析器拒绝非快照文件与损坏 JSON', () => {
    expect(() => parseSnapshot('{')).toThrow('不是合法的 JSON');
    expect(() => parseSnapshot('{"kind":"other","parts":{}}')).toThrow('kind');
    expect(() => parseSnapshot('{"kind":"study-snapshot"}')).toThrow('parts');
    expect(() => parseSnapshot('{"kind":"study-snapshot","parts":{},"version":99}')).toThrow('更新的版本');
  });
});
