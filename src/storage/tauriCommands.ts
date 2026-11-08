/**
 * Tauri 命令层的唯一运行时边界（architecture.test R5）。
 *
 * core 里的模块要能在纯 Node 下跑（测试、脚本），运行时 import '@tauri-apps/*'
 * 会被 R5 守卫拦下——**动态 import() 同样算运行时依赖**，同样禁止。所有真实调用
 * 都从这里走：core 只拿函数，不直接碰插件包；视图层（main.tsx 等）不受 R5 限制，
 * 但涉及命令调用时也建议经由这里，保持单一出口。
 *
 * 浏览器版调用这些函数没有意义：调用方先用 isTauri()（storage/tauriEnv）或
 * isDesktopApp()（core/updater）判断。
 */

/** 调用 Rust 侧 #[tauri::command]（系统凭据库、B 站代理状态、vault 授权等） */
export async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 当前应用版本（@tauri-apps/api/app）；桌面壳不可用时抛错，由调用方决定兜底 */
export async function currentAppVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

import type { Update } from '@tauri-apps/plugin-updater';

export type { Update };

/** 检查更新（@tauri-apps/plugin-updater）；null = 已是最新 */
export async function checkAppUpdate(options: { timeout: number }): Promise<Update | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  return check(options);
}

/** 装完重启（@tauri-apps/plugin-process）：Windows 由安装器接管，macOS/Linux 必须显式调用 */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
