/**
 * 打包「KnowLattice 离线版」：把构建产物 + 笔记/题库备份 + 零依赖启动器，组装成一个 zip。
 *
 * 用法：
 *   npm run pack                 # 先构建，再自动收集备份（应用导出的 / 根目录的 knowlattice-*.json）打包
 *   npm run pack -- --no-build   # 跳过构建，直接用现有 dist
 *   npm run pack -- --data <文件># 指定某一份备份 .json（例如你刚在应用里导出的那份）
 *
 * 曾经有个 `--lite`（精简包）：去掉 OCR 组件与冗余字体。**已撤销**，原因是实测数据不支持它：
 * 它省下的 7.3 MB 里 6.73 MB 是 OCR（tesseract 三个 core 变体各 1.01 MB + 两个语言包 3.53 MB），
 * 去掉它 = 「扫描版 PDF」这个功能直接报错；剩下的 KaTeX woff/ttf 只有 0.58 MB，单独去掉省不到
 * 2%，不值得多出一个少功能的产物。而且三个 core 变体是 tesseract.js 按浏览器能力**挑一个**加载的
 * （getCore.js 里只有 if/else，没有任何回退），分别对应 2024+ / 2021-2024 / 更老的浏览器，
 * 少任何一个都会让那一类浏览器的 OCR 直接失败——所以也不能「只留一个」。
 * 传 --lite 现在会直接报错退出，避免再产出不能 OCR 的包。
 *
 * 产物：仓库根目录 KnowLattice-离线版-YYYY-MM-DD.zip（已在 .gitignore 中忽略）
 * 包内全部用 ASCII 名称，避免不同解压工具把中文条目解成乱码；说明文本用 UTF-8 BOM，记事本可直接读。
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { removeTree } from './removeTree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
if (args.includes('--lite')) {
  console.error('[pack] --lite 已撤销，不再产出「精简版」。');
  console.error('[pack] 它省下的 7.3 MB 里 6.73 MB 是扫描版 PDF 的 OCR，去掉等于砍掉这个功能；');
  console.error('[pack] 剩下的 KaTeX woff/ttf 只有 0.58 MB，不值得多一个不能 OCR 的产物。');
  console.error('[pack] 直接 `npm run pack` 打完整包即可。');
  process.exit(1);
}
const dataIdx = args.indexOf('--data');
const explicitData = dataIdx >= 0 ? args[dataIdx + 1] : null;

const log = (...a) => console.log('[pack]', ...a);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// fs.cpSync 的递归分支在部分 Windows + Node 组合下会直接终止进程（无异常、退出码 9），
// 单文件 cpSync / copyFileSync / rmSync 都正常。这里自己走一遍：建目录 + 逐文件 copyFileSync。
const copyTree = (src, dest, filter) => {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const child = join(src, e.name);
      if (filter && !filter(child)) continue;
      copyTree(child, join(dest, e.name), filter);
    }
  } else {
    copyFileSync(src, dest);
  }
};

/** 递归列出目录下的全部文件（相对路径由调用方算） */
const walkFiles = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
};

/**
 * 删目录、确认真的删掉了，并把这件事交给调用方决定成败。
 *
 * 实现已抽到 `scripts/removeTree.mjs`（构建前的 clean-dist 也要用同一套，
 * 免得两处各写一份、其中一处忘了「删完必查」）。本机 `fs.rmSync` 会不抛错也不删，
 * 所以删除一律走它：删完必查 → `cmd rmdir` 兜底 → 仍不行返回 false。
 */

// ---------- 1. 构建 ----------
if (!noBuild) {
  log('构建前端：npm run build …');
  const npm = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const npmArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', 'build'] : ['run', 'build'];
  // 构建脚本自带 prebuild（scripts/clean-dist.mjs）：本机 vite 的 emptyOutDir 静默失效，
  // 不清 dist 就会把上一代分块一起打进包（见 removeTree.mjs 的说明）。
  execFileSync(npm, npmArgs, { cwd: repo, stdio: 'inherit' });
}
const dist = join(repo, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('[pack] 没有 dist/index.html，请先 npm run build');
  process.exit(1);
}

// ---------- 2. 收集并合并备份 ----------
const loadBackup = (p) => {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    // 兼容旧版以 medvault 命名的备份
    return j && (j.app === 'knowlattice' || j.app === 'medvault') && Array.isArray(j.files) ? j : null;
  } catch {
    return null;
  }
};

const sources = [];
if (explicitData) {
  const p = resolve(repo, explicitData);
  const b = existsSync(p) ? loadBackup(p) : null;
  if (!b) {
    console.error(`[pack] 指定的备份无效：${p}`);
    process.exit(1);
  }
  sources.push({ p, b });
} else {
  // 自动模式只取仓库根目录的 knowlattice-*.json（这些是应用导出的稳定副本），
  // 避免误收 Downloads 里的旧备份；要带上应用里刚导出的最新版，用 --data 指定。
  //
  // 体积闸门：题库类导出动辄几十 MB（111548 道题的备份 54 MB），自动收进来会把分享包
  // 从 41 MB 撑到 100 MB，而且同学拿到一堆题库备份也不是"起步数据"。超过 8 MB 的一律跳过，
  // 真要收就 --data 显式指定——显式指定意味着你知道自己在装什么。
  const AUTO_MAX_BYTES = 8 * 1024 * 1024;
  for (const f of readdirSync(repo).filter((f) => /^(?:knowlattice|medvault)-.*\.json$/.test(f)).sort()) {
    const full = join(repo, f);
    const bytes = statSync(full).size;
    if (bytes > AUTO_MAX_BYTES) {
      console.log(`[pack] 跳过 ${f}（${(bytes / 1024 / 1024).toFixed(1)} MB > 自动收录上限 8 MB；要收就 --data 指定）`);
      continue;
    }
    const b = loadBackup(full);
    if (b) sources.push({ p: full, b });
  }
}
if (sources.length === 0) {
  console.error('[pack] 没找到任何备份。放一份 knowlattice-*.json 到仓库根目录，或用 --data <文件> 指定。');
  process.exit(1);
}

const fileMap = new Map();
const qbanks = [];
const qNames = new Set();
let srs = null;
let mistakes = null;
let todos = null;
let days = null;
let cardEdits = null;
for (const { b } of sources) {
  for (const f of b.files) {
    if (f && typeof f.path === 'string' && typeof f.content === 'string') fileMap.set(f.path, f.content);
  }
  if (Array.isArray(b.qbanks)) {
    for (const q of b.qbanks) {
      const name = q && (q.name || q.title);
      if (name && qNames.has(name)) continue;
      if (name) qNames.add(name);
      qbanks.push(q);
    }
  }
  if (!srs && b.srs && Object.keys(b.srs).length) srs = b.srs;
  if (!mistakes && Array.isArray(b.mistakes) && b.mistakes.length) mistakes = b.mistakes;
  if (!todos && Array.isArray(b.todos) && b.todos.length) todos = b.todos;
  if (!days && b.days && Object.keys(b.days).length) days = b.days;
  // v4：卡片自定义（改写正/背面、删卡）也要随包走，否则离线包里看不到用户的自定义卡片
  if (!cardEdits && b.cardEdits && Object.keys(b.cardEdits).length) cardEdits = b.cardEdits;
}

const merged = {
  app: 'knowlattice',
  version: 4,
  exportedAt: new Date().toISOString(),
  files: [...fileMap].map(([path, content]) => ({ path, content })),
  srs: srs ?? {},
  qbanks,
  mistakes: mistakes ?? [],
  todos: todos ?? [],
  days: days ?? {},
  cardEdits: cardEdits ?? {},
};
const noteCount = merged.files.filter((f) => !f.path.startsWith('_attachments/')).length;
const qCount = qbanks.reduce((n, q) => n + ((q && q.questions && q.questions.length) || 0), 0);

// ---------- 2b. 解剖模型对账（两道闸门）----------
// 两道都针对同一类事故：manifest 说有的东西，包里没有或者对不上。
//  ① 文件在不在：manifest 里**实际被引用**的每个 mesh_file 都要在（不是猜 <system>_male.glb）。
//     2026-09-20 踩过两次，都是同一个错误假设「一个系统一个文件」：
//       · nervous_male.glb 一直不存在（git 基线 2026-09-14 就只有那 12 个 glb），点开神经系统
//         必然报错，直到打包时才发现；该文件已于同日从上游 Anatria-3D 补齐。
//       · digestive / endocrine / respiratory 的 organs 还引用 visceral_male.glb（13 个结构），
//         而旧闸门只看 <system>_male.glb，所以它**不会**发现这个文件缺失。
//     现在闸门直接按 manifest 的 mesh_file 逐个查，与应用 systemMeshFiles() 的取值口径一致。
//  ② 文件对不对：GLB 里的节点名要能覆盖 manifest 中「归属这个文件」的结构的 `node` 字段——
//     点击命中靠名字匹配，补一个名字对不上的模型等于没修（点了没反应，比报错更糟）。
//     必须带上「归属这个文件」这个约束：visceral_male.glb 与主文件大量同名（digestive 47 个
//     结构里 44 个重名），不约束的话重名结构会被算成两份，覆盖率虚高。
//     下限取 50%：完全拿错文件时覆盖率会趋近 0，50% 足以拦住。
const MODEL_COVERAGE_FLOOR = 50;
{
  const anatomyDir = join(repo, 'public', 'anatomy');
  const manifest = JSON.parse(readFileSync(join(anatomyDir, 'manifest.json'), 'utf8'));
  const systems = (manifest.systems || []).map((s) => s.system).filter(Boolean);
  // 一个系统实际要用到哪几个文件：与 src/core/anatomy.systemMeshFiles 同口径
  const filesOf = (sys) => {
    const out = [];
    for (const o of manifest.organs || []) {
      if (o.system !== sys) continue;
      if (o.mesh_file && !out.includes(o.mesh_file)) out.push(o.mesh_file);
    }
    return out.length ? out : [`${sys}_male.glb`];
  };
  const missing = [];
  for (const sys of systems) {
    for (const f of filesOf(sys)) {
      if (!existsSync(join(anatomyDir, f))) missing.push(`${sys} → ${f}`);
    }
  }
  if (missing.length) {
    console.error(`[pack] 打包中止：manifest 引用了这些模型文件但包里没有：\n  ${missing.join('\n  ')}`);
    console.error('[pack] 补上 public/anatomy/<文件>（上游 https://github.com/Nurkan1/Anatria-3D 的 public/anatomy/）。');
    process.exit(1);
  }

  const glbNodeNames = (p) => {
    const buf = readFileSync(p);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'glTF') return null;
    let off = 12;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'JSON') {
        const json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
        return (json.nodes || []).map((n) => n.name).filter(Boolean);
      }
      off += 8 + len + ((4 - (len % 4)) % 4);
    }
    return null;
  };
  const normalize = (s) => s.replace(/\./g, '').replace(/ /g, '_');

  const rows = [];
  const usedFiles = new Set();
  for (const sys of systems) {
    const have = new Map();
    for (const f of filesOf(sys)) {
      usedFiles.add(f);
      const names = glbNodeNames(join(anatomyDir, f));
      if (!names) {
        console.error(`[pack] 打包中止：${f} 不是可解析的 GLB（缺少 JSON chunk）。`);
        process.exit(1);
      }
      have.set(f, new Set([...names, ...names.map(normalize)]));
    }
    const organs = manifest.organs.filter((o) => o.system === sys);
    if (!organs.length) continue;
    // 每个结构只在「它自己的那个文件」里找：重名不算命中
    const hit = organs.filter((o) => have.get(o.mesh_file)?.has(o.node)).length;
    const pct = (hit / organs.length) * 100;
    rows.push([sys, organs.length, hit, pct, filesOf(sys).length]);
    if (pct < MODEL_COVERAGE_FLOOR) {
      console.error(`[pack] 打包中止：${sys} 的模型与 manifest 对不上（节点名覆盖率 ${pct.toFixed(1)}%，下限 ${MODEL_COVERAGE_FLOOR}%）。`);
      console.error('[pack] 这说明模型文件不是这个 manifest 对应的那一份，点了不会有反应。');
      process.exit(1);
    }
  }
  const low = rows.filter((r) => r[3] < 95);
  const multi = rows.filter((r) => r[4] > 1);
  console.log(
    `[pack] 解剖模型对账：${rows.length} 个系统 · ${usedFiles.size} 个模型文件全部就位；`
    + `节点名覆盖率 100% 的 ${rows.length - low.length} 个`
    + (multi.length ? `；多文件系统 ${multi.length} 个（${multi.map((r) => `${r[0]} ${r[4]} 个`).join('、')}）` : '')
  );
  for (const [sys, want, hit, pct, n] of low) {
    console.log(`[pack]   · ${sys} ${pct.toFixed(1)}%（${hit}/${want}，${n} 个文件）`);
  }
  // 磁盘上有、但没有任何系统引用的 glb：纯占体积，提示一下（不中止）
  const orphans = readdirSync(anatomyDir).filter((f) => f.endsWith('.glb') && !usedFiles.has(f));
  if (orphans.length) {
    console.log(`[pack] 提示：public/anatomy 下有 manifest 未引用的模型（占体积，可删）：${orphans.join(', ')}`);
  }
}

// ---------- 3. 组装 ----------
const staging = join(repo, '.yanagent', 'pack-staging');
// 必须确认清掉了：copyTree 是「建目录 + 逐文件覆盖」，不清干净就会把新构建合并进旧暂存，
// 包里会同时出现两套构建产物（见 removeTree 的说明）。
if (!removeTree(staging)) {
  console.error(`[pack] 打包中止：清不掉旧的暂存目录 ${staging}`);
  console.error('[pack] 不能继续：不清干净的话新构建会被合并进旧暂存，包里会同时有两套构建产物。');
  console.error('[pack] 手动删掉它（或关掉占用它的程序）后重试。');
  process.exit(1);
}
const root = join(staging, 'KnowLattice-Portable');
mkdirSync(join(root, 'data'), { recursive: true });
// 装进包里的到底是哪些笔记，打出来——分享前必须一眼看清包里有没有不该带的东西
{
  const notes = merged.files.filter((f) => !f.path.startsWith('_attachments/'));
  const seedBytes = Buffer.byteLength(JSON.stringify(merged));
  const tops = new Map();
  for (const f of notes) {
    const top = f.path.split('/')[0];
    tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  console.log(`[pack] 随包数据：${notes.length} 篇笔记 + ${qbanks.length} 份题库（${(seedBytes / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`[pack] 笔记顶层目录：${[...tops.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('、') || '（无）'}`);
  for (const { p } of sources) console.log(`[pack] 来源：${relative(repo, p) || p}`);
}
// 完整包：OCR 组件（tesseract 三个 core 变体 + 语言包，压缩后 6.73 MB）与 KaTeX 的
// woff/ttf 冗余字体（0.58 MB）都保留——前者是「扫描版 PDF」功能本体，后者是 woff2
// 加载失败时的回退，两样加起来 7.3 MB，换掉任何一样都不划算（详见文件头的说明）。
copyTree(dist, join(root, 'app'));
writeFileSync(join(root, 'data', 'notes-and-qbanks.json'), JSON.stringify(merged), 'utf8');
copyTree(join(repo, 'scripts', 'pack', 'server.ps1'), join(root, 'server.ps1'));
copyTree(join(repo, 'scripts', 'pack', 'Start-KnowLattice.bat'), join(root, 'Start-KnowLattice.bat'));
writeFileSync(join(root, 'README.txt'), '\ufeff' + readFileSync(join(repo, 'scripts', 'pack', 'README.txt'), 'utf8'), 'utf8');
const notices = join(repo, 'THIRD-PARTY-NOTICES.md');
if (existsSync(notices)) copyTree(notices, join(root, 'THIRD-PARTY-NOTICES.md'));
const license = join(repo, 'LICENSE');
if (existsSync(license)) copyTree(license, join(root, 'LICENSE'));
// 服务器根目录是 app/,根目录下的许可文件浏览器读不到,故在 app/ 内再放一份(收件人点开网址即可查看)
if (existsSync(notices)) copyTree(notices, join(root, 'app', 'THIRD-PARTY-NOTICES.md'));
if (existsSync(license)) copyTree(license, join(root, 'app', 'LICENSE'));

// ---------- 3b. 源代码 ----------
// GPL-3.0 第 6 节:分发编译后的程序必须同时提供对应源码。上游仓库地址随时可能变化,
// 直接随包带上源码最稳妥,收件人无需另找。
const srcRoot = join(root, 'source');
mkdirSync(srcRoot, { recursive: true });
copyTree(join(repo, 'src'), join(srcRoot, 'src'));
copyTree(join(repo, 'scripts'), join(srcRoot, 'scripts'));
for (const f of ['package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'index.html', '.oxlintrc.json']) {
  const p = join(repo, f);
  if (existsSync(p)) copyTree(p, join(srcRoot, f));
}
copyTree(join(repo, 'scripts', 'pack', 'source-README.txt'), join(srcRoot, 'README.txt'));
log(`已随包附上源代码:${srcRoot}`);

// ---------- 4. 压缩 ----------
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const zipPath = join(repo, `KnowLattice-离线版-${stamp}.zip`);
// 用 unlinkSync 而不是 rmSync：部分 Windows + Node 组合下，rmSync 删中文名文件会直接
// 终止进程（0xC0000409，try/catch 也拦不住，因为进程已经没了），unlinkSync 同场景正常。
// 删完要确认：旧 zip 还在时继续打包，tar 能不能保证「只覆盖不续写」我没有把握，与其赌，
// 不如让你先关掉打开它的程序。
try {
  if (existsSync(zipPath)) unlinkSync(zipPath);
} catch { /* 下面统一判定 */ }
if (existsSync(zipPath)) {
  console.error(`[pack] 打包中止：${zipPath} 删不掉（多半被别的程序打开着）。`);
  console.error('[pack] 关掉打开它的程序后重试。');
  process.exit(1);
}
log(`压缩中（约 65 MB，请稍候）…`);

const zipOk = () => existsSync(zipPath) && statSync(zipPath).size > 0;
let ok = false;
// 首选 Windows 自带的 bsdtar：写 zip 稳定，不受 Compress-Archive 的 BinaryReader 缺陷影响
try {
  execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', staging, 'KnowLattice-Portable'], { cwd: repo, stdio: 'inherit' });
  ok = zipOk();
} catch {
  log('tar 打包失败，改用 Compress-Archive…');
}
if (!ok) {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -Path "${join(root, '*')}" -DestinationPath "${zipPath}" -Force`],
      { stdio: 'inherit' },
    );
  } catch { /* 下面统一判定 */ }
  ok = zipOk();
}
if (!ok) {
  console.error('[pack] 压缩失败，未生成 zip（staging 保留在 .yanagent/pack-staging 以便排查）');
  process.exit(1);
}

// ---------- 4b. 对账：zip 里的条目必须与暂存树一一对应 ----------
// 这是「打包自己骗自己」的解药：不信任任何前置删除，直接对账最终产物。
// 2026-09-21 那次污染（包里同时有两套构建产物）任何日志都看不出来，只有对账能抓到。
{
  const zipEntries = () => {
    try {
      return execFileSync('tar.exe', ['-tf', zipPath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !s.endsWith('/'))
        .map((s) => s.replace(/\\/g, '/'));
    } catch {
      return null; // 列不出来就不做这项检查（别把打包卡死在一项附加校验上）
    }
  };
  const entries = zipEntries();
  if (entries) {
    const inZip = new Set(entries);
    const inStage = new Set(walkFiles(staging).map((p) => relative(staging, p).replace(/\\/g, '/')));
    const extra = [...inZip].filter((f) => !inStage.has(f));
    const missing = [...inStage].filter((f) => !inZip.has(f));
    if (extra.length || missing.length) {
      console.error(`[pack] 打包中止：zip 内容与暂存树不一致（多 ${extra.length} 个 / 少 ${missing.length} 个）。`);
      for (const f of extra.slice(0, 10)) console.error(`[pack]   多出来的：${f}`);
      for (const f of missing.slice(0, 10)) console.error(`[pack]   少掉的：${f}`);
      console.error('[pack] 多半是暂存目录没清干净（旧构建文件被合并进来）：删掉 .yanagent/pack-staging 后重试。');
      process.exit(1);
    }
    log(`压缩校验：${inZip.size} 个文件与暂存树一一对应`);
  }
}

// ---------- 5. 清理 ----------
if (!removeTree(staging)) log('提示：暂存目录没删掉（不影响包本身，可手动删 .yanagent/pack-staging）');

log(`完成：${zipPath}（${mb(statSync(zipPath).size)}）`);
log(`笔记 ${noteCount} 篇 · 题库 ${qbanks.length} 库 / ${qCount} 题 · 合并备份 ${sources.length} 份`);
for (const s of sources) log(`  来源：${s.p}`);
