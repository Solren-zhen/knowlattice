import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(repo, 'dist');

if (!existsSync(dist)) {
  console.error('[public-guard] dist 不存在，无法检查公开构建产物。');
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
};
walk(dist);

const forbiddenPath = /(?:knowlattice-导入-|knowlattice-题库|notes-and-qbanks|题库)/i;
const forbiddenContent = /"app"\s*:\s*"(?:medvault|knowlattice)"\s*,\s*"(?:version|exportedAt|files)"|"questions"\s*:\s*\[\s*\{\s*"id"/;
const leaks = [];
for (const file of files) {
  const name = relative(dist, file).replaceAll('\\', '/');
  if (forbiddenPath.test(name)) leaks.push(`${name}（文件名）`);
  if (!/\.(?:html|js|css|json|txt|map)$/i.test(name)) continue;
  const content = readFileSync(file, 'utf8');
  if (forbiddenContent.test(content)) leaks.push(`${name}（内容）`);
}

if (leaks.length) {
  console.error('[public-guard] 构建产物疑似包含私有题库/备份，已阻止发布：');
  for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
  process.exit(1);
}

console.log(`[public-guard] 通过：已检查 ${files.length} 个公开构建文件，未发现私有题库或备份。`);
