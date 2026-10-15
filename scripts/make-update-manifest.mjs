/**
 * 生成 latest.json（Tauri 更新清单），发布新版本的三步操作：
 *
 *   1. npm run tauri build                          # 产出安装包 + .sig 签名
 *   2. node scripts/make-update-manifest.mjs        # 在 bundle/nsis/ 下生成 latest.json
 *   3. GitHub 新建 Release（tag = vX.Y.Z），上传 latest.json 和所有列出的产物 + .sig
 *      - Windows：KnowLattice_X.Y.Z_x64-setup.exe / *.sig
 *      - macOS：KnowLattice.app.tar.gz / *.sig（上传时可按平台改名，清单按磁盘上的实际
 *        文件名写 URL —— 名字对不上就是 macOS 端 404）
 *
 * 清单按平台自动收录：哪个平台的 .sig 签名文件存在，就写入哪个平台的条目
 * （Windows 产物在 bundle/nsis/，macOS 产物在 bundle/macos/，两个平台都构建则都收录）。
 *
 * 学生端应用启动时会自动检查 https://github.com/Solren-zhen/knowlattice/releases/latest/download/latest.json
 * 发现新版本就自动下载安装并重启（签名不符的安装包会被拒绝）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const releaseBase = `https://github.com/Solren-zhen/knowlattice/releases/download/v${version}`;

// 三处版本必须一致：Tauri 实际读 tauri.conf.json，但 npm / Cargo 各自决定发布说明与安装信息。
// 漂移了就在这里拦下，别让 latest.json 和真实产物对不上（只会表现为用户永远收不到更新）。
{
  const pkgVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repo, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];
  for (const [what, v] of [['package.json', pkgVersion], ['src-tauri/Cargo.toml', cargoVersion]]) {
    if (v !== version) {
      console.error(`版本不一致：tauri.conf.json=${version}，${what}=${v}。先把三处版本号统一再发布。`);
      process.exit(1);
    }
  }
}

// 各平台的更新器产物目录。带 `--target <triple>` 构建时产物在 target/<triple>/release/bundle/，
// 不带则落在 target/release/bundle/。两种都探 —— 否则在 Mac 上按文件头的注释直接
// `npm run tauri build` 之后跑本脚本，会连 nsis 目录都不存在、崩在写 latest.json 上。
const targetRoot = join(repo, 'src-tauri', 'target');
const bundleDirs = (kind) => {
  const out = [];
  if (!existsSync(targetRoot)) return out;
  for (const e of readdirSync(targetRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'release' || e.name === 'debug') continue;
    const dir = join(targetRoot, e.name, 'release', 'bundle', kind);
    if (existsSync(dir)) out.push({ dir, triple: e.name });
  }
  const plain = join(targetRoot, 'release', 'bundle', kind);
  if (existsSync(plain)) out.push({ dir: plain, triple: '' });
  return out;
};

// macOS 的平台键必须与实际构建的 triple 对应：固定写 darwin-aarch64 会让 Intel Mac
// 永远查不到更新（updater 按运行架构查 darwin-x86_64）。
const darwinPlatform = (triple) =>
  triple.includes('x86_64') ? 'darwin-x86_64' : triple.includes('aarch64') ? 'darwin-aarch64' : null;

// 文件名从磁盘上**实际存在**的那个读出来，不写死：Release 资产的 URL 就是上传时的文件名。
// 写死的名字一旦和真实资产不一致，端侧就是静默 404 —— macOS 侧尤其容易踩，因为
// tauri 的产物叫 KnowLattice.app.tar.gz，而人工上传时通常会按平台改成名带架构的那种。
const findSigned = (dir, re) => {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (re.test(name) && existsSync(join(dir, `${name}.sig`))) return { dir, file: name };
  }
  return null;
};

const candidates = [
  ...bundleDirs('nsis').map(({ dir }) => ({ platform: 'windows-x86_64', dir, re: /-setup\.exe$/i })),
  ...bundleDirs('macos').map(({ dir, triple }) => {
    const platform = darwinPlatform(triple);
    if (!platform) {
      console.warn(`[warn] ${dir}：目录名里看不出目标架构，按 aarch64 记入清单，请自行确认 --target。`);
    }
    return { platform: platform ?? 'darwin-aarch64', dir, re: /\.app\.tar\.gz$/i };
  }),
];

const platforms = {};
const missing = [];
const outDirs = [];
for (const { platform, dir, re } of candidates) {
  if (platforms[platform]) continue; // 同一平台出现多个目录时只取第一个
  const hit = findSigned(dir, re);
  if (!hit) {
    missing.push(platform);
    continue;
  }
  outDirs.push(hit.dir);
  platforms[platform] = {
    signature: readFileSync(join(hit.dir, `${hit.file}.sig`), 'utf8').trim(),
    url: `${releaseBase}/${encodeURIComponent(hit.file)}`,
  };
  console.log(`  ${platform} ← ${hit.file}`);
}

if (Object.keys(platforms).length === 0) {
  console.error('未找到任何平台的 .sig 签名文件，请先 npm run tauri build');
  process.exit(1);
}

const manifest = {
  version,
  notes: `晶格 · KnowLattice v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};
// 写到实际产出了签名的目录；一个都没有时（理论上到不了这里）退回仓库根，.gitignore 已忽略 /latest.json
const out = join(outDirs[0] ?? repo, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json 已生成（v${version}）→ ${out}`);
for (const platform of Object.keys(platforms)) console.log(`  含平台：${platform}`);
if (missing.length) console.log(`  跳过（未构建）：${missing.join('、')}`);
console.log(`发布：GitHub Release tag=v${version}，上传 latest.json 及各平台的安装包 + .sig`);
