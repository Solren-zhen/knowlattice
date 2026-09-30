/**
 * 生成 latest.json（Tauri 更新清单），发布新版本的三步操作：
 *
 *   1. npm run tauri build                          # 产出安装包 + .sig 签名
 *   2. node scripts/make-update-manifest.mjs        # 在 bundle/nsis/ 下生成 latest.json
 *   3. GitHub 新建 Release（tag = vX.Y.Z），上传 latest.json 和所有列出的产物 + .sig
 *      - Windows：KnowLattice_X.Y.Z_x64-setup.exe / *.sig
 *      - macOS：KnowLattice.app.tar.gz / *.sig
 *
 * 清单按平台自动收录：哪个平台的 .sig 签名文件存在，就写入哪个平台的条目
 * （Windows 产物在 bundle/nsis/，macOS 产物在 bundle/macos/，两个平台都构建则都收录）。
 *
 * 学生端应用启动时会自动检查 https://github.com/Solren-zhen/knowlattice/releases/latest/download/latest.json
 * 发现新版本就自动下载安装并重启（签名不符的安装包会被拒绝）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const releaseBase = `https://github.com/Solren-zhen/knowlattice/releases/download/v${version}`;

// 各平台的更新器产物路径（.sig 与安装包同目录同名）
const artifacts = [
  {
    platform: 'windows-x86_64',
    dir: join(repo, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
    fileName: `KnowLattice_${version}_x64-setup.exe`,
  },
  {
    platform: 'darwin-aarch64',
    dir: join(repo, 'src-tauri', 'target', 'release', 'bundle', 'macos'),
    fileName: 'KnowLattice.app.tar.gz',
  },
];

const platforms = {};
const missing = [];
for (const { platform, dir, fileName } of artifacts) {
  const sigFile = join(dir, `${fileName}.sig`);
  if (!existsSync(sigFile)) {
    missing.push(platform);
    continue;
  }
  platforms[platform] = {
    signature: readFileSync(sigFile, 'utf8').trim(),
    url: `${releaseBase}/${encodeURIComponent(fileName)}`,
  };
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
const out = join(artifacts[0].dir, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json 已生成（v${version}）→ ${out}`);
for (const platform of Object.keys(platforms)) console.log(`  含平台：${platform}`);
if (missing.length) console.log(`  跳过（未构建）：${missing.join('、')}`);
console.log(`发布：GitHub Release tag=v${version}，上传 latest.json 及各平台的安装包 + .sig`);
