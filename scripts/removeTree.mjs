/**
 * 健壮删除目录/文件。
 *
 * 2026-09-21 实测：这台机器上 `rmSync(p, { recursive: true, force: true })` 会
 * **不抛错、也不删**（force / maxRetries / retryDelay 都一样）。后果很隐蔽：
 *   - 打包开头清暂存没生效 → copyTree 把新构建**合并**进旧暂存 → 包里同时有两套构建产物；
 *   - 构建前的清空没生效（vite 的 `emptyOutDir` 用的就是 `fs.rm`）→ `dist/assets` 里躺着
 *     上一代的分块（旧入口 bundle + 旧的 `ReviewView-*.js`），并被原样打进离线包。
 * 两种情况所有日志看起来都正常，只有「删完必查」才能发现。
 *
 * 所以删除一律走这里：删完必查，查不过就换 `cmd rmdir` 再来一次，
 * 仍不行返回 false —— 由调用方决定是中止还是提示，不静默继续。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const removeTree = (p) => {
  if (!existsSync(p)) return true;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* 换下一招 */ }
    if (!existsSync(p)) return true;
    try {
      execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', resolve(p)], { stdio: 'ignore' });
    } catch { /* 交给返回值判定 */ }
    if (!existsSync(p)) return true;
  }
  return false;
};
