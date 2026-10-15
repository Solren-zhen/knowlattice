// @vitest-environment jsdom
/**
 * useVault 加载语义测试。
 *
 * 加载失败绝不能等价于「空库」：那样应用会进入「内存里一篇笔记都没有」的可写状态，
 * 新建笔记的查重以「磁盘上没有这篇」为前提，保存时会把磁盘上真实存在的笔记覆盖掉，
 * 用户看到的界面和空库完全一样。所以失败时走 loaded=true + loadError 非空 →
 * Workspace 停在错误页，不进可写状态；「重试」清掉错误并重跑加载。
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
    stat = async (p: string) => ((await h.readAll()).has(p) ? { mtime: 0, size: 0 } : null);
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
      {/* 打开库时自动修正的明细篇数：空串 = 这次打开没有任何需要修的地方 */}
      <span data-testid="repair">{v.autoRepair ? String(v.autoRepair.repairedFiles?.length ?? 0) : ''}</span>
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

  it('打开库时自动修复 Markdown：只写回真正变化的那一篇，用户不用点任何菜单项', async () => {
    // 表格行首多余的 `\|`（见 core/markdownRepair）：在外部编辑器里粘出来的常见坏格式
    const broken = '\\| A | B |\n| --- | --- |\n\\| x | y |\n';
    h.readAll = async () => new Map([['01-生理/a.md', broken]]);

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('ok'));

    await waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
    const call = h.write.mock.calls[0] as unknown as [string, string];
    expect(call[0]).toBe('01-生理/a.md');
    expect(call[1]).toBe('| A | B |\n| --- | --- |\n| x | y |\n');
    // 是同一篇被改写，不是变成两篇
    expect(screen.getByTestId('docs').textContent).toBe('1');
    expect(screen.getByTestId('repair').textContent).toBe('1');
  });

  it('没有需要修复的格式就一次盘都不写（自动修复不能变成每次打开都整库重写）', async () => {
    h.readAll = async () => new Map([['01-生理/a.md', '# A\n']]);

    render(<Probe />);
    await waitFor(() => expect(state()).toBe('ok'));

    expect(h.write).not.toHaveBeenCalled();
    expect(screen.getByTestId('repair').textContent).toBe('');
  });
});
