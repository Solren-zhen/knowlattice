/**
 * 打包「MedVault 离线版」：把构建产物 + 笔记/题库备份 + 零依赖启动器，组装成一个 zip。
 *
 * 用法：
 *   npm run pack                 # 先构建，再自动收集备份（应用导出的 / 根目录的 medvault-*.json）打包
 *   npm run pack -- --no-build   # 跳过构建，直接用现有 dist
 *   npm run pack -- --data <文件># 指定某一份备份 .json（例如你刚在应用里导出的那份）
 *
 * 产物：仓库根目录 MedVault-离线版-YYYY-MM-DD.zip（已在 .gitignore 中忽略）
 * 包内全部用 ASCII 名称，避免不同解压工具把中文条目解成乱码；说明文本用 UTF-8 BOM，记事本可直接读。
 */
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const dataIdx = args.indexOf('--data');
const explicitData = dataIdx >= 0 ? args[dataIdx + 1] : null;

const log = (...a) => console.log('[pack]', ...a);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// ---------- 1. 构建 ----------
if (!noBuild) {
  log('构建前端：npm run build …');
  const npm = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const npmArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', 'build'] : ['run', 'build'];
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
    return j && j.app === 'medvault' && Array.isArray(j.files) ? j : null;
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
  // 自动模式只取仓库根目录的 medvault-*.json（这些是应用导出的稳定副本），
  // 避免误收 Downloads 里的旧备份；要带上应用里刚导出的最新版，用 --data 指定。
  for (const f of readdirSync(repo).filter((f) => /^medvault-.*\.json$/.test(f)).sort()) {
    const b = loadBackup(join(repo, f));
    if (b) sources.push({ p: join(repo, f), b });
  }
}
if (sources.length === 0) {
  console.error('[pack] 没找到任何备份。放一份 medvault-*.json 到仓库根目录，或用 --data <文件> 指定。');
  process.exit(1);
}

const fileMap = new Map();
const qbanks = [];
const qNames = new Set();
let srs = null;
let mistakes = null;
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
}

const merged = {
  app: 'medvault',
  version: 2,
  exportedAt: new Date().toISOString(),
  files: [...fileMap].map(([path, content]) => ({ path, content })),
  srs: srs ?? {},
  qbanks,
  mistakes: mistakes ?? [],
};
const noteCount = merged.files.filter((f) => !f.path.startsWith('_attachments/')).length;
const qCount = qbanks.reduce((n, q) => n + ((q && q.questions && q.questions.length) || 0), 0);

// ---------- 3. 组装 ----------
const staging = join(repo, '.yanagent', 'pack-staging');
rmSync(staging, { recursive: true, force: true });
const root = join(staging, 'MedVault-Portable');
mkdirSync(join(root, 'data'), { recursive: true });
cpSync(dist, join(root, 'app'), { recursive: true });
writeFileSync(join(root, 'data', 'notes-and-qbanks.json'), JSON.stringify(merged), 'utf8');
cpSync(join(repo, 'scripts', 'pack', 'server.ps1'), join(root, 'server.ps1'));
cpSync(join(repo, 'scripts', 'pack', 'Start-MedVault.bat'), join(root, 'Start-MedVault.bat'));
writeFileSync(join(root, 'README.txt'), '\ufeff' + readFileSync(join(repo, 'scripts', 'pack', 'README.txt'), 'utf8'), 'utf8');
const notices = join(repo, 'THIRD-PARTY-NOTICES.md');
if (existsSync(notices)) cpSync(notices, join(root, 'THIRD-PARTY-NOTICES.md'));

// ---------- 4. 压缩 ----------
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const zipPath = join(repo, `MedVault-离线版-${stamp}.zip`);
rmSync(zipPath, { force: true });
log('压缩中（约 60 MB，请稍候）…');

const zipOk = () => existsSync(zipPath) && statSync(zipPath).size > 0;
let ok = false;
// 首选 Windows 自带的 bsdtar：写 zip 稳定，不受 Compress-Archive 的 BinaryReader 缺陷影响
try {
  execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', staging, 'MedVault-Portable'], { cwd: repo, stdio: 'inherit' });
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

// ---------- 5. 清理 ----------
rmSync(staging, { recursive: true, force: true });

log(`完成：${zipPath}（${mb(statSync(zipPath).size)}）`);
log(`笔记 ${noteCount} 篇 · 题库 ${qbanks.length} 库 / ${qCount} 题 · 合并备份 ${sources.length} 份`);
for (const s of sources) log(`  来源：${s.p}`);
