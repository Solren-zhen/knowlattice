// @vitest-environment jsdom
/**
 * Software update card — the DOM acceptance for the in-app auto-update surface.
 *
 * The state machine itself is unit-tested in core/__tests__/updater.test.ts. What this file
 * guards is the **wiring**: `check()` result -> shared store -> card visibility and text,
 * plus the two user actions (install / skip) actually reaching the plugin and the prefs store.
 * Tauri's plugin is mocked, so nothing here touches the network.
 *
 * The store is module-level, so each case re-imports the module (vi.resetModules) instead of
 * adding a test-only reset hook to production code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  /** next value returned by check() */
  next: null as unknown,
  fail: false,
  relaunched: 0,
  closed: 0,
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: async () => {
    if (h.fail) throw new Error('network down');
    return h.next;
  },
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: async () => {
    h.relaunched += 1;
  },
}));

function fakeUpdate(version: string, current: string, notes = '') {
  return {
    currentVersion: current,
    version,
    body: notes,
    close: async () => {
      h.closed += 1;
    },
    downloadAndInstall: async () => {},
  };
}

/** 停在「下载中」的更新：用来断言中间态（进度条），release() 之后才让安装流程走完 */
function gatedUpdate(version: string, current: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    obj: {
      currentVersion: current,
      version,
      body: '',
      close: async () => {
        h.closed += 1;
      },
      downloadAndInstall: async (onEvent?: (e: unknown) => void) => {
        onEvent?.({ event: 'Started', data: { contentLength: 100 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 40 } });
        await gate;
        onEvent?.({ event: 'Finished' });
      },
    },
  };
}

/** 每个用例拿到全新的 store，并让卡片组件与它绑在同一个模块实例上 */
async function fresh() {
  vi.resetModules();
  const updater = await import('../../core/updater');
  const UpdateNotice = (await import('../UpdateNotice')).default;
  return { updater, UpdateNotice };
}

const CARD = '软件更新';

beforeEach(() => {
  h.next = null;
  h.fail = false;
  h.relaunched = 0;
  h.closed = 0;
  localStorage.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('更新卡片', () => {
  it('发现新版本：显示版本、说明与两个动作', async () => {
    const { updater, UpdateNotice } = await fresh();
    h.next = fakeUpdate('0.3.0', '0.2.0', '修复若干问题');
    await updater.checkForUpdate();

    render(<UpdateNotice />);
    expect(screen.getByLabelText(CARD)).toBeTruthy();
    expect(screen.getByText('有可用更新')).toBeTruthy();
    expect(screen.getByText('v0.2.0 → 新版本 v0.3.0')).toBeTruthy();
    expect(screen.getByText('修复若干问题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '跳过此版本' })).toBeTruthy();
  });

  it('启动时的静默检查：已是最新不打扰（卡片不出现）', async () => {
    const { updater, UpdateNotice } = await fresh();
    h.next = null;
    await updater.checkForUpdate();

    render(<UpdateNotice />);
    expect(screen.queryByLabelText(CARD)).toBeNull();
  });

  it('手动检查：已是最新要有回音（否则按钮等于失灵）', async () => {
    const { updater, UpdateNotice } = await fresh();
    h.next = null;
    await updater.checkForUpdate({ manual: true });

    render(<UpdateNotice />);
    expect(screen.getByText('已是最新版本')).toBeTruthy();
  });

  it('检查失败：静默时不打扰，手动时给出原因与重试', async () => {
    const { updater, UpdateNotice } = await fresh();
    h.fail = true;
    await updater.checkForUpdate();
    render(<UpdateNotice />);
    expect(screen.queryByLabelText(CARD)).toBeNull();

    await updater.checkForUpdate({ manual: true });
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('跳过此版本：卡片收起，并把版本记进偏好（下次启动不再打扰）', async () => {
    const { updater, UpdateNotice } = await fresh();
    h.next = fakeUpdate('0.3.0', '0.2.0');
    await updater.checkForUpdate();
    render(<UpdateNotice />);

    fireEvent.click(screen.getByRole('button', { name: '跳过此版本' }));
    await waitFor(() => expect(screen.queryByLabelText(CARD)).toBeNull());
    const raw = localStorage.getItem('knowlattice-update-prefs') ?? '';
    expect(JSON.parse(raw).skipped).toContain('0.3.0');
    // 句柄要释放：跳过之后不该继续占着 Rust 侧资源
    expect(h.closed).toBeGreaterThan(0);
  });

  it('下载并安装：先出进度，装完重启', async () => {
    const { updater, UpdateNotice } = await fresh();
    const gated = gatedUpdate('0.3.0', '0.2.0');
    h.next = gated.obj;
    await updater.checkForUpdate();
    render(<UpdateNotice />);

    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    expect(screen.getByText('正在下载 v0.3.0 · 40%')).toBeTruthy();

    gated.release();
    await waitFor(() => expect(h.relaunched).toBe(1));
    expect(screen.getByText('正在安装，完成后应用会自动重启')).toBeTruthy();
  });

  it('网页版没有更新器：桌面探测为假时卡片永不出现', async () => {
    const { updater, UpdateNotice } = await fresh();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    h.next = fakeUpdate('0.3.0', '0.2.0');
    await updater.checkForUpdate();

    render(<UpdateNotice />);
    expect(screen.queryByLabelText(CARD)).toBeNull();
  });
});
