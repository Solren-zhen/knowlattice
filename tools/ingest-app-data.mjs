#!/usr/bin/env node
/**
 * 把外部素材洗成本项目自己的数据格式（医学速查：术语 / 症状 / 口诀）。
 *
 * 为什么必须有这一步：原始文件里带着**别人的标识**——云端文档 id、原始分类名、
 * 作者自述。这些东西进仓库等于把来源写在脸上。
 *
 * 所以这里只做一件事：重排字段（换成 kq.medref.v1 的键），只保留内容本身。
 * 术语表不生成（产品上不需要那一栏）；公有领域口诀编在 src/core/publicMnemonics.ts 里。
 * 产物写到 public/app-data/medref/，该目录**不进 git**（见 .gitignore）；
 * 仓库里只留本脚本，谁要用谁自己生成。
 *
 * 图集类的扫描件不在这里处理，也不进仓库。
 *
 * 用法：
 *   node tools/ingest-app-data.mjs              # 默认素材目录
 *   node tools/ingest-app-data.mjs --src <dir>  # 换素材目录
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SRC = (args.includes('--src') ? args[args.indexOf('--src') + 1] : null)
  ?? join(homedir(), 'Desktop', '晶格个人资料', '02-解包副本', 'yjt/flutter_assets/assets/app_data');

const OUT = join(ROOT, 'public/app-data');

const read = (name) => JSON.parse(readFileSync(join(SRC, name), 'utf8'));

function write(rel, data) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
  const kb = Math.round(readFileSync(p).length / 1024);
  console.log(`  → ${rel}  (${kb} KB)`);
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`素材目录不存在：${SRC}`);
    console.error('先解包/归档外部 App，或用 --src 指定。');
    process.exit(1);
  }
  console.log(`素材：${SRC}`);
  console.log(`输出：${OUT}`);

  const symRaw = read('symptom_knowledge_data.json');
  const mneRaw = read('tcm_mnemonics.json');

  write('medref/symptoms.json', {
    format: 'kq.medref.v1',
    symptoms: symRaw.items.map((s) => ({ name: s.symptom, cat: s.category, diseases: s.diseases ?? [] })),
  });
  write('medref/mnemonics.json', {
    format: 'kq.medref.v1',
    books: mneRaw.libraries.map((lib) => ({
      book: lib.specialty,
      note: '', // 作者自述（source_note）属于来源标识，不进产物
      entries: lib.entries.map((e) => ({ term: e.keyword, cat: e.category, body: e.detail, tip: e.mnemonic ?? '' })),
    })),
  });
}

main();
