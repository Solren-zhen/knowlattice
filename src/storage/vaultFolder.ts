/**
 * 桌面端 vault 目录的选择、持久化与授权。
 *
 * 三个职责：
 * - 选择：首次启动用系统目录选择框（@tauri-apps/plugin-dialog）让用户定 vault 位置，
 *   取消则回落到默认 <文档>/KnowLattice（tauriEnv.VAULT_ROOT）。
 * - 持久化：所选路径存 localStorage（knowlattice-vault-dir）。空串 = 「已问过、用默认」，
 *   区别于「从未问过」（键缺失）——避免用户选了默认后每次启动都被再问一遍。
 * - 授权：Tauri 的 fs 运行时作用域不跨重启保留，自定义目录每次都要经 Rust 端
 *   set_vault_dir 命令重新 allow_directory，并由 Rust 侧持久化到应用数据目录、
 *   下次启动在 setup 阶段提前恢复（见 src-tauri/src/lib.rs）。
 *
 * 插件一律动态 import：浏览器构建不把 dialog / api 打进主包。
 */
import { isTauri } from './tauriEnv';

const STORAGE_KEY = 'knowlattice-vault-dir';

/** 用户是否已经做过「选库」决策（选了默认也算） */
export function hasChosenVault(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** 当前生效的 vault 目录；null = 默认 <文档>/KnowLattice（含「从未选择」） */
export function getStoredVaultDir(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function storeVaultDir(dir: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, dir ? dir : '');
  } catch {
    /* localStorage 不可用（隐私模式等）：本次会话仍可用，只是下次会再问 */
  }
}

/** 系统目录选择框；用户取消返回 null */
export async function pickVaultFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { documentDir } = await import('@tauri-apps/api/path');
  const selected = await open({
    directory: true,
    multiple: false,
    title: '选择知识库文件夹（笔记将以 .md 文件保存到这里）',
    defaultPath: await documentDir().catch(() => undefined),
  });
  return typeof selected === 'string' && selected ? selected : null;
}

/** 让 Rust 端扩展 fs 作用域并持久化所选目录；null = 回到默认库（清除自定义授权） */
export async function authorizeVaultDir(dir: string | null): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_vault_dir', { dir: dir ?? '' });
}
