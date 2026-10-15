/**
 * 软件内自动更新（Tauri updater 插件；网页版所有函数安全返回）。
 *
 * **自动化到哪一步**（这是刻意的边界）：
 *  - 自动检查：桌面版启动后自动查一次 GitHub Releases 的 latest.json；
 *  - 自动下载 + 安装 + 重启：**由用户点一次「下载并安装」触发**。40~120MB 的安装包
 *    不该在用户不知情时占带宽；静默替换正在运行的程序也属于用户不知情的变更。
 *    所以「自动」体现在启动即查、一键完成、装完自动重启，而不是让程序自作主张换掉自己。
 *
 * **状态放在模块级 store**：右下角更新卡片（views/UpdateNotice.tsx）与「关于与许可」
 * 面板（views/SafetyNotice.tsx）订阅同一份状态，不会各查各的、也不会互相覆盖进度。
 *
 * **资源**：`check()` 返回的 Update 在 Rust 侧持有句柄，不安装时必须 `close()`，
 * 否则每次检查都留下一个未释放的资源。
 *
 * **偏好**：「跳过此版本」写 localStorage，读写都容错（同 core/localRecall 的口径——
 * 隐私模式/配额下写不进去，也只是下次启动再提示一次，不影响更新本身）。
 */
import type { Update } from '@tauri-apps/plugin-updater';

export type UpdatePhase =
  /** 还没查过 */
  | 'idle'
  /** 正在查 */
  | 'checking'
  /** 已是最新 */
  | 'current'
  /** 发现新版本，等待用户确认安装 */
  | 'available'
  /** 正在下载 */
  | 'downloading'
  /** 下载完成，正在安装（随后重启） */
  | 'installing'
  /** 检查或安装失败 */
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** 当前安装的版本（检查成功后才有） */
  current: string;
  /** 更新目标版本 */
  version: string;
  /** 更新说明（latest.json 的 notes） */
  notes: string;
  /** 下载进度 0~100；null = 服务器没给总长度，界面走不确定态 */
  pct: number | null;
  /** 失败原因（phase === 'error'） */
  error: string;
  /** 本次运行内用户点了「稍后」 */
  dismissed: boolean;
  /** 最近一次检查是用户主动触发的：只有这时才把「检查中 / 已是最新 / 失败」摆到界面上 */
  manual: boolean;
}

export function initialUpdateState(): UpdateState {
  return {
    phase: 'idle',
    current: '',
    version: '',
    notes: '',
    pct: null,
    error: '',
    dismissed: false,
    manual: false,
  };
}

/* ---------------------------------------------------------------- 纯逻辑 */

export interface UpdatePrefs {
  /** 用户选择跳过的版本（新的在前，只留最近若干个） */
  skipped: string[];
}

export const UPDATE_PREFS_KEY = 'knowlattice-update-prefs';
const MAX_SKIPPED = 5;

export function parseUpdatePrefs(raw: string | null): UpdatePrefs {
  if (!raw) return { skipped: [] };
  try {
    const parsed = JSON.parse(raw) as { skipped?: unknown } | null;
    const list = parsed && Array.isArray(parsed.skipped) ? parsed.skipped : [];
    const out: string[] = [];
    for (const v of list) {
      if (typeof v !== 'string' || !v || out.includes(v)) continue;
      out.push(v);
    }
    return { skipped: out.slice(0, MAX_SKIPPED) };
  } catch {
    return { skipped: [] };
  }
}

export function isVersionSkipped(prefs: UpdatePrefs, version: string): boolean {
  return !!version && prefs.skipped.includes(version);
}

/** 记下「跳过此版本」：该版本排到最前，只保留最近 MAX_SKIPPED 个 */
export function withSkipped(prefs: UpdatePrefs, version: string): UpdatePrefs {
  if (!version) return prefs;
  return { skipped: [version, ...prefs.skipped.filter((v) => v !== version)].slice(0, MAX_SKIPPED) };
}

/** 下载进度百分比；总长度未知或非法时返回 null（界面显示不确定进度） */
export function progressPct(total: number | null, received: number): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  const pct = Math.round((received / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

export type CheckOutcome =
  | { kind: 'available'; current: string; version: string; notes: string }
  | { kind: 'current' }
  | { kind: 'failed'; message: string };

/**
 * 检查结果 → 新状态。
 * `manual` 为 true（用户主动点「检查更新」）时**无视「跳过此版本」**：跳过是「别在启动时
 * 打扰我」，不是「永远不告诉我」；用户主动来问，就必须有回音，否则那个按钮等于失灵。
 */
export function stateAfterCheck(
  prev: UpdateState,
  outcome: CheckOutcome,
  manual: boolean,
  prefs: UpdatePrefs = { skipped: [] },
): UpdateState {
  if (outcome.kind === 'available') {
    return {
      ...prev,
      phase: 'available',
      current: outcome.current,
      version: outcome.version,
      notes: outcome.notes,
      pct: null,
      error: '',
      dismissed: manual ? false : isVersionSkipped(prefs, outcome.version),
      manual,
    };
  }
  if (outcome.kind === 'current') {
    return { ...prev, phase: 'current', version: '', notes: '', pct: null, error: '', dismissed: false, manual };
  }
  return { ...prev, phase: 'error', pct: null, error: outcome.message, dismissed: false, manual };
}

/** 更新卡片是否应该出现 */
export function noticeVisible(s: UpdateState): boolean {
  switch (s.phase) {
    case 'downloading':
    case 'installing':
      return true;
    case 'available':
      return !s.dismissed;
    case 'checking':
    case 'current':
    case 'error':
      // 手动检查要有回音；启动时的静默检查不该打扰用户
      return s.manual;
    default:
      return false;
  }
}

/* ---------------------------------------------------------------- 偏好存储 */

let prefs: UpdatePrefs = { skipped: [] };

export function loadUpdatePrefs(): UpdatePrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(UPDATE_PREFS_KEY);
  } catch {
    return prefs;
  }
  prefs = parseUpdatePrefs(raw);
  return prefs;
}

function saveUpdatePrefs(next: UpdatePrefs): void {
  prefs = next;
  try {
    localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式 / 配额耗尽：跳过记录写不进去，最多下次启动再提示一次
  }
}

/* ---------------------------------------------------------------- 状态 store */

type Listener = () => void;

let state: UpdateState = initialUpdateState();
const listeners = new Set<Listener>();

function commit(next: UpdateState): void {
  state = next;
  for (const l of listeners) l();
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 供 useSyncExternalStore 使用：状态是不可变对象，只在变化时整体替换 */
export function updateState(): UpdateState {
  return state;
}

/* ---------------------------------------------------------------- Tauri 侧 */

/** 是否运行在 Tauri 桌面壳里（网页版没有更新器） */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 已发现但尚未安装的更新（Rust 侧资源句柄）。跳过/被新检查顶替时必须 close() 释放。 */
let pending: Update | null = null;

async function currentVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
}

function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const text = String(e ?? '').trim();
  return text || '未知错误';
}

async function releasePending(): Promise<void> {
  const old = pending;
  pending = null;
  if (old) await old.close().catch(() => {});
}

/** 检查更新。手动触发时把「检查中 / 已是最新 / 失败」也显示出来；启动时的静默检查只报「有更新」。 */
export async function checkForUpdate(options: { manual?: boolean } = {}): Promise<UpdateState> {
  if (!isDesktopApp()) return state;
  const manual = options.manual === true;
  // 下载/安装中不重入：重复 check 会把进度状态盖掉，也可能丢掉正在下载的句柄
  if (state.phase === 'downloading' || state.phase === 'installing') return state;

  loadUpdatePrefs();
  commit({ ...state, phase: 'checking', manual, error: '', pct: null, dismissed: false });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 30_000 });
    if (!update) {
      commit(stateAfterCheck(state, { kind: 'current' }, manual, prefs));
      return state;
    }
    const outcome: CheckOutcome = {
      kind: 'available',
      current: update.currentVersion || (await currentVersion()),
      version: update.version,
      notes: update.body ?? '',
    };
    const skipped = !manual && isVersionSkipped(prefs, outcome.version);
    if (skipped) {
      // 用户已跳过这个版本：不保留句柄（否则每次启动都白占一份 Rust 侧资源）
      await update.close().catch(() => {});
      await releasePending();
    } else {
      await releasePending();
      pending = update;
    }
    commit(stateAfterCheck(state, outcome, manual, prefs));
    return state;
  } catch (e) {
    commit(stateAfterCheck(state, { kind: 'failed', message: messageOf(e) }, manual, prefs));
    return state;
  }
}

/** 下载并安装已发现的更新；装完自动重启（Windows 由安装器接管，macOS 显式 relaunch）。 */
export async function installUpdate(): Promise<void> {
  if (!isDesktopApp() || !pending) return;
  const update = pending;
  commit({ ...state, phase: 'downloading', pct: null, error: '', dismissed: false, manual: true });
  try {
    let total: number | null = null;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null;
        commit({ ...state, phase: 'downloading', pct: progressPct(total, 0) });
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        commit({ ...state, phase: 'downloading', pct: progressPct(total, received) });
      } else {
        commit({ ...state, phase: 'installing', pct: 100 });
      }
    });
    pending = null;
    // Windows：安装器启动后应用会退出（restartAfterInstall 默认 true），通常走不到这里。
    // macOS / Linux：install 不会自行重启，必须显式重启，否则用户打开的还是旧版本。
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    pending = null;
    commit(stateAfterCheck(state, { kind: 'failed', message: messageOf(e) }, true, prefs));
  }
}

/** 「稍后」：本次运行不再提示，下次启动仍会检查 */
export function dismissUpdate(): void {
  commit({ ...state, dismissed: true, manual: false });
}

/** 「跳过此版本」：持久化，之后启动不再提示它；用户手动检查时仍会出现 */
export async function skipUpdateVersion(): Promise<void> {
  if (!state.version) return;
  saveUpdatePrefs(withSkipped(prefs, state.version));
  await releasePending();
  commit({ ...state, dismissed: true, manual: false });
}

/** 启动后延迟检查一次（不弹 toast：有更新时右下角卡片自己会亮） */
export function autoUpdateOnStartup(delayMs = 8000): void {
  if (!isDesktopApp()) return;
  window.setTimeout(() => {
    void checkForUpdate();
  }, delayMs);
}
