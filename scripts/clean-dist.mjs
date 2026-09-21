/**
 * 构建前清空 `dist`。
 *
 * 为什么必须单独一步：vite 的 `emptyOutDir` 内部用的就是 `fs.rm`，而本机 `fs.rmSync`
 * 会**不抛错也不删**（见 removeTree.mjs）。实测：往 `dist/assets/` 放一个探针文件再
 * `vite build`，探针仍在 —— 于是每次构建都把上一代的分块留在 `dist` 里，`index.html`
 * 引用新入口、旧分块照样被打进离线包（一次实测残留 16 个旧 .js）。
 *
 * 清不掉就中止构建：宁可不构建，也不产出一个「看起来正常」的脏产物。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { removeTree } from './removeTree.mjs';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const existed = existsSync(dist);
if (!removeTree(dist)) {
  console.error('[clean-dist] dist 删不掉（本机 fs.rm 会静默失效），中止构建以免产出脏产物');
  process.exit(1);
}
if (existed) console.log('[clean-dist] 已清空 dist');
