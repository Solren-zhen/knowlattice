/**
 * Anki 导出：笔记/题库转成 Anki 可用的两种格式。
 * - .txt：制表符分隔导入文件（零依赖）
 * - .apkg：真 Anki 包（sql.js 构建 collection.anki2 + JSZip 打包）
 */
import { parseFrontmatter } from './parser';
import { hasCloze, toAnkiCloze } from './cloze';
import { correctIndices, explanationsOf, type QuizBank } from './qbank';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/**
 * markdown → Anki 字段用的纯文本（保留换行为 <br>，剥离语法符号）。
 * keepCloze = true 时先把手写的 `{{答案}}` 转成 Anki 挖空标记 `{{c1::答案}}`，
 * 并**保留花括号与冒号**——否则刚转好的标记会被下一行的"剥离语法符号"顺手删掉，
 * 导出的卡看起来正常、挖空却全没了（最难发现的一类"看起来成功"）。
 */
function mdToText(md: string, keepCloze = false): string {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); // 去 frontmatter
  const text = keepCloze ? toAnkiCloze(body) : body;
  return text
    .replace(/^#{1,6}\s+/gm, '')                    // 标题符
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t) // 双链→名字
    .replace(keepCloze ? /[*_`>[\]|]/g : /[*_`>{}[\]|]/g, '') // 语法符号（挖空卡保留 {} 与 :）
    .replace(/\n+/g, '<br>')                        // 换行 → <br>
    .replace(/\t/g, ' ')
    .trim();
}

/**
 * 章节标签前缀。**必须**写成 `章节:xxx` 而不是平铺一个裸标签，否则「导出 → 再导入」会丢章节：
 * Anki 的 tags 是纯文本，没有字段结构；core/ankiImport.ts 的 chapterOf 只认显式的
 * `章节:` / `chapter:` / `科目:` 标记（刻意不做模糊猜测——猜错会把统计热力图分错组，
 * 而分错组的图看起来完全正常）。平铺的 `生理学` 再导回来只是一条普通标签，
 * 没有任何依据能断定它是章节，于是章节静默归零。
 *
 * 取舍：别人的 Anki 里会多出一个带冒号的标签。它就是一个普通标签（Anki 标签允许 `:`），
 * 检索/筛选照常可用；最坏情况是被当成一个自建分类标签，比"章节无声丢失"轻得多。
 * 空格必须处理：Anki 用空格分隔标签，含空格的标签会被拆成两个（去空格会拼成新词，
 * 换 `_` 至少还看得出是同一个词组），所以这里把空白统一换成 `_`。
 */
const CHAPTER_TAG_PREFIX = '章节:';

/** 章节名 → 可用的 Anki 标签片段（空白换 `_`；章节为空时由调用方过滤掉） */
function chapterTag(chapter: string): string {
  return `${CHAPTER_TAG_PREFIX}${chapter.trim().replace(/\s+/g, '_')}`;
}

/** 标签字段：Anki 用空格分隔（其它 tags 原样保留，章节以 `章节:` 前缀标明，见上） */
function tagsLine(tags: string[], chapter: string): string {
  return [...new Set([...tags, chapter.trim() ? chapterTag(chapter) : ''].filter(Boolean))].join(' ');
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
    const frontBase =
      q.type === 'choice'
        ? `${q.stem}\n${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`
        : q.stem;
    // 共用题干（A3/A4）：病例原文必须一起导出，否则导到 Anki 的每个小问都是无头案
    const front = q.groupStem
      ? `【共用题干${q.groupTotal ? ` · 第 ${q.groupNo ?? 1}/${q.groupTotal} 问` : ''}】${q.groupStem}\n\n${frontBase}`
      : frontBase;
    // 正确答案的字母：多选（X 型）必须**全列出来**——只印 answer 那个下标会给出一个错的答案
    const letters = correctIndices(q)
      .map((i) => String.fromCharCode(65 + i))
      .join('、');
    const back =
      q.type === 'choice' ? `答案：${letters}. ${q.answerText}` : `答案：${q.answerText}`;
    // 一题多套解析全部带上（带来源名）：换一份解析不该把上一份丢掉
    const expl = explanationsOf(q)
      .map((e) => `<br>解析${e.source ? `（${e.source}）` : ''}：${e.text}`)
      .join('');
    const full = (expl ? `${back}${expl}` : back).replace(/[#*`>{}[\]|]/g, '');
    return {
      front,
      back: full,
      // 章节只走 tagsLine 的 `章节:` 通道：以前这里还把 q.chapter 当普通 tag 传一遍，
      // 同一个章节会以裸标签 + 有前缀两种形式各出现一次，纯属噪声（Anki 里多一条无意义的标签）。
      tags: tagsLine([q.note ?? ''].filter(Boolean), q.chapter ?? ''),
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
  /** Cloze 卡型 id：与 Basic 相邻但不同号，避免撞上用户既有集合里的模型 */
  const midCloze = mid + 1;

  // 两个卡型：Basic（普通笔记）+ Cloze（含 {{挖空}} 的笔记，语法见 core/cloze.ts）。
  // 两型同放一个 .apkg 是 Anki 的常态（一个包本来就支持多模型），
  // 所以不需要为挖空单独导一个文件。
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
    [midCloze]: {
      id: midCloze, name: '晶格 Cloze', type: 1, mod: now, usn: 0, sortf: 0, did: 1,
      tmpls: [{
        name: 'Cloze', ord: 0,
        qfmt: '{{cloze:文本}}',
        afmt: '{{cloze:文本}}<br><br><span style="color:#888">{{说明}}</span>',
        did: null, bqfmt: '', bafmt: '', bfield: '',
      }],
      flds: [
        { name: '文本', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
        { name: '说明', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
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
  // 无论中途抛不抛，两个 statement 与 sql.js 的 wasm 堆都要还回去（与 core/ankiImport 的
  // 读路径「finally { db.close() }」同一条纪律）。泄漏只在「批量导出、长时间不关应用」时
  // 才看得出来，所以用 finally 把它变成结构上的保证，而不是靠每条路径记得收尾。
  try {
    for (const p of list) {
      const content = docs.get(p) ?? '';
      const { meta, title } = parseFrontmatter(content);
      const tags = ` ${tagsLine(meta.tags, meta.chapter)} `;
      const nid = Date.now() * 1000 + count;
      const guid = Math.random().toString(36).slice(2, 12);
      // 含 {{挖空}} 的笔记走 Cloze 卡型：标记必须转成 {{c1::…}} 并保留，
      // 否则 Anki 里就是一段没有挖空的普通文字（导出的卡"看起来正常"，挖空却丢了）。
      // 不含挖空的笔记这条路径**完全不变**，仍是晶格 Basic 卡。
      const isCloze = hasCloze(content);
      const first = isCloze ? mdToText(content, true) : cardFront(content, p);
      // Cloze 卡的第二字段放"出处"：挖空卡正面就是条文本身，不再需要属性键提示
      const second = isCloze ? (title ? `出自：${title}` : p) : mdToText(content);
      const flds = `${first}\u001f${second}`;
      // Anki 的排序字段与校验和用"去标记后的纯文本"：保留 {{c1::}} 会让校验和随标记变动
      const sfld = isCloze ? first.replace(/\{\{c\d+::|\}\}/g, '') : first;
      noteStmt.run([nid, guid, isCloze ? midCloze : mid, now, tags, flds, sfld.toLowerCase(), csum32(sfld)]);
      cardStmt.run([nid * 10, nid, now]);
      count++;
    }
    const bytes = db.export();
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('collection.anki2', bytes);
    zip.file('media', '{}');
    const ab = await zip.generateAsync({ type: 'arraybuffer' });
    return { bytes: new Uint8Array(ab), count };
  } finally {
    noteStmt.free();
    cardStmt.free();
    db.close();
  }
}
