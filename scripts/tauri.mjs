/**
 * tauri CLI 包装：自动注入更新签名私钥（src-tauri/private.key，已在 .gitignore）。
 * 用法与 tauri CLI 一致：npm run tauri build / npm run tauri dev
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const keyFile = resolve(here, '..', 'src-tauri', 'private.key');
process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8').trim();
process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';

const cliJs = join(here, '..', 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const res = spawnSync(process.execPath, [cliJs, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
