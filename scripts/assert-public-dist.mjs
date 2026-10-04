import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 公开发布守卫（2026-10-04 审计 S2 扩展）：
 *  - 内容扫描扩展名白名单补齐 md/svg/webmanifest（这些格式同样能藏备份片段/密钥/绝对路径）；
 *  - 新增 sk-/Bearer Token/用户绝对路径三类泄密内容规则；
 *  - 支持传入目标目录（缺省 dist）。pack.mjs 会对暂存包再跑一遍本守卫（审计 S1）。
 *
 * 用法：node scripts/assert-public-dist.mjs [目录]
 */

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argPath = process.argv[2];
// 相对路径按当前工作目录解析；绝对路径直接用（Windows 下 join 会把盘符路径拼坏）。
const target = argPath
  ? (await import('node:path')).isAbsolute(argPath) ? argPath : join(process.cwd(), argPath)
  : join(repo, 'dist');

if (!existsSync(target)) {
  console.error(`[public-guard] 目标目录不存在，无法检查公开产物：${target}`);
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
walk(target);

const forbiddenPath = /(?:knowlattice-导入-|knowlattice-题库|题库)/i;
// notes-and-qbanks.json 是离线包自带的数据文件名（pack.mjs 固定写入），单独列出来：
// dist 里出现它 = 打包数据混进构建产物（真泄漏）；离线包暂存树里出现它 = 预期文件，
// 不按文件名报警，只对其内容做备份/密钥扫描（见 packStaging 参数）。
const forbiddenPackDataPath = /(?:^|\/)notes-and-qbanks\.json$/i;
// 备份文件「带了用户数据」才算泄漏：按**非空载荷**判定，不能只看 {"app":"knowlattice","version":…}
// 这个头部——pack 在没有 --data 时也会写一份空模板（files/questions/mistakes/todos 全为空数组），
// 那种文件里没有任何用户内容，按头部判定会把默认的 `npm run pack` 直接拦下（2026-10-04 实测踩到）。
const forbiddenContent = /"files"\s*:\s*\[\s*\{|"questions"\s*:\s*\[\s*\{\s*"id"|"(?:mistakes|todos)"\s*:\s*\[\s*\{|"(?:srs|days|cardEdits)"\s*:\s*\{\s*"/;
// 签名/私钥材料绝不能进公开产物（泄露=任何人可推假更新）：按文件名与内容各查一遍。
// 注意：src-tauri/tauri.conf.json 里的 updater pubkey 是公开公钥，不匹配下列内容模式。
const forbiddenSecretPath = /(?:^|\/)(?:private\.key|.*\.pem|.*\.p12|.*\.pfx)$/i;
const forbiddenSecretContent = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|minisign (?:encrypted )?secret key/i;
// 审计 S2 新增：三类通用泄密内容。
//  - 云厂商密钥前缀（OpenAI/Anthropic/DeepSeek 等常见 sk- 形态，长度卡 20+ 降噪）；
//  - Authorization 头常见的 Bearer Token；
//  - 构建者本机绝对路径（Windows 盘符与 macOS /Users/<name>、Linux /home/<name>）。
//    误报经验：Emscripten 打包的 wasm 运行时里到处是 `/home/web_user`（固定占位用户名，
//    不是构建者隐私），必须排除；`/home/` 与 `/Users/` 还要求用户名段后必须跟引号/空白
//    结束或直接收尾，避免把 URL 路径（/home/xxx/yyy）整段吞进来。
const forbiddenKeyContent = /\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer [A-Za-z0-9._-]{20,}\b|[A-Za-z]:\\Users\\[^"'\s\\]+|\/(?:Users|home)\/(?!web_user\/?)[A-Za-z0-9._-]+(?=[\s"';,)\]}]|$)/;
const leaks = [];
// 离线包暂存树自带 data/notes-and-qbanks.json（pack 固定文件名），扫描它时豁免文件名
// 规则、保留内容规则——文件名本身不泄漏任何东西，内容才可能泄漏。
const packStaging = process.env.PACK_STAGING === '1';
for (const file of files) {
  const name = relative(target, file).replaceAll('\\', '/');
  const isPackData = packStaging && forbiddenPackDataPath.test(name);
  if (forbiddenPath.test(name)) leaks.push(`${name}（文件名）`);
  if (!isPackData && forbiddenPackDataPath.test(name)) leaks.push(`${name}（文件名）`);
  if (forbiddenSecretPath.test(name)) leaks.push(`${name}（私钥文件名）`);
  // 白名单补齐 md/svg/webmanifest：docx 预览、PWA 清单等新产物类型不该漏检。
  if (!/\.(?:html|js|css|json|txt|map|md|svg|webmanifest)$/i.test(name)) continue;
  const content = readFileSync(file, 'utf8');
  if (forbiddenContent.test(content)) leaks.push(`${name}（内容）`);
  if (forbiddenSecretContent.test(content)) leaks.push(`${name}（私钥内容）`);
  if (forbiddenKeyContent.test(content)) leaks.push(`${name}（密钥/本机路径内容）`);
}

if (leaks.length) {
  console.error(`[public-guard] ${relative(repo, target) || target} 疑似包含私有题库/备份/私钥，已阻止发布：`);
  for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
  process.exit(1);
}

console.log(`[public-guard] 通过：已检查 ${files.length} 个公开文件（${relative(repo, target) || target}），未发现私有题库、备份、密钥或本机路径。`);
