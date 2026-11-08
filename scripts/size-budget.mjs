#!/usr/bin/env node
/**
 * 产物体积预算：读 dist/assets 下的 .js 与 dist/.vite/manifest.json，超预算非零退出。
 *
 * 为什么需要：`assert-public-dist.mjs` 只管「产物里有没有泄漏私密内容」，与体积完全正交。
 * 没有这条线，一次 `npm i` 或顺手引入的解析库就能把首屏包翻倍，而且没人会发现——
 * 桌面端冷启动时间与安装包体积都直接吃这个数。
 *
 * 用法：
 *   node scripts/size-budget.mjs            # 报表 + 判定
 *   node scripts/size-budget.mjs --json     # 机器可读
 *   node scripts/size-budget.mjs --list     # 列出每个 chunk 的归类（调阈值时用）
 *
 * 依赖 `vite.config.ts` 的 `build.manifest: true`：没有 manifest 就无法区分
 * 「产品代码」与「进特定视图才加载的重依赖」，脚本直接报错退出，不猜。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;

/**
 * 预算表。数字来自**本机实测后留余量**，不是行业经验值：
 * 改任何一条都要在提交说明里写清「为什么上调、上调多少」，否则下一个人只会继续抬阈值。
 */
const BUDGETS = {
  /** 首屏唯一必经脚本（index-*.js） */
  index: 700 * KB,
  /** 除重依赖按需之外的产品代码总量 */
  product: 3.4 * 1024 * KB,
  /** 单个普通 chunk 上限 */
  chunk: 700 * KB,
  /** 首屏 js 请求数（静态 import 闭包，动态 import 不算） */
  firstLoad: 8,
  /** 按需重依赖各自一条线（进对应视图才下载，不计入产品总量） */
  pdf: 800 * KB,
  imaging: 4.2 * 1024 * KB,
  office: 1200 * KB,
  editor: 1200 * KB,
  agent: 800 * KB,
};

/** 归类规则：命中即整组单列（组内合计受各自预算约束）。顺序即优先级。 */
const GROUPS = [
  // 顺序即优先级：CodeMirror 的语言包里有 sql/css 这类名字，先归编辑器，避免被 office 抢走
  { id: 'editor', label: '编辑器按需（CodeMirror）', test: /(@codemirror\/|@lezer\/|src\/views\/Editor\.tsx)/i },
  { id: 'imaging', label: '3D / 影像按需（three / niivue / numcodecs / draco）', test: /(three|niivue|numcodecs|draco|gltf|vrm|src\/views\/(BrainAtlasView|AnatomyViewer3D)\.tsx)/i },
  { id: 'pdf', label: 'PDF 按需（pdfjs）', test: /(pdfjs-dist|pdfLib|pdf\.worker|src\/views\/PdfSplitView)/i },
  { id: 'office', label: '文档表格按需（xlsx / sql.js / mammoth / docx / tesseract / jszip）', test: /(xlsx|sql\.js|sql-wasm|mammoth|docx-preview|tesseract|jszip|anydoc)/i },
  { id: 'agent', label: 'Agent 运行时按需（pi-ai / 面板）', test: /(@earendil-works\/|src\/views\/(AiAgentPanel|DraftGen)\.tsx)/i },
];

const args = process.argv.slice(2);
const json = args.includes('--json');
const list = args.includes('--list');
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist/assets';
const dir = resolve(process.cwd(), dirArg);
const manifestPath = resolve(dir, '..', '.vite', 'manifest.json');
const indexPath = resolve(dir, '..', 'index.html');

if (!existsSync(dir)) {
  console.error('找不到 ' + dirArg + '：先跑 npm run build（产物生成后才检查）。');
  process.exit(2);
}
if (!existsSync(manifestPath)) {
  console.error('缺少 ' + manifestPath + '：vite.config.ts 的 build.manifest 应为 true，重跑构建。');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
/** 产物文件 → 产生它的源模块（manifest 的 `src`）；用来把 vendor chunk 归到正确的组 */
const srcByFile = new Map();
for (const entry of Object.values(manifest)) {
  const file = String(entry?.file ?? '');
  if (!file) continue;
  srcByFile.set(basename(file), String(entry?.src ?? ''));
}

function groupOf(file, src) {
  const probe = (src || '') + ' ' + file;
  for (const group of GROUPS) if (group.test.test(probe)) return group.id;
  return 'product';
}

const assets = readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .map((file) => {
    const path = join(dir, file);
    const raw = statSync(path).size;
    const gzip = gzipSync(readFileSync(path), { level: 9 }).length;
    const src = srcByFile.get(file) ?? '';
    return { file, src, raw, gzip, group: groupOf(file, src), index: /^index-.*\.js$/.test(file) };
  })
  .sort((a, b) => b.raw - a.raw);

if (assets.length === 0) {
  console.error(dirArg + ' 里没有 .js 产物，先构建。');
  process.exit(2);
}

/** 首屏请求数：index.html 的 script/modulepreload + 沿静态 import 的闭包；动态 import 不算。 */
function firstLoadRequests() {
  if (!existsSync(indexPath)) return { count: 0, files: [] };
  const html = readFileSync(indexPath, 'utf8');
  // base: './' → href/src 是 ./assets/x.js；根路径部署时是 /assets/x.js
  const starts = new Set();
  for (const m of html.matchAll(/(?:src|href)="\.?\/?assets\/([^"]+\.js)"/g)) starts.add(m[1]);
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const file = queue.pop();
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const code = readFileSync(path, 'utf8');
    const found = [
      ...code.matchAll(/(?:import|export)[^;"']*?from\s*["']\.\/([\w.@-]+\.js)["']/g),
      ...code.matchAll(/(?:^|[;}\s])import\s*["']\.\/([\w.@-]+\.js)["']/g),
    ];
    for (const m of found) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      queue.push(m[1]);
    }
  }
  return { count: seen.size, files: [...seen].sort() };
}

const firstLoad = firstLoadRequests();
const sum = (list) => list.reduce((n, a) => n + a.raw, 0);
const byGroup = (id) => assets.filter((a) => a.group === id);
const product = assets.filter((a) => a.group === 'product');
const indexAsset = assets.filter((a) => a.index).sort((a, b) => b.raw - a.raw)[0] ?? { file: '（未命中）', raw: 0, gzip: 0 };

const totals = { product: sum(product) };
for (const g of GROUPS) totals[g.id] = sum(byGroup(g.id));

const failures = [];
if (indexAsset.raw > BUDGETS.index) {
  failures.push(`主包 ${indexAsset.file}：${kb(indexAsset.raw)} > ${kb(BUDGETS.index)}`);
}
if (totals.product > BUDGETS.product) {
  failures.push(`产品 JS 总量：${kb(totals.product)} > ${kb(BUDGETS.product)}`);
}
for (const a of product) {
  if (!a.index && a.raw > BUDGETS.chunk) failures.push(`${a.file}：${kb(a.raw)} > 单 chunk ${kb(BUDGETS.chunk)}`);
}
for (const g of GROUPS) {
  if (totals[g.id] > BUDGETS[g.id]) failures.push(`${g.label}：${kb(totals[g.id])} > ${kb(BUDGETS[g.id])}`);
}
if (firstLoad.count > BUDGETS.firstLoad) {
  failures.push(`首屏 js 请求数：${firstLoad.count} > ${BUDGETS.firstLoad}`);
}

function kb(n) {
  return (n / KB).toFixed(n < 10 * KB ? 2 : 1) + ' KB';
}

const rows = [
  { id: 'index', label: `主包（${indexAsset.file}）`, actual: indexAsset.raw, budget: BUDGETS.index },
  { id: 'product', label: '产品 JS 总量（不含按需重依赖）', actual: totals.product, budget: BUDGETS.product },
  ...GROUPS.map((g) => ({ id: g.id, label: g.label, actual: totals[g.id], budget: BUDGETS[g.id] })),
  { id: 'firstLoad', label: `首屏 js 请求数（${firstLoad.files.join(' + ') || '无'}）`, actual: firstLoad.count, budget: BUDGETS.firstLoad, count: true },
];

if (json) {
  console.log(JSON.stringify({ dir: dirArg, assets, rows, firstLoad, failures, ok: failures.length === 0 }, null, 2));
} else if (list) {
  console.log('chunk 归类（按体积降序）');
  for (const a of assets) {
    console.log(`  ${a.group.padEnd(8)} ${kb(a.raw).padStart(9)}  ${a.file}${a.src ? '   ← ' + a.src : ''}`);
  }
} else {
  console.log(`产物体积 · ${dirArg}（${assets.length} 个 js）`);
  console.log('项'.padEnd(46) + '实测'.padStart(10) + '预算'.padStart(12));
  for (const r of rows) {
    const actual = r.count ? String(r.actual) : kb(r.actual);
    const budget = r.count ? String(r.budget) : kb(r.budget);
    console.log(r.label.padEnd(46) + actual.padStart(10) + budget.padStart(12) + (r.actual > r.budget ? '  ✗' : ''));
  }
  const top = assets.slice(0, 8);
  if (top.length) {
    console.log('\n最大的 8 个 chunk');
    for (const a of top) console.log(`  ${kb(a.raw).padStart(9)}  gzip ${kb(a.gzip).padStart(9)}  [${a.group}] ${a.file}`);
  }
}

if (failures.length) {
  console.error('\n体积预算未通过：');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
if (!json && !list) console.log('\n体积预算通过。');
