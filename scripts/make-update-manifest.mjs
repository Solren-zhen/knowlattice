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
 * 只构建了一个平台时（Windows 在本机、macOS 在 CI），默认把**同版本已发布**的清单合并进来：
 * 否则后发布的一方会把另一个平台从清单里挤掉，端侧表现为「另一个系统突然收不到更新」。
 * 加 --no-merge 关闭合并；加 --merge <url|文件> 指定合并源（默认取该版本 Release 的 latest.json）。
 * 加 --keep-published 时，已发布清单里的平台**优先于**本次本地构建 —— 用于只重构建了部分
 * 平台、不想动线上正在分发的那一份（例如线上 Windows 已发布且已通，本次只补 macOS）。
 *
 * 学生端应用启动时会自动检查 https://github.com/Solren-zhen/knowlattice/releases/latest/download/latest.json
 * 发现新版本就自动下载安装并重启（签名不符的安装包会被拒绝）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const releaseBase = `https://github.com/Solren-zhen/knowlattice/releases/download/v${version}`;

// 各处版本必须一致：Tauri 实际读 tauri.conf.json，但 npm / Cargo 各自决定发布说明与安装信息。
// 漂移了就在这里拦下，别让 latest.json 和真实产物对不上（只会表现为用户永远收不到更新）。
{
  const pkgVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const lockVersion = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).version;
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repo, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];
  // package-lock.json 的根 version 也一起校验：它是唯一一个手工改 package.json 时不会被
  // npm 带着更新的地方（历史上就在这里漂了 0.1.1 一直到 0.2.0）。
  for (const [what, v] of [['package.json', pkgVersion], ['package-lock.json', lockVersion], ['src-tauri/Cargo.toml', cargoVersion]]) {
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
const signedIn = (dir, re) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n) && existsSync(join(dir, `${n}.sig`))) : [];

// 签名文件里带 `version:X.Y.Z`（tauri 生成）。文件名可能不带版本号（macOS 的 KnowLattice.app.tar.gz），
// 单看目录名会把上一代的跨平台构建产物当成当次的，写进清单就是指向不存在的 Release 资产。
// 这里按签名内的版本再筛一遍：读不出或对不上都视为过期，宁缺勿错。
const signatureVersion = (dir, name) => {
  try {
    const raw = readFileSync(join(dir, `${name}.sig`), 'utf8').trim();
    const text = Buffer.from(raw, 'base64').toString('utf8');
    return /(?:^|\s)version:(\S+)/.exec(text)?.[1] ?? '';
  } catch {
    return '';
  }
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

// `target/` 不会自动清，目录里常常同时留着上一代的包（本次就出现过 0.2.0 与 0.2.1 并存）。
// 按「文件名里的版本号」把候选分成当次的和过期的：有当次的就用当次的，只剩过期的才中止 ——
// 否则会把上一代的包写成这一代的 Release 地址（用户端下载到错版本）。
// 文件名不带版本号的（tauri 原生的 KnowLattice.app.tar.gz）视为当次。
const versionOf = (name) => /(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? '';

const platforms = {};
const missing = [];
const outDirs = [];
const ignored = [];
for (const { platform, dir, re } of candidates) {
  if (platforms[platform]) continue; // 同一平台出现多个目录时只取第一个
  const found = signedIn(dir, re).filter((n) => signatureVersion(dir, n) === version);
  const current = found.filter((n) => {
    const v = versionOf(n);
    return !v || v === version;
  });
  const stale = found.filter((n) => versionOf(n) && versionOf(n) !== version);
  if (!current.length) {
    if (stale.length) {
      console.error(`[${platform}] 只找到过期的产物 ${stale.join('、')}（当前版本 ${version}）：先重新构建，别拿上一代的包发版。`);
      process.exit(1);
    }
    missing.push(platform);
    continue;
  }
  if (stale.length) ignored.push(`${platform}: ${stale.join('、')}`);
  const file = current[0];
  outDirs.push(dir);
  platforms[platform] = {
    signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
    url: `${releaseBase}/${encodeURIComponent(file)}`,
  };
  console.log(`  ${platform} ← ${file}`);
}
for (const note of ignored) console.log(`  （忽略非当前版本的旧产物）${note}`);

if (Object.keys(platforms).length === 0) {
  console.error('未找到任何平台的 .sig 签名文件，请先 npm run tauri build');
  process.exit(1);
}

// 本机 Windows 打包、CI 上 macOS 打包，两边各自只看得到自己平台的产物。默认把同版本已发布的
// 清单合并进来：本地产物优先，线上独有的平台保留 —— 谁先谁后最终都收敛到两个平台的并集。
// 线上还没有该版本（首发）或取不到时，退回只写本地构建出的平台。
const mergeIndex = process.argv.indexOf('--merge');
const keepPublished = process.argv.includes('--keep-published');
const mergeSource = process.argv.includes('--no-merge')
  ? null
  : mergeIndex >= 0
    ? process.argv[mergeIndex + 1]
    : `${releaseBase}/latest.json`;

// Node 自带的 fetch 在部分环境（代理、企业网络）会直接失败，而系统 curl 通常可用，
// 所以远程合并源优先走 curl，失败再退回 fetch。
const fetchJson = async (url) => {
  const res = spawnSync('curl', ['-sSL', '--max-time', '60', url], { encoding: 'utf8', maxBuffer: 8 << 20 });
  if (res.status === 0 && res.stdout) return JSON.parse(res.stdout);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

if (mergeSource) {
  try {
    let published;
    if (/^https?:/i.test(mergeSource)) {
      published = await fetchJson(mergeSource);
    } else {
      if (!existsSync(mergeSource)) throw new Error('文件不存在');
      published = JSON.parse(readFileSync(mergeSource, 'utf8'));
    }
    if (published?.version !== version) {
      console.log(`  合并源是 v${published?.version ?? '未知'}，与当前 v${version} 不同版本，跳过合并`);
    } else {
      for (const [platform, entry] of Object.entries(published.platforms ?? {})) {
        if (!entry?.url || !entry?.signature) continue;
        const local = platforms[platform];
        if (local && !keepPublished) continue;
        platforms[platform] = { signature: entry.signature, url: entry.url };
        console.log(`  ${platform} ← 已发布清单（${local ? '覆盖本次本地构建' : '本次未构建该平台'}）`);
      }
    }
  } catch (e) {
    console.log(`  合并已发布清单失败（${e.message}），只写本地构建出的平台`);
  }
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
const stillMissing = missing.filter((p) => !platforms[p]);
if (stillMissing.length) console.log(`  跳过（未构建且线上也没有）：${stillMissing.join('、')}`);
console.log(`发布：GitHub Release tag=v${version}，上传 latest.json 及各平台的安装包 + .sig`);
