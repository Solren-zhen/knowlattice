/**
 * 构建前把 pdf.js 的 worker 与字体资源复制到 `public/pdfjs/`。
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
 *
 * 除了 worker，还必须同步这两份：
 *  - `cmaps/`：中日常用 PDF 是 CID 字体 + 预定义 CMap（UniGB-UCS2-H / Adobe-GB1 …），
 *    pdf.js 要按名取 `<name>.bcmap` 才能把字形映射回 Unicode。缺了它 getTextContent()
 *    对这些文件返回空串 —— 「有 OCR 文字层的讲义」被判成扫描件，对照模式选不中字。
 *    实测一份 UniGB-UCS2-H 单页 PDF：不配 CMap 时 0 字符，配上后 25 字符。
 *  - `standard_fonts/`：PDF 没内嵌标准 14 字体时，渲染层要拿这些替代字形。
 *
 * 顺带检查 `public/app-data/`：医学速查的数据不进仓库（见 .gitignore），由
 * `tools/ingest-app-data.mjs` 从本机素材目录生成，所以换机器/CI 构建时这里会是空的。
 * 缺了不让构建失败（其余功能不受影响），但必须当场说出来 —— 否则要等到打开
 * 「医学速查」才吃一个 404。同理见 src/core/medRef.ts 的报错文案。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = (...p) => join(root, 'node_modules', 'pdfjs-dist', ...p);
const destDir = join(root, 'public', 'pdfjs');

const workerSrc = dist('build', 'pdf.worker.min.js');
const workerDest = join(destDir, 'pdf.worker.min.js');
const assetDirs = ['cmaps', 'standard_fonts'];

if (!existsSync(workerSrc)) {
  console.error('[copy-pdf-worker] 找不到 pdfjs 的 worker：', workerSrc);
  console.error('[copy-pdf-worker] 请确认 node_modules 已安装（npm install）');
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(workerSrc, workerDest);
console.log('[copy-pdf-worker] 已同步 pdf.worker.min.js → public/pdfjs/');

for (const name of assetDirs) {
  const from = dist(name);
  const to = join(destDir, name);
  if (!existsSync(from)) {
    console.error(`[copy-pdf-worker] 找不到 pdfjs 的 ${name}/：`, from);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
  console.log(`[copy-pdf-worker] 已同步 ${name}/ → public/pdfjs/${name}/（${readdirSync(to).length} 个文件）`);
}

const appDataDir = join(root, 'public', 'app-data', 'medref');
const appDataCount = existsSync(appDataDir) ? readdirSync(appDataDir).length : 0;
if (appDataCount === 0) {
  console.warn('[copy-pdf-worker] public/app-data/medref/ 是空的：「医学速查」打开会报错。');
  console.warn('[copy-pdf-worker] 先在项目根跑：node tools/ingest-app-data.mjs');
} else {
  console.log(`[copy-pdf-worker] app-data 已就绪（medref ${appDataCount} 个文件）`);
}
