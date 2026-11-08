/**
 * vendor 目录的完整性校验（构建前跑）。
 *
 * 为什么需要：`xlsx` 走 `file:vendor/xlsx-0.20.3.tgz`（SheetJS 从 npm 撤包后的常见做法），
 * 这份 tarball **不受 npm registry 的 integrity 保护**——它就是一个本地二进制。
 * 只要有人（或某个脚本）替换了它，`npm ci` 会照装不误，构建也会照过，
 * 而导出的 Excel 里跑的是谁的代码没人知道。
 *
 * 这里把已知的哈希钉死：对不上就中止构建，让人先解释这次更换。
 * 升级 vendor 包的正确流程是：换文件 → 在本文件里更新期望哈希 → 提交时 diff 里看得到哈希变化。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 已知的 vendor 包哈希：键是 package.json 里写的相对路径 */
const PINNED = {
  'vendor/xlsx-0.20.3.tgz': '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
};

/** package.json 里所有 `file:` 依赖（含 devDependencies）：这些文件都应被钉住 */
function fileDeps() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.entries(all)
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'))
    .map(([name, spec]) => ({ name, path: spec.slice('file:'.length) }));
}

let failed = false;
const deps = fileDeps();
if (deps.length === 0) {
  console.log('[vendor-guard] 没有 file: 依赖，跳过');
  process.exit(0);
}

for (const dep of deps) {
  const expected = PINNED[dep.path];
  if (!expected) {
    console.error(`[vendor-guard] ${dep.name} → ${dep.path} 没有钉哈希。给它算一个 sha256 并写进 scripts/verify-vendor.mjs 的 PINNED。`);
    failed = true;
    continue;
  }
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(resolve(root, dep.path))).digest('hex');
  } catch (e) {
    console.error(`[vendor-guard] 读不到 ${dep.path}（${e.message}）。file: 依赖在 clone 后必须一起提交。`);
    failed = true;
    continue;
  }
  if (actual !== expected) {
    console.error(`[vendor-guard] ${dep.path} 的哈希对不上：\n  期望 ${expected}\n  实际 ${actual}\n若是主动升级，请同时更新 PINNED，并在提交说明里写清来源。`);
    failed = true;
    continue;
  }
  console.log(`[vendor-guard] ${dep.path} ✓ ${actual.slice(0, 12)}…`);
}

if (failed) process.exit(1);
