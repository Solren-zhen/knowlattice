// @vitest-environment jsdom
/**
 * 整包备份回环：导出 → 清空 → 导入，专注记录、待办、打卡都要回来。
 *
 * 专注记录只活在 localStorage 里。备份漏了它，用户换设备就等于白专注——这条链路值得一个测试。
 * 适配器是 vault.ts 的模块级单例，没有注入点，所以照 vault.load.test.tsx 的做法 mock 掉 storage/web。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getAllQuestionStats, resetQbankStorageForTests } from '../../storage/qbank';
import { initializeStats, recordAnswer, resetQbankStatsForTests, statOf } from '../qbankStats';

const h = vi.hoisted(() => ({
  readAll: (async () => new Map<string, string>()) as () => Promise<Map<string, string>>,
  attachments: (async () => new Map<string, Blob>()) as () => Promise<Map<string, Blob>>,
  written: new Map<string, Blob>(),
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.readAll();
    read = async (p: string) => (await h.readAll()).get(p) ?? '';
    exists = async (p: string) => (await h.readAll()).has(p);
    stat = async (p: string) => ((await h.readAll()).has(p) ? { mtime: 0, size: 0 } : null);
    write = async () => {};
    remove = async () => {};
    readAllAttachments = () => h.attachments();
    writeAttachment = async (p: string, b: Blob) => { h.written.set(p, b); };
    removeAttachment = async () => {};
    existsAttachment = async (p: string) => (await h.attachments()).has(p);
  },
}));

const { useVault } = await import('../vault');

let backupText = '';
let captured: Blob | null = null;

function Probe() {
  const v = useVault();
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <button onClick={v.exportAll}>导出</button>
      <button onClick={() => { void v.importBackup(backupText).then((r) => { resultRef.current = r; }); }}>导入</button>
    </div>
  );
}

const store = (key: string): unknown[] => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];

/** 捕获 importBackup 返回值（overwritten 断言用） */
let resultRef: { current: { overwritten?: string[]; ok: number; failed: number } | null } = { current: null };

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
  h.readAll = async () => new Map();
  h.attachments = async () => new Map();
  h.written = new Map();
  backupText = '';
  captured = null;
  resultRef.current = null;
  Object.defineProperty(URL, 'createObjectURL', {
    value: (b: Blob) => { captured = b; return 'blob:test'; }, writable: true, configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
});

afterEach(() => cleanup());

describe('整包备份：专注记录不丢', () => {
  it('导出带上专注记录，清空后导入能回来（待办里的专注次数也一起）', async () => {
    await recordAnswer('备份题库', 'q-1', false, Date.UTC(2026, 0, 15, 9));
    localStorage.setItem('knowlattice-pomodoros', JSON.stringify([
      { id: 'p-1', day: '2026-09-21', endedAt: 1758400000000, minutes: 25, taskId: 't-1' },
    ]));
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 't-1', text: '复习呼吸', done: false, createdAt: 1, pomos: 1 },
    ]));
    localStorage.setItem('knowlattice-days', JSON.stringify({ '2026-09-21': 3 }));

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.app).toBe('knowlattice');
    expect(payload.version).toBe(7);
    expect(payload.qbankStats).toMatchObject({ '备份题库': { 'q-1': { wrong: 1 } } });
    expect(payload.pomodoros).toEqual([
      { id: 'p-1', day: '2026-09-21', endedAt: 1758400000000, minutes: 25, taskId: 't-1' },
    ]);
    expect((payload.todos as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(payload.days).toEqual({ '2026-09-21': 3 });

    // 换设备场景：本地全没了，只靠这份备份
    localStorage.removeItem('knowlattice-pomodoros');
    localStorage.removeItem('knowlattice-todos');
    localStorage.removeItem('knowlattice-days');
    await resetQbankStorageForTests();
    resetQbankStatsForTests();
    backupText = JSON.stringify(payload);
    fireEvent.click(screen.getByText('导入'));

    await waitFor(() => expect(store('knowlattice-pomodoros')).toHaveLength(1));
    expect(store('knowlattice-pomodoros')[0]).toMatchObject({ id: 'p-1', minutes: 25, taskId: 't-1' });
    expect(store('knowlattice-todos')[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(localStorage.getItem('knowlattice-days')).toContain('2026-09-21');
    await expect(getAllQuestionStats()).resolves.toHaveLength(1);
    expect(statOf(await initializeStats(), '备份题库', 'q-1')?.wrong).toBe(1);
  });

  it('旧版备份（没有 pomodoros 字段）照样能导入，不会炸', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'old', text: '老数据', done: false, createdAt: 1 }]));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 3, files: [{ path: '笔记.md', content: '# 笔记\n' }],
      todos: [{ id: 'old', text: '老数据', done: false, createdAt: 1 }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导入'));
    await waitFor(() => expect(store('knowlattice-todos')).toHaveLength(1));
    expect(store('knowlattice-pomodoros')).toHaveLength(0);
  });

  it('二进制附件并入 .json 备份：导出成 dataURL，导入时还原为 Blob 附件', async () => {
    h.attachments = async () => new Map([['_attachments/img.png', new Blob(['hello'], { type: 'image/png' })]]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as {
      version: number;
      files: Array<{ path: string; content: string }>;
    };
    const att = payload.files.find((f) => f.path === '_attachments/img.png');
    expect(att?.content).toMatch(/^data:image\/png;base64,/);

    backupText = JSON.stringify(payload);
    fireEvent.click(screen.getByText('导入'));
    await waitFor(() => expect(h.written.has('_attachments/img.png')).toBe(true));
    await expect(h.written.get('_attachments/img.png')!.text()).resolves.toBe('hello');
  });

  it('导入会报告 overwritten 清单：覆盖已有笔记与附件前先查 exists（审计 M2）', async () => {
    // 库里已有同路径笔记与附件
    h.readAll = async () => new Map([['旧笔记.md', '# 旧内容\n']]);
    h.attachments = async () => new Map([['_attachments/old.png', new Blob(['old'])]]);
    backupText = JSON.stringify({
      app: 'knowlattice', version: 7,
      files: [
        { path: '旧笔记.md', content: '# 新内容（会覆盖）\n' },
        { path: '新笔记.md', content: '# 全新笔记\n' },
        { path: '_attachments/old.png', content: 'data:image/png;base64,bmV3' },
      ],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导入'));
    await waitFor(() => expect(h.written.has('_attachments/old.png')).toBe(true));

    // 探针记录 importBackup 返回值
    await waitFor(() => expect(resultRef.current?.overwritten).toBeDefined());
    expect(resultRef.current!.overwritten).toEqual(['旧笔记.md', '_attachments/old.png']);
    expect(resultRef.current!.ok).toBe(2);
  });
});
