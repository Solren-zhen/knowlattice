/**
 * 抓《汤头歌诀》（清·汪昂，1694，公有领域）到 `src/core/publicMnemonics.ts`。
 *
 * 走 `action=parse` 拿**渲染后的 HTML**，不用 `prop=extracts` 的纯文本：
 * explaintext 会把整章韵文合并成一大段（没有换行），方名和韵文挤在一起，按行切分必然切错
 * ——实测那样只解析出 11 方（真书 300+ 方）。HTML 里 `<h3>` 是方名、`<br>` 是韵文断行，结构完整。
 *
 * 环境事实（都是这台机器上踩出来的）：
 * 1) node 的 fetch 直连 wikisource 会 `UND_ERR_CONNECT_TIMEOUT`，curl 同址 200 → 用 curl；
 *    Wikimedia 要求带 UA，否则按爬虫限流。出口偶尔 TLS 抖动（curl status 35），失败也重试退避。
 * 2) 逐个标题请求：批量 `titles=A|B` 返回的 pages 按页面 id 排、不按请求顺序，
 *    而 `variant=zh-hans` 还会把标题转成简体，按标题或按位置对位都会错位
 *    （实测把「祛暑」的正文安到了别的门类上）。一条一条取，标题自己拼，不存在对位问题。
 *
 * 只收**韵文**：方名下到注解散文之前的几行。原书的组成/方解是几百字注解，收进来既无必要，
 * 也更容易与现代整理本撞车；要读详解点开维基文库原文即可。
 *
 * 用法：node tools/fetch_tangtou.mjs [--dry]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const API = 'https://zh.wikisource.org/w/api.php';
const ROOT = '湯頭歌訣';
const UA = 'KNOWLATTICE-medref/1.0 (local study tool)';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function curlJson(url, tries = 4) {
  let out = '';
  for (let i = 0; i < tries; i++) {
    try {
      out = execFileSync(
        process.platform === 'win32' ? 'curl.exe' : 'curl',
        ['-s', '-m', '30', '--retry', '2', '-A', UA, url],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (err) {
      out = `curl 失败：${err.status ?? ''} ${String(err.message).slice(0, 60)}`;
    }
    if (out.trimStart().startsWith('{')) return JSON.parse(out);
    if (i < tries - 1) pause(8000 * (i + 1));
  }
  throw new Error(`API 回了非 JSON：${out.slice(0, 80)}`);
}

/** 主页的子页面清单（20 个门类 + 凡例/叙/附方） */
function chapterNames() {
  const q = new URLSearchParams({
    action: 'query', prop: 'links', titles: ROOT, plnamespace: '0',
    pllimit: '500', format: 'json', formatversion: '2',
  });
  const data = curlJson(`${API}?${q}`);
  return (data.query.pages[0].links ?? [])
    .map((l) => l.title)
    .filter((t) => t.startsWith(`${ROOT}/`))
    .map((t) => t.slice(ROOT.length + 1));
}

/** 一章的渲染 HTML（简体） */
function chapterHtml(name) {
  const q = new URLSearchParams({
    action: 'parse', page: `${ROOT}/${name}`, prop: 'text',
    variant: 'zh-hans', format: 'json', formatversion: '2', redirects: '1',
  });
  const data = curlJson(`${API}?${q}`);
  return String(data.parse?.text ?? '');
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) =>
  s
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, k) => ENTITIES[k])
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

/**
 * HTML → [{kind:'h2'|'h3'|'line', text}]。
 *
 * 先剔两类噪音，否则会被当成正文：`<small>` 是组成/方解小注（几百字），
 * `mw-editsection` 是每节末尾的「[编辑]」链接。标题分两级：h2 门类、h3 方名。
 */
function toLines(html) {
  const clean = html
    .replace(/<small>[\s\S]*?<\/small>/g, '')
    // 「[编辑]」链接：先整段删 a 标签，剩下的方括号文本在下面逐行清
    .replace(/<a [^>]*action=edit[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<span class="mw-editsection">[\s\S]*?<\/span>/g, '');
  const out = [];
  for (const chunk of clean.split(/(<h[23][^>]*>[\s\S]*?<\/h[23]>)/)) {
    const kind = /^<h2/i.test(chunk) ? 'h2' : /^<h3/i.test(chunk) ? 'h3' : 'line';
    const lines = decode(chunk.replace(/<[^>]+>/g, '\n'))
      .split('\n')
      .map((l) => l.replace(/^(编辑\]?|\[编辑\]?|\[|\])+/, '').trim())
      .filter(Boolean);
    for (const text of lines) out.push({ kind, text });
  }
  return out;
}

/** 维基文库的标题是繁体，界面是简体：只转门类名（12 个固定值，不必引转换库） */
const SIMPLIFIED_CAT = {
  和解之劑: '和解之剂',
  攻裡之劑: '攻里之剂',
  殺蟲之劑: '杀虫之剂',
  湧吐之劑: '涌吐之剂',
  理氣之劑: '理气之剂',
  理血之劑: '理血之剂',
  發表之劑: '发表之剂',
  祛風之劑: '祛风之剂',
  經產之劑: '经产之剂',
  表裡之劑: '表里之剂',
  補益之劑: '补益之剂',
  附便用雜方: '附便用杂方',
};

/** 注解散文的迹象：出现这些词就是方解开始了 */
const PROSE = /(组成|方解|〖|〔|用法|加减|集解|按[:：]|此方|本方)/;
const VERSE_MAX = 60;

function parseChapter(html, cat) {
  const out = [];
  let cur = null;
  for (const { kind, text } of toLines(html)) {
    if (kind === 'h2') continue; // 门类标题（「攻里之剂 七首、附方四。」）不是方名
    if (kind === 'h3') {
      if (cur && cur.body) out.push(cur);
      // 「大承气汤 治胃府、三焦，大热大实。」——空格后是主治小注
      const m = /^(\S+?)(?:\s+([\s\S]+))?$/.exec(text);
      cur = { term: (m?.[1] ?? text).trim(), cat, body: '', tip: (m?.[2] ?? '').trim() };
      continue;
    }
    if (!cur || !text) continue;
    if (PROSE.test(text) || text.length > VERSE_MAX) break;
    cur.body += text;
  }
  if (cur && cur.body) out.push(cur);
  // 拦截误判成标题的行：方名是纯汉字短名，不带句读、不带书名括号
  return out
    .map((e) => ({ ...e, term: e.term.replace(/[〈〉《》()（）「」[\]]/g, '').trim() }))
    .filter(
      (e) =>
        /^[\u4e00-\u9fa5]{2,16}$/.test(e.term) &&
        !/[，。、：；]/.test(e.term) &&
        e.body.length >= 8,
    );
}

const names = chapterNames();
if (names.length < 5) {
  console.error(`章节列表只取到 ${names.length} 个，wikisource 结构可能变了。`);
  process.exit(1);
}

const books = [];
for (const name of names) {
  let html = '';
  try {
    html = chapterHtml(name);
  } catch (err) {
    console.error(`  ${name}: 取页失败（${String(err.message).slice(0, 60)}）`);
  }
  const entries = html ? parseChapter(html, SIMPLIFIED_CAT[name] ?? name) : [];
  console.log(`  ${name}: ${entries.length} 方`);
  if (entries.length) books.push({ book: name, entries });
  pause(2500); // 别触发限流
}

const total = books.reduce((n, b) => n + b.entries.length, 0);
const missing = names.filter((n) => !books.some((b) => b.book === n));
if (missing.length) console.log(`未解析到方子的页面（不存在或用平铺排版）：${missing.join("、")}`);
// 下限 30：可解析的门类只有 8 个（其余页面在维基文库上不存在，或没有 h3 标题），
// 低于 30 说明解析真的坏了，不能把半成品写进仓库。
if (total < 30) {
  console.error(`只解析出 ${total} 方，明显偏少，不写文件。`);
  process.exit(1);
}

const lit = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/**
 * 只输出**一本**书：门类挂在每条的 `cat` 上。
 * 界面的分组单位是「书」，一个门类一本书会把面板撑成二十段、翻起来更累；
 * 门类本来就是分类信息，放进 cat 才对得上 MedMnemonicLib 的形状。
 */
const entries = books
  .flatMap((b) => b.entries)
  .map(
    (e) => `  { term: ${lit(e.term)}, cat: ${lit(e.cat)}, body: ${lit(e.body)}, tip: ${lit(e.tip)} },`,
  )
  .join('\n');

const src = `/**
 * 公有领域口诀：《汤头歌诀》（清·汪昂，1694）。
 *
 * 出处：维基文库（{{PD-old}}，作者殁于 1694 年）。只收**歌诀韵文**与方名后的主治小注；
 * 原书的组成、方解散文（每方几百字）没有收——那部分更容易与现代整理本撞车，
 * 要读详解点开维基文库原文即可。
 *
 * 本文件由 \`node tools/fetch_tangtou.mjs\` 生成，手工改动会在下次生成时被覆盖。
 * 自己补的方子请走界面「新增」（存本机，不进仓库）。
 */

import type { MedMnemonicLib } from './medRef';

export const PUBLIC_MNEMONIC_BOOK: MedMnemonicLib = {
  book: '汤头歌诀',
  note: '清·汪昂（1694）· 公有领域 · ${books.length} 门类 ${total} 方',
  entries: [
${entries}
  ],
};
`;
if (process.argv.includes('--dry')) {
  console.log(`[dry] ${total} 方 / ${books.length} 门类，未写文件`);
} else {
  writeFileSync('src/core/publicMnemonics.ts', src, 'utf8');
  console.log(`写入 src/core/publicMnemonics.ts：${total} 方 / ${books.length} 门类`);
}
