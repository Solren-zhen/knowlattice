/**
 * 桌面版自动更新（Tauri updater 插件；网页版所有函数安全返回 null/false）。
 *
 * 流程：
 * 1. 应用启动 8 秒后静默检查 GitHub Releases 上的 latest.json
 * 2. 有新版本 → 后台静默下载（minisign 签名校验，被篡改的安装包装不上）
 * 3. 下载完成 → 自动安装并重启应用（笔记/书架数据都在本地，更新不丢）
 *
 * 发布新版本（开发者操作，详见 scripts/make-update-manifest.mjs 注释）：
 *   npm run tauri build → node scripts/make-update-manifest.mjs
 *   → GitHub 建 Release（tag = vX.Y.Z），上传 setup.exe / .sig / latest.json
 */
import { toast } from './feedback';

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface PdfUpdate {
  /** 当前安装的版本 */
  currentVersion: string;
  /** 更新目标的版本 */
  version: string;
  /** 更新说明（latest.json 的 notes） */
  notes: string;
  /** 下载（带签名校验）→ 静默安装 → 自动重启应用 */
  install: (onProgress?: (pct: number | null) => void) => Promise<void>;
}

/** 检查更新；无更新 / 离线 / 网页版返回 null（不抛错，避免启动噪音） */
export async function checkForUpdate(): Promise<PdfUpdate | null> {
  if (!isDesktopApp()) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { getVersion } = await import('@tauri-apps/api/app');
    const currentVersion = await getVersion().catch(() => '');
    const update = await check();
    if (!update?.available) return null;
    return {
      currentVersion: currentVersion || update.currentVersion,
      version: update.version,
      notes: update.body ?? '',
      install: async (onProgress) => {
        let total: number | null = null;
        let received = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? null;
          } else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            onProgress?.(total ? Math.min(100, Math.round((received / total) * 100)) : null);
          } else if (event.event === 'Finished') {
            onProgress?.(100);
          }
        });
        // 安装完成后重启；更新器在 Windows 上会先退出应用再由安装器接管
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}

/** 启动后自动检查并静默更新（仅桌面版；网页版不执行） */
export function autoUpdateOnStartup(delayMs = 8000): void {
  if (!isDesktopApp()) return;
  window.setTimeout(() => {
    void (async () => {
      const update = await checkForUpdate();
      if (!update) return;
      toast(`发现新版本 v${update.version}，正在自动更新…`);
      try {
        await update.install();
      } catch {
        toast('自动更新失败，可到「关于与许可」手动重试', 'err');
      }
    })();
  }, delayMs);
}
