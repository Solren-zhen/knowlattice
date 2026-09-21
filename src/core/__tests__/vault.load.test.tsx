// @vitest-environment jsdom
/**
 * useVault 加载语义测试（2026-09-20 修复）。
 *
 * 旧行为：`readAll()` 失败只 console.error，然后照常 setLoaded(true)。结果是应用进入
 * 「内存里一篇笔记都没有」的可写状态：新建笔记的查重以「磁盘上没有这篇」为前提，
 * 保存时会把磁盘上真实存在的笔记覆盖掉；用户看到的界面和空库完全一样。
 *
 * 现在：失败时 loaded=true + loadError 非空 → Workspace 停在错误页，不进可写状态；
 * 「重试」清掉错误并重跑加载。
 *
 * 适配器是 vault.ts 里的模块级单例（`new WebAdapter()`），没有注入点，所以这里
 * mock 掉 storage/web 模块，用一个可控适配器驱动成功/失败两条路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  readAll: (async () => new Map()) as () => Promise<Map<string, string>>,
  write: vi.fn(async () => {}),
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.readAll();
    read = async (p: string) => (await h.readAll()).get(p) ?? '';
    exists = async (p: string) => (await h.readAll()).has(p);
    write = h.write;
    remove = async () => {};
    readAllAttachments = async () => new Map<string, Blob>();
    writeAttachment = async () => {};
    removeAttachment = async () => {};
  },
}));

const { useVault } = await import('../vault');

function Probe() {
  const v = useVault();
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <span data-testid="msg">{v.loadError ?? ''}</span>
      <span data-testid="docs">{v.docs.size}</span>
      <button onClick={v.retryLoad}>重试</button>
    </div>
  );
}

const state = () => screen.getByTestId('state').textContent;

beforeEach(() => {
  localStorage.clear();
  h.write.mockClear();
  h.readAll = async () => new Map();
});

afterEach(() => cleanup());

describe('useVault 加载', () => {
  it('读盘成功：进入可用状态，无错误', async () => {
    h.readAll = async () => new Map([['01-生理/a.md', '# A\n']]);

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('ok'));

    expect(screen.getByTestId('msg').textContent).toBe('');
    expect(screen.getByTestId('docs').textContent).toBe('1');
  });

  it('读盘失败：loadError 非空，且不把空库当成正常状态放行', async () => {
    h.readAll = async () => {
      throw new Error('磁盘读取失败');
    };

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('error'));

    expect(screen.getByTestId('msg').textContent).toBe('磁盘读取失败');
    expect(screen.getByTestId('docs').textContent).toBe('0');
  });

  it('失败页「重试」能恢复到可用状态', async () => {
    let fail = true;
    h.readAll = async () => {
      if (fail) throw new Error('磁盘读取失败');
      return new Map([['01-生理/a.md', '# A\n']]);
    };

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('error'));

    fail = false;
    fireEvent.click(screen.getByText('重试'));

    await waitFor(() => expect(state()).toBe('ok'));
    expect(screen.getByTestId('msg').textContent).toBe('');
    expect(screen.getByTestId('docs').textContent).toBe('1');
  });

  it('加载失败时不会去写引导笔记（不往一个读不出来的库上写东西）', async () => {
    h.readAll = async () => {
      throw new Error('磁盘读取失败');
    };

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('error'));

    expect(h.write).not.toHaveBeenCalled();
  });
});
