/**
 * Anki 导出：笔记/题库转成 Anki 可用的两种格式。
 * - .txt：制表符分隔导入文件（零依赖）
 * - .apkg：真 Anki 包（sql.js 构建 collection.anki2 + JSZip 打包）
 */
import { parseFrontmatter } from './parser';
import type { QuizBank } from './qbank';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/** markdown → Anki 卡片背面用的纯文本（保留换行为 <br>，剥离语法符号） */
function mdToText(md: string): string {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') // 去 frontmatter
    .replace(/^#{1,6}\s+/gm, '')                    // 标题符
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t) // 双链→名字
    .replace(/[*_`>{}[\]|]/g, '')                  // 常用语法符号
    .replace(/\n+/g, '<br>')                        // 换行 → <br>
    .replace(/\t/g, ' ')
    .trim();
}

/** 标签字段：Anki 用空格分隔 */
function tagsLine(tags: string[], chapter: string): string {
  return [...new Set([...tags, chapter].filter(Boolean))].join(' ');
}

/** 每张卡的 {front, back, tags} → TSV 行（字段内不能含 \n 与 \t） */
function toTsv(rows: Array<{ front: string; back: string; tags: string }>): string {
  return rows
    .map((r) => `${r.front.replace(/[\t\n]/g, ' ')}\t${r.back.replace(/\t/g, ' ')}\t${r.tags.replace(/[\t\n]/g, ' ')}`)
    .join('\n');
}

/** 全库笔记 → 复习卡（正面=标题+属性键，背面=正文） */
export function notesToAnki(docs: Map<string, string>, paths?: string[]): string {
  const list = paths ?? [...docs.keys()].filter((p) => p.endsWith('.md'));
  const rows: Array<{ front: string; back: string; tags: string }> = [];
  for (const p of list) {
    const content = docs.get(p) ?? '';
    const { title, body, meta } = parseFrontmatter(content);
    const name = title || p.replace(/\.md$/, '').split('/').pop()!;
    // 正面：标题 + 属性键（值打码，辅助回忆）
    const keys: string[] = [];
    for (const line of body.split('\n')) {
      const m = /^(\s*-\s*)([^:\n【[]{1,12})(\s*):/.exec(line);
      if (m && !/\s/.test(m[2])) keys.push(m[2].trim());
    }
    const front = [name, ...(keys.length ? [`(${keys.join(' / ')})`] : [])].join(' ').trim();
    rows.push({ front, back: mdToText(content), tags: tagsLine(meta.tags, meta.chapter) });
  }
  return toTsv(rows);
}

/** 题库 → 题目卡（正面=题干+选项，背面=答案+解析） */
export function bankToAnki(bank: QuizBank): string {
  const rows = bank.questions.map((q) => {
    const front =
      q.type === 'choice'
        ? `${q.stem}\n${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`
        : q.stem;
    const back =
      q.type === 'choice'
        ? `答案：${String.fromCharCode(65 + q.answer)}. ${q.answerText}`
        : `答案：${q.answerText}`;
    const full = (q.explanation ? `${back}<br>解析：${q.explanation}` : back).replace(/[#*`>{}[\]|]/g, '');
    return {
      front,
      back: full,
      tags: tagsLine([q.chapter ?? '', q.note ?? ''].filter(Boolean), q.chapter ?? ''),
    };
  });
  return toTsv(rows);
}

/** 触发浏览器下载 */
export function downloadFile(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 真 .apkg 导出（sql.js + JSZip） ----------

/** 卡片正面：标题 + 属性键（与 notesToAnki 一致） */
function cardFront(content: string, path: string): string {
  const { title, body } = parseFrontmatter(content);
  const name = title || path.replace(/\.md$/, '').split('/').pop()!;
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^(\s*-\s*)([^:\n【[]{1,12})(\s*):/.exec(line);
    if (m && !/\s/.test(m[2])) keys.push(m[2].trim());
  }
  return [name, ...(keys.length ? [`(${keys.join(' / ')})`] : [])].join(' ').trim();
}

/** 32 位内容校验（Anki csum） */
function csum32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** 全库笔记 → 真 Anki 包(.apkg)。返回导出的卡数。 */
export async function exportApkg(docs: Map<string, string>, paths?: string[]): Promise<number> {
  const { bytes, count } = await buildApkgBytes(docs, paths);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `knowlattice-notes-${new Date().toISOString().slice(0, 10)}.apkg`;
  a.click();
  URL.revokeObjectURL(url);
  return count;
}

/** 构建 .apkg 文件字节（collection.anki2 + media），不触发下载；导出与测试共用 */
export async function buildApkgBytes(
  docs: Map<string, string>,
  paths?: string[]
): Promise<{ bytes: Uint8Array<ArrayBuffer>; count: number }> {
  const list = paths ?? [...docs.keys()].filter((p) => p.endsWith('.md'));
  const now = Math.floor(Date.now() / 1000);
  const mid = 1725000000000;

  const models = {
    [mid]: {
      id: mid, name: '晶格 Basic', type: 0, mod: now, usn: 0, sortf: 0, did: 1,
      tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{正面}}', afmt: '{{正面}}<hr id=answer>{{背面}}', did: null, bqfmt: '', bafmt: '', bfield: '' }],
      flds: [
        { name: '正面', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
        { name: '背面', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      ],
      css: '', latexPre: '\\documentclass[12pt]{article}\\special{papersize=89mm,127mm}\\usepackage[utf8]{inputenc}', latexPost: '\\end{document}', latexsvg: false,
      req: [[0, 'any', [0]]], tags: [],
    },
  } as Record<number, unknown>;
  const decks = {
    1: { id: 1, name: '晶格', mod: now, usn: 0, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 10, extendRev: 50 },
  } as Record<number, unknown>;
  const dconf = {
    1: { id: 1, name: 'Default', mod: now, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, separate: true, order: 1, perDay: 20, bury: true }, rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: true }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }, dyn: false, newPerDay: 20, revPerDay: 200, newBury: true, newSpacing: false, easyBury: true, ivlFct: 1, maxIvl: 36500, separate: true, hardFactor: 1.2 },
  } as Record<number, unknown>;

  // 浏览器：locateFile 指向打包的 wasm asset；Node（单测/CLI）：不传 locateFile，
  // sql.js 自动按其模块目录加载 sql-wasm.wasm。
  const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
  const SQL = await initSqlJs(isNode ? {} : { locateFile: () => wasmUrl });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
    CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld text not null, csum integer not null, flags integer not null, data text not null);
    CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
    CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
    CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
  `);
  db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [
    now, now, now,
    JSON.stringify({ activeDecks: [1], curDeck: 1, curModel: mid, nextPos: 1 }),
    JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}',
  ]);

  const noteStmt = db.prepare("INSERT INTO notes VALUES (?,?,?,?,0,?,?,?,?,0,'')");
  const cardStmt = db.prepare("INSERT INTO cards VALUES (?,?,1,0,?,0,0,0,0,0,0,0,0,0,0,0,0,'')");

  let count = 0;
  for (const p of list) {
    const content = docs.get(p) ?? '';
    const { meta } = parseFrontmatter(content);
    const front = cardFront(content, p);
    const back = mdToText(content);
    const nid = Date.now() * 1000 + count;
    const guid = Math.random().toString(36).slice(2, 12);
    const flds = `${front}\u001f${back}`;
    const tags = ` ${tagsLine(meta.tags, meta.chapter)} `;
    noteStmt.run([nid, guid, mid, now, tags, flds, front.toLowerCase(), csum32(front)]);
    cardStmt.run([nid * 10, nid, now]);
    count++;
  }
  noteStmt.free();
  cardStmt.free();
  const bytes = db.export();

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('collection.anki2', bytes);
  zip.file('media', '{}');
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return { bytes: new Uint8Array(ab), count };
}
