#!/usr/bin/env node
/**
 * 从仓库自身重算功能地图，写到 docs/FEATURES.md。
 *
 * 数据源只有两处：
 *   - src/views/panelRegistry.ts：面板清单（id / 是否模态 / 轨入口）
 *   - src/views/railCatalog.tsx：导航轨分组与文案
 * 再加上目录结构统计，避免文档里的数字靠人记。
 *
 * 用法：node scripts/features-gen.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PANELS = join(ROOT, 'src/views/panelRegistry.ts');
const RAIL = join(ROOT, 'src/views/railCatalog.tsx');
const OUT = join(ROOT, 'docs/FEATURES.md');

/** 从面板注册表里抽 `{ id: 'x', rail?: 'y', modal: true|false }`（每个面板一条，逐行解析） */
function panels() {
  const src = readFileSync(PANELS, 'utf8');
  const rows = [];
  for (const line of src.split('\n')) {
    const m = /^\s*\{\s*id:\s*'([^']+)'(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const modal = /modal:\s*(true|false)/.exec(rest);
    if (!modal) continue;
    const rail = /rail:\s*'([^']+)'/.exec(rest)?.[1] ?? '';
    rows.push({ id: m[1], modal: modal[1] === 'true', rail });
  }
  return rows;
}

/** 从 railCatalog 里抽 RailKey 与每个分组的条目 */
function rail() {
  const src = readFileSync(RAIL, 'utf8');
  const groups = [];
  const groupRe = /title:\s*'([^']+)'[\s\S]{0,2000}?entries:\s*\[([\s\S]*?)\n\s*\]/g;
  let m;
  while ((m = groupRe.exec(src))) {
    const entries = [];
    const entryRe = /key:\s*'([^']+)'[\s\S]{0,80}?label:\s*'([^']+)'/g;
    let e;
    while ((e = entryRe.exec(m[2]))) entries.push({ key: e[1], label: e[2] });
    groups.push({ title: m[1], entries });
  }
  const keys = /export type RailKey\s*=\s*([\s\S]*?);/.exec(src)?.[1] ?? '';
  return { groups, keyCount: (keys.match(/'[^']+'/g) ?? []).length };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

function collectTests(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      collectTests(full, out);
    } else if (/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const panelRows = panels();
const railData = rail();
const dirs = ['src/core', 'src/views', 'src/storage', 'src/styles'];
const stats = dirs.map((dir) => {
  const files = walk(join(ROOT, dir));
  const lines = files.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  return { dir, files: files.length, lines };
});
const tests = collectTests(join(ROOT, 'src'));

const lines = [];
lines.push('# FEATURES · 功能地图（自动生成）');
lines.push('');
lines.push('> 本文件由 `node scripts/features-gen.mjs` 从 `panelRegistry.ts` / `railCatalog.tsx` 与目录结构重算。');
lines.push('> **不要手改**：改完面板或导航后重跑脚本覆盖。');
lines.push('');
lines.push('## 汇总');
lines.push('');
lines.push('| 面板 | 整屏模态 | 导航轨入口 | 源文件 | 源码行数 | 测试文件 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
lines.push(`| ${panelRows.length} | ${panelRows.filter((p) => p.modal).length} | ${railData.keyCount} | ${stats.reduce((n, s) => n + s.files, 0)} | ${stats.reduce((n, s) => n + s.lines, 0)} | ${tests.length} |`);
lines.push('');
lines.push('## 面板（panelRegistry.ts）');
lines.push('');
lines.push('| id | 导航轨入口 | 类型 |');
lines.push('| --- | --- | --- |');
for (const p of panelRows) lines.push(`| \`${p.id}\` | ${p.rail ? '`' + p.rail + '`' : '—'} | ${p.modal ? '整屏模态' : '可共存浮层'} |`);
lines.push('');
lines.push('## 导航轨（railCatalog.tsx）');
lines.push('');
for (const g of railData.groups) {
  lines.push(`### ${g.title}（${g.entries.length}）`);
  lines.push('');
  lines.push('| key | 文案 |');
  lines.push('| --- | --- |');
  for (const e of g.entries) lines.push(`| \`${e.key}\` | ${e.label} |`);
  lines.push('');
}
lines.push('## 目录规模');
lines.push('');
lines.push('| 目录 | 文件 | 行数 |');
lines.push('| --- | --- | --- |');
for (const s of stats) lines.push(`| \`${s.dir}/\` | ${s.files} | ${s.lines} |`);
lines.push('');
lines.push('## 维护');
lines.push('');
lines.push('- 新增面板：先改 `src/views/panelRegistry.ts`（id / rail / modal），再补 `Workspace` 的渲染分支与入口。');
lines.push('- 新增导航项：改 `src/views/railCatalog.tsx` 的 `RAIL_GROUPS`，`RailKey` 与 `Workspace.openFeature` 会编译检查。');
lines.push('- 改完重跑 `npm run features:gen`。');
lines.push('');

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`docs/FEATURES.md regenerated: panels=${panelRows.length} rails=${railData.keyCount} tests=${tests.length}`);
