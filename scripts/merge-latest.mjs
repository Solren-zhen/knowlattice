#!/usr/bin/env node
/**
 * 合并多份 latest.json（Windows / macOS arm64 / macOS x86_64 各生成一份）。
 *
 * 为什么需要：`make-update-manifest.mjs` 只认识本机 target/ 下真实存在的产物，
 * 双平台各自的构建机看不到对方。CI 里三个 job 各出一份单平台清单，最后在这里取并集，
 * 得到「一次上传、两端都能更新」的 latest.json。
 *
 * 用法：node scripts/merge-latest.mjs a.json b.json c.json [-o latest.json]
 * 规则：版本必须一致（不一致直接失败，避免发出版本错位的清单）；同平台后者覆盖前者。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args[outIdx + 1] : 'latest.json';
// 没有 -o 时 outIdx 为 -1，旧的 `i !== outIdx + 1` 会把第 0 个文件悄悄丢掉
// （CI 上表现：三个平台清单只合并了两份，darwin-aarch64 从 latest.json 里消失）。
const files = outIdx >= 0
  ? args.filter((_, i) => i !== outIdx && i !== outIdx + 1)
  : args.filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.error('用法: node scripts/merge-latest.mjs <latest.json...> [-o 输出文件]');
  process.exit(1);
}

const versions = new Set();
const platforms = {};
let notes = '';
for (const file of files) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version) versions.add(manifest.version);
  if (!notes && manifest.notes) notes = manifest.notes;
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    if (!entry?.url || !entry?.signature) continue;
    platforms[platform] = { signature: entry.signature, url: entry.url };
  }
}

if (versions.size !== 1) {
  console.error(`版本不一致：${[...versions].join('、') || '（没有读到版本）'}。先统一四处版本号再发布。`);
  process.exit(1);
}
if (!Object.keys(platforms).length) {
  console.error('没有可合并的平台条目（url 或 signature 缺失）。');
  process.exit(1);
}

const version = [...versions][0];
const merged = {
  version,
  notes: notes || `晶格 · KnowLattice v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`已合并 ${files.length} 份清单 → ${outFile}（v${version}）`);
for (const platform of Object.keys(platforms)) console.log(`  ${platform}`);
