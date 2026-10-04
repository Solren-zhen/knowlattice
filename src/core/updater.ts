/**
 * 桌面版更新检查（Tauri updater 插件；网页版所有函数安全返回 null/false）。
 *
 * 策略（2026-10-04 审计 M3 后收紧）：启动时只**检查并提示**，绝不静默下载安装——
 * 自动换掉正在运行的应用属于用户不知情的变更；安装动作一律由用户在
 * 「关于与许可」面板手动触发（仍走 minisign 签名校验，被篡改的安装包装不上）。
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
  /** 下载（带签名校验）→ 安装 → 重启应用。只由用户在界面主动触发，启动流程绝不调用。 */
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

/** 启动后只检查并提示，不自动安装（2026-10-04 审计 M3）。
 *  旧实现会静默下载并重启应用——更新窗口期正好打断用户、且用户对「应用自己换了
 *  一个版本」没有知情/选择权。现在改为：发现新版本只弹提示，安装动作留给用户
 *  在「关于与许可」面板手动触发（签名校验与手动路径完全一致）。 */
export function autoUpdateOnStartup(delayMs = 8000): void {
  if (!isDesktopApp()) return;
  window.setTimeout(() => {
    void (async () => {
      const update = await checkForUpdate();
      if (!update) return;
      toast(`发现新版本 v${update.version}，可到「关于与许可」面板手动安装`, 'ok', 6000);
    })();
  }, delayMs);
}
