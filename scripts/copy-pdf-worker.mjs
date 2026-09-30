/**
 * 构建前把 pdf.js 的 worker 复制到 `public/pdfjs/`。
 *
 * 为什么不让 Vite 用 `?url` 导入：
 * 本项目当前用的是 Rolldown 版 Vite，`import url from 'x?url'` 对 pdfjs 的 worker
 * （以及 sql.js 的 wasm）会退化成**副作用导入** —— 产物里只剩 `import "./pdf.worker.min-<hash>.js"`，
 * 模块本身拿不到 URL 字符串。线上实测：`GlobalWorkerOptions.workerSrc` 是空串，
 * worker 不加载，PDF 面板静默渲染成一片空白（连 console 都没有报错）。
 *
 * 放在 `public/` 下的文件按原路径原样产出（不带 hash），
 * 于是 `./pdfjs/pdf.worker.min.js` 这个路径在 dev 与生产都成立。
 * public/tesseract、public/draco 走的是同一套思路。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js');
const destDir = join(root, 'public', 'pdfjs');
const dest = join(destDir, 'pdf.worker.min.js');

if (!existsSync(src)) {
  console.error('[copy-pdf-worker] 找不到 pdfjs 的 worker：', src);
  console.error('[copy-pdf-worker] 请确认 node_modules 已安装（npm install）');
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('[copy-pdf-worker] 已同步 pdf.worker.min.js → public/pdfjs/');
