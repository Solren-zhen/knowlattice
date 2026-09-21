// @vitest-environment jsdom
/**
 * 用**真实产物**验收最险的一段路：把 39.6 MB / 1137 篇笔记的题库备份喂给 importBackup。
 *
 * 大文件 + 上千次落盘，不跑一遍就不知道会不会挂；跑一遍才知道 `{ok, failed}` 到底是多少。
 * 产物在仓库外，不存在就整体跳过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  written: new Map<string, string>(),
  existing: new Map<string, string>(),
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [...h.existing.keys()];
    readAll = async () => new Map(h.existing);
    read = async (p: string) => h.existing.get(p) ?? '';
    exists = async (p: string) => h.existing.has(p);
    write = async (p: string, c: string) => { h.written.set(p, c); h.existing.set(p, c); };
    remove = async (p: string) => { h.existing.delete(p); };
    readAllAttachments = async () => new Map<string, Blob>();
    writeAttachment = async () => {};
    removeAttachment = async () => {};
  },
}));

const { useVault } = await import('../vault');

const OUT = process.env.KNOWLATTICE_QBANK_OUT
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Desktop', 'KNOWLATTICE');
const NAME = 'knowlattice-导入-医考帮题库.json';
const have = existsSync(join(OUT, NAME));

let text = '';

function Probe() {
  const v = useVault();
  const [result, setResult] = useState('');
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <button onClick={() => { void v.importBackup(text).then((r) => setResult(`${r.ok}/${r.failed}`)); }}>导入</button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  h.written = new Map();
  h.existing = new Map();
});

afterEach(() => cleanup());

describe.skipIf(!have)('题库笔记备份：整包导入', () => {
  it('1137 篇笔记全部落盘，一篇不丢，正文带 frontmatter 和原题', async () => {
    const raw = JSON.parse(readFileSync(join(OUT, NAME), 'utf8')) as { files: { path: string; content: string }[] };
    text = readFileSync(join(OUT, NAME), 'utf8');

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导入'));
    await waitFor(
      () => expect(screen.getByTestId('result').textContent).toBe(`${raw.files.length}/0`),
      { timeout: 120_000 }
    );

    const files = raw.files as { path: string; content: string }[];
    // 逐篇比对内容：1137 篇一篇不差、一字不差（比数量断言更严，也不受空库播种的欢迎笔记影响）
    const missing = files.filter((f) => h.written.get(f.path) !== f.content);
    expect(missing.map((f) => f.path).slice(0, 5)).toEqual([]);
    expect(h.written.size).toBeGreaterThanOrEqual(files.length);
    // 抽查一篇：路径按 题库/<源>/<学科>/<章节>.md，正文是 frontmatter + H1 + 原题
    const sample = h.written.get('题库/医考帮/外科学/第一章 绪论.md');
    expect(sample).toBeDefined();
    expect(sample!.startsWith('---\n')).toBe(true);
    expect(sample!).toContain('\n# 第一章 绪论');
    expect(sample!).toContain('【A1】');
    expect(sample!).toContain('答案：');
    expect(sample!).toContain('解析：');
  });
});
