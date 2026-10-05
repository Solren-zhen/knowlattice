// @vitest-environment jsdom
/**
 * 外部改动留档测试。
 *
 * `save` 打开笔记时记下磁盘 mtime 基线；保存前若发现 mtime 变了、且磁盘内容既不是我们要写的、
 * 也不是内存里的上一版，就先把磁盘那一版推进历史版本，再照常落盘，外部改动不会被静默吃掉。
 *
 * 适配器是 vault.ts 的模块级单例，没有注入点，所以 mock 掉 storage/web 与 history。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  mtimes: new Map<string, number>(),
  snapshots: [] as Array<{ path: string; content: string }>,
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = async () => new Map(h.disk);
    read = async (p: string) => h.disk.get(p) ?? '';
    exists = async (p: string) => h.disk.has(p);
    stat = async (p: string) => (h.disk.has(p) ? { mtime: h.mtimes.get(p) ?? 0, size: 0 } : null);
    write = async (p: string, c: string) => {
      h.disk.set(p, c);
      h.mtimes.set(p, (h.mtimes.get(p) ?? 0) + 1); // 每次写都让 mtime 前进，模拟真实文件系统
    };
    remove = async (p: string) => { h.disk.delete(p); h.mtimes.delete(p); };
    readAllAttachments = async () => new Map<string, Blob>();
    writeAttachment = async () => {};
    removeAttachment = async () => {};
  },
}));

vi.mock('../history', () => ({
  pushSnapshot: async (path: string, content: string) => { h.snapshots.push({ path, content }); },
}));

// 必须用动态 import：vi.mock 的工厂是提升的，静态 import 会在 mock 注册前就求值 vault.ts，
// 于是拿到真实的 WebAdapter（与 vault.load.test.tsx / vault.backup.test.tsx 同一理由）。
const { useVault } = await import('../vault');

function Probe() {
  const v = useVault();
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <button onClick={() => v.setCurrentPath('a.md')}>打开</button>
      <button onClick={() => void v.save('a.md', '应用里改的\n')}>保存</button>
    </div>
  );
}

/** 让 effect 里 fire-and-forget 的 stat 先跑完（基线必须在保存前就位）。
 *  用执行器形式：项目的 TS lib 目标是 ES2023，没有 Promise.withResolvers。 */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  localStorage.clear();
  h.disk = new Map([['a.md', '原始内容\n']]);
  h.mtimes = new Map([['a.md', 1]]);
  h.snapshots = [];
});

afterEach(() => cleanup());

/** 渲染 + 等加载完成 + 打开笔记（打开时会记下 mtime 基线），但**不保存**：
 *  每个用例要自己控制「外部改动」发生在保存之前。 */
async function openNote() {
  render(<Probe />);
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
  fireEvent.click(screen.getByText('打开'));
  await flush(); // 等基线记录完成
}

describe('保存前的外部改动检测', () => {
  it('磁盘被外部改过：先把磁盘那一版留档，再落盘，两版都不丢', async () => {
    await openNote(); // 打开时基线 mtime=1
    // 模拟外部编辑器改了同一个文件
    h.disk.set('a.md', '外部编辑器改的\n');
    h.mtimes.set('a.md', 2);

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(h.disk.get('a.md')).toBe('应用里改的\n'));

    // 第 1 条是留档的外部版本，第 2 条是保存后推入的新内容
    expect(h.snapshots.map((s) => s.content)).toEqual(['外部编辑器改的\n', '应用里改的\n']);
    expect(h.snapshots.every((s) => s.path === 'a.md')).toBe(true);
  });

  it('磁盘没被动过：只推保存后的内容，不产生多余的留档', async () => {
    await openNote();
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(h.disk.get('a.md')).toBe('应用里改的\n'));

    expect(h.snapshots.map((s) => s.content)).toEqual(['应用里改的\n']);
  });

  it('只有 mtime 变了、内容没变（touch）：不算冲突，不留档', async () => {
    await openNote();
    h.mtimes.set('a.md', 2); // 内容仍是「原始内容」，只是 mtime 前进

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(h.disk.get('a.md')).toBe('应用里改的\n'));

    expect(h.snapshots.map((s) => s.content)).toEqual(['应用里改的\n']);
  });

  it('本次会话没打开过的路径：没有基线，直接写', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    // 不点「打开」：磁盘上已是别的内容，但应用无从判断（没有基线）
    h.disk.set('a.md', '外部编辑器改的\n');
    h.mtimes.set('a.md', 2);

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(h.disk.get('a.md')).toBe('应用里改的\n'));

    expect(h.snapshots.map((s) => s.content)).toEqual(['应用里改的\n']);
  });
});
