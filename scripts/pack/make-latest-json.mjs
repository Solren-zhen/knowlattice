/**
 * 生成 Tauri 更新器所需的 latest.json。
 *
 * 背景：tauri.conf.json 的 updater 端点指向 GitHub Releases 的 latest.json，
 * 但 v2026.09.30 发布时没有上传这个文件，桌面版自动更新一直处于失效状态
 * （已装用户不会收到任何更新提示）。本脚本在本地构建出带签名的更新产物后，
 * 扫描 target/release/bundle 生成 latest.json，配合 Release 一起上传即可恢复。
 *
 * 用法（先完成一次完整构建）：
 *   npm run tauri build
 *   node scripts/pack/make-latest-json.mjs --tag v2026.10.02
 *
 * 然后把以下文件上传到该 Release（Assets）：
 *   - target/release/bundle/nsis/*-setup.exe 和同名 .sig
 *   - target/release/bundle/macos/*.app.tar.gz 和同名 .sig（macOS 更新必需，仅 dmg 不够）
 *   - 生成的 latest.json
 *
 * 私钥口令只在你本机构建时使用（TAURI_SIGNING_PRIVATE_KEY / _PASSWORD），不进仓库。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const tagIdx = args.indexOf('--tag');
const tag = tagIdx >= 0 ? args[tagIdx + 1] : null;
if (!tag || tag.startsWith('--')) {
  console.error('用法：node scripts/pack/make-latest-json.mjs --tag <release标签，如 v2026.10.02>');
  process.exit(1);
}

const conf = JSON.parse(readFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const bundle = join(repo, 'src-tauri', 'target', 'release', 'bundle');
const base = `https://github.com/Solren-zhen/knowlattice/releases/download/${tag}`;

/** bundle 子目录 → 更新器平台名；每个目录里找「主产物 + 同名 .sig」 */
const scanners = [
  { dir: 'nsis', platform: 'windows-x86_64', ext: '.exe' },
  { dir: 'macos', platform: 'darwin-aarch64', ext: '.app.tar.gz' },
  { dir: 'dmg', platform: 'darwin-aarch64', ext: '.dmg' },
];

const platforms = {};
for (const { dir, platform, ext } of scanners) {
  const d = join(bundle, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(ext) || f.endsWith('.sig')) continue;
    const sigPath = join(d, f + '.sig');
    if (!existsSync(sigPath)) {
      console.warn(`[latest-json] 跳过 ${dir}/${f}：没有同名 .sig（产物未签名？）`);
      continue;
    }
    platforms[platform] = {
      signature: readFileSync(sigPath, 'utf8').trim(),
      url: `${base}/${encodeURIComponent(f)}`,
    };
    console.log(`[latest-json] ${platform} → ${f}`);
    break; // 每平台取第一个命中即可（同目录若有历史版本产物，以先扫到的为准）
  }
}

if (!Object.keys(platforms).length) {
  console.error('[latest-json] bundle 里没有任何带 .sig 的产物。先 npm run tauri build（需设置 TAURI_SIGNING_PRIVATE_KEY）。');
  process.exit(1);
}

const out = {
  version,
  notes: `KnowLattice ${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};
const outPath = join(repo, 'latest.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`[latest-json] 已生成 ${outPath}（version ${version}，平台：${Object.keys(platforms).join('、')}）`);
console.log('[latest-json] 上传到 Release Assets：各主产物 + .sig + 本 latest.json，自动更新即恢复。');
