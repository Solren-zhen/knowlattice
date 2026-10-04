/**
 * Tauri 运行环境探测与 Vault 根目录约定。
 *
 * 桌面端（Tauri）与浏览器版共用同一套前端代码：这里只做「是不是桌面端」的判定，
 * 真正的文件读写放在 storage/tauri.ts，且惰性加载 fs 插件，浏览器构建不带进主包。
 */

/** vault 根目录：位于系统「文档」目录下，用户可直接在资源管理器里看到 .md 文件与附件 */
export const VAULT_ROOT = 'KnowLattice';

/** 是否运行在 Tauri 桌面壳里（浏览器版返回 false，走 WebAdapter/IndexedDB） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
