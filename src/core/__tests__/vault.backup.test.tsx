// @vitest-environment jsdom
/**
 * 整包备份回环：导出 → 清空 → 导入，番茄记录、待办、打卡都要回来。
 *
 * 番茄记录只活在 localStorage 里。备份漏了它，用户换设备就等于白专注——这条链路值得一个测试。
 * 适配器是 vault.ts 的模块级单例，没有注入点，所以照 vault.load.test.tsx 的做法 mock 掉 storage/web。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  readAll: (async () => new Map<string, string>()) as () => Promise<Map<string, string>>,
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.readAll();
    read = async (p: string) => (await h.readAll()).get(p) ?? '';
    exists = async (p: string) => (await h.readAll()).has(p);
    write = async () => {};
    remove = async () => {};
    readAllAttachments = async () => new Map<string, Blob>();
    writeAttachment = async () => {};
    removeAttachment = async () => {};
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
      <button onClick={() => { void v.importBackup(backupText); }}>导入</button>
    </div>
  );
}

const store = (key: string): unknown[] => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];

beforeEach(() => {
  localStorage.clear();
  h.readAll = async () => new Map();
  backupText = '';
  captured = null;
  Object.defineProperty(URL, 'createObjectURL', {
    value: (b: Blob) => { captured = b; return 'blob:test'; }, writable: true, configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
});

afterEach(() => cleanup());

describe('整包备份：番茄记录不丢', () => {
  it('导出带上番茄记录，清空后导入能回来（待办里的番茄数也一起）', async () => {
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
    expect(captured).not.toBeNull();

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.app).toBe('knowlattice');
    expect(payload.version).toBe(5);
    expect(payload.pomodoros).toEqual([
      { id: 'p-1', day: '2026-09-21', endedAt: 1758400000000, minutes: 25, taskId: 't-1' },
    ]);
    expect((payload.todos as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(payload.days).toEqual({ '2026-09-21': 3 });

    // 换设备场景：本地全没了，只靠这份备份
    localStorage.removeItem('knowlattice-pomodoros');
    localStorage.removeItem('knowlattice-todos');
    localStorage.removeItem('knowlattice-days');
    backupText = JSON.stringify(payload);
    fireEvent.click(screen.getByText('导入'));

    await waitFor(() => expect(store('knowlattice-pomodoros')).toHaveLength(1));
    expect(store('knowlattice-pomodoros')[0]).toMatchObject({ id: 'p-1', minutes: 25, taskId: 't-1' });
    expect(store('knowlattice-todos')[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(localStorage.getItem('knowlattice-days')).toContain('2026-09-21');
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
});
