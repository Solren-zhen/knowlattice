#!/usr/bin/env node
/**
 * 外部 markdown 题库 → 晶格可导入的 JSON。
 *
 * 源格式（两个源一致）：
 *   【A1】题干            ← 题号标记（A1/A2/A3/A4/B1/B2/C1/X 为选择题）
 *   A. 选项 … E. 选项
 *   答案：E               ← 单选字母 / 多选字母串（ABCE）/ 填空与简答的原文
 *   解析：…               ← 可选（医考帮有，绿皮书没有）
 *   【共用题干】案例…      ← 案例前缀，源里**每题重复一遍**，并进题干即可
 *   【共用选项】           ← 只是标记，选项在后面，丢掉即可
 *   【FILL_BLANK】/【SHORT_ANSWER】/【TERM_EXPLANATION】/【论述题】→ 无选项，自判题
 *
 * 产出两种，分别对应晶格的两个入口：
 *   ① 整库备份（笔记）  笔记树右上角 ⋯ →「从备份 .json 恢复」  —— 无损，题目原文一字不改
 *   ② 题库 JSON         题库练习 → 导入题库文件 —— 解析成 QuizQuestion
 *
 * 用法：node scripts/qbank-to-vault.mjs [--out <目录>]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const SOURCES = [
  {
    key: '绿皮书',
    root: join(HOME, 'Desktop', '绿皮书（学习指导与习题集）题库', '按章节分开'),
    noteRoot: '题库/绿皮书',
    label: '绿皮书·学习指导与习题集',
  },
  {
    key: '医考帮',
    root: join(HOME, 'Desktop', '医考帮', '临床期末'),
    noteRoot: '题库/医考帮',
    label: '医考帮·临床期末',
  },
];

// ---------- 标记分类 ----------
const norm = (s) => s.replace(/\s+/g, '').replace(/型选择题$/, '').replace(/型题$/, '');
const CHOICE_MARK = new Set(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C1', 'C', 'X', 'A3/A4']);
const RECALL_MARK = new Set(['FILL_BLANK', 'SHORT_ANSWER', 'TERM_EXPLANATION', '论述题', '简答题', '名词解释']);
const CASE_MARK = new Set(['共用题干', '假设信息']);
const DROP_MARK = new Set(['共用选项']);
// 标记可能在行首，也可能被加粗/加引用（神经病学整个学科是 `**【A1】题干：**`）
const MARK_RE = /^[\s>*-]*【\s*([^】]{1,20}?)\s*】\s*(.*)$/;
/** 去掉行内的 markdown 强调标记（源里题干整体加粗） */
const stripMd = (s) => s.replace(/\*\*/g, '').replace(/^[\s*_]+|[\s*_]+$/g, '').trim();

const TYPE_LABEL = {
  A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', B1: 'B1', B2: 'B2', C1: 'C1', C: 'C', X: 'X', 'A3/A4': 'A3/A4',
  FILL_BLANK: '填空题', SHORT_ANSWER: '简答题', TERM_EXPLANATION: '名词解释', 论述题: '论述题',
  简答题: '简答题', 名词解释: '名词解释',
};

const ANS_RE = /^(?:答案|正确答案|标准答案)\s*[:：]\s*(.*)$/;
const EXP_RE = /^(?:解析|解释|分析|考点还原)\s*[:：]\s*(.*)$/;

/**
 * 从块正文里抠选项。两个坑：
 *   ① 一行塞 2-3 个选项（`A. 胃肠道反应 B. 过敏反应 C. 神经系统反应`）——按行扫只认到第一个；
 *   ② 选项之间**连写无空格**（`…减少胰岛素用量B.妊娠期对胰岛素敏感性降低…`）——要求空格就认不出。
 * 所以先扫全部候选字母，再要求它们从 A 开始**连续递增**（A→B→C→D→E），取最长的一条链：
 * 连写也能认，正文里偶然出现的 `B.` 因为接不上链会被当正文。晶格自己的解析器也是整块扫的。
 */
function extractOptions(body) {
  // 答案/解析可能在行首，也可能紧跟最后一个选项同一行 → 不锚定行首
  const ansAt = body.search(/(?:答案|正确答案|标准答案|解析|解释|分析)\s*[:：]/);
  const cut = ansAt >= 0 ? ansAt : body.length;
  const head = body.slice(0, cut);
  const re = /([A-Ha-h])\s*[.、．)）:]\s*/g;
  const cands = [];
  let m;
  while ((m = re.exec(head))) {
    const prev = head[m.index - 1] ?? '';
    if (/[A-Za-z0-9]/.test(prev)) continue; // 别把 HbA. 之类切开
    cands.push({ idx: m[1].toUpperCase().charCodeAt(0) - 65, start: m.index, textStart: re.lastIndex });
  }
  let best = [];
  for (let s = 0; s < cands.length; s++) {
    if (cands[s].idx !== 0) continue; // 链必须从 A 开始
    const chain = [cands[s]];
    for (let i = s + 1; i < cands.length; i++) {
      if (cands[i].idx === chain.length) chain.push(cands[i]);
    }
    if (chain.length > best.length) best = chain;
  }
  const rest = body.slice(cut);
  if (best.length < 2) return { options: [], stem: stripMd(head), rest, shift: 0 };
  const options = best.map((c, i) => {
    const end = i + 1 < best.length ? best[i + 1].start : head.length;
    return stripMd(head.slice(c.textStart, end));
  });
  return { options, stem: stripMd(head.slice(0, best[0].start)), rest, shift: 0 };
}

/** 一个文件的原文 → 题目块 */
function parseFile(text, subject, chapter, sourceLabel) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  let caseText = '';
  let caseOpen = false;

  const flush = () => { if (cur) blocks.push(cur); cur = null; };

  for (const line of lines) {
    const m = MARK_RE.exec(line);
    const raw = m ? norm(m[1]) : null;
    const rest = m ? m[2] : '';

    if (raw && (CHOICE_MARK.has(raw) || RECALL_MARK.has(raw))) {
      flush();
      cur = { mark: raw, caseText, lines: rest ? [rest] : [] };
      caseOpen = false;
      continue;
    }
    if (raw && CASE_MARK.has(raw)) {
      caseText = rest.trim();
      caseOpen = !caseText; // 案例正文可能续在下一行
      continue;
    }
    if (raw && DROP_MARK.has(raw)) { caseOpen = false; continue; }

    if (caseOpen) { caseText = (caseText ? caseText + ' ' : '') + line.trim(); continue; }
    if (cur) cur.lines.push(line);
  }
  flush();

  const out = [];
  for (const b of blocks) {
    const body = b.lines.join('\n');
    const { options, stem: stemRaw, rest, shift } = extractOptions(body);
    const opts = options;
    let stem = stemRaw;

    // 答案 / 解析（都在选项之后）
    let answer = '';
    let explanation = '';
    for (const ln of rest.split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      const am = ANS_RE.exec(t);
      if (am) { answer = stripMd(am[1]); continue; }
      const em = EXP_RE.exec(t);
      if (em) { explanation = explanation ? explanation + '\n' + em[1].trim() : em[1].trim(); continue; }
      if (explanation) explanation += '\n' + t;
      else if (!answer) stem = stem ? stem + '\n' + t : t; // 选项前夹着的续行
    }

    const stemFull = stripMd(b.caseText ? `【案例】${b.caseText}\n${stem}` : stem);
    if (!stemFull.trim()) continue;

    const letters = answer.replace(/[^A-Za-z]/g, '').toUpperCase();
    const idx = /^[A-Za-z]$/.test(answer.trim()) ? letters.charCodeAt(0) - 65 - shift : -1;
    const usable = opts.length >= 2 && opts.every((o) => o && o.trim()); // 空选项不进选择题
    const single = usable && idx >= 0 && idx < opts.length;

    if (single) {
      out.push({
        type: 'choice', stem: stemFull, options: opts,
        answer: idx, answerText: opts[idx],
        explanation: explanation || undefined, chapter, source: sourceLabel, mark: b.mark,
      });
    } else if (usable) {
      // 多选（X）或答案对不上选项：晶格的 answer 是单选下标，装不下多选 →
      // 降级成自判题，把选项和正确答案一起放进题干，宁可自判也不给错判
      const picked = letters.split('').map((L) => L.charCodeAt(0) - 65 - shift).filter((i2) => i2 >= 0 && i2 < opts.length);
      const ansText = picked.length
        ? `${picked.map((i2) => String.fromCharCode(65 + i2)).join('')}：${picked.map((i2) => `${String.fromCharCode(65 + i2)}. ${opts[i2]}`).join('；')}`
        : answer;
      out.push({
        type: 'recall',
        stem: `${stemFull}\n${opts.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`,
        options: [], answer: -1, answerText: ansText,
        explanation: explanation || undefined, chapter, source: sourceLabel, mark: b.mark,
      });
    } else {
      out.push({
        type: 'recall', stem: stemFull, options: [], answer: -1,
        answerText: answer || '（原题库未给答案）',
        explanation: explanation || undefined, chapter, source: sourceLabel, mark: b.mark,
      });
    }
  }
  return out;
}

// ---------- 目录遍历 ----------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

const cleanSubject = (s) => s.replace(/题库$/, '').replace(/^\d+[_-]/, '').trim();
const cleanChapter = (s) => s.replace(/^\d+[_-]/, '').replace(/\.md$/i, '').trim();

/**
 * 题库题目 → 它对应的笔记路径。**笔记与题库题目共用这一个公式**。
 *
 * 单独抽出来是为了能被测试直接 import：晶格的 `resolveQuestionNote` 认这条路径，
 * 两边一旦漂移，「答错自动进错题本」就会再次静默失效——而这种失效不报错、不提示，
 * 只有把一整套题刷完才会发现错题本是空的。
 */
export const questionNotePath = (noteRoot, subject, chapter) => `${noteRoot}/${subject}/${chapter}.md`;

/** 文件里有多少个「题目开始」标记——用来和解析出的题数对账，差值就是漏题 */
function countMarkers(text) {
  const re = /【\s*([^】]{1,20}?)\s*】/g;
  let n = 0;
  let m;
  while ((m = re.exec(text))) {
    const k = norm(m[1]);
    if (CHOICE_MARK.has(k) || RECALL_MARK.has(k)) n++;
  }
  return n;
}

/** 正文里的第一个标题当 H1；与文件名重复的话就不再加一行 */
function noteContent(title, body, meta) {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = /^#{1,3}\s+(.*)$/.exec(lines[i] ?? '');
  const sameHead = head && (head[1].trim() === title || head[1].trim().endsWith(title));
  const rest = (sameHead ? lines.slice(i + 1) : lines).join('\n').replace(/^\n+/, '');
  const fm = [
    '---',
    `aliases: [${title}]`,
    `tags: [题库, ${meta.key}, ${meta.subject}]`,
    `chapter: ${meta.subject}`,
    `source: ${meta.label}`,
    `created: ${meta.date}`,
    '---',
    '',
  ].join('\n');
  return `${fm}# ${title}\n\n${rest.trim()}\n`;
}

// ---------- 主流程 ----------
export function main() {
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : process.cwd();
const MAX_BANK_BYTES = 900_000; // localStorage 约 5 MB，单份 0.9 MB 才能安心连导几份
const DATE = new Date().toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });
const report = { generatedAt: new Date().toISOString(), sources: [], banks: [] };

for (const src of SOURCES) {
  const files = walk(src.root).sort();
  const notes = [];
  const all = [];
  const gaps = [];
  for (const f of files) {
    const rel = relative(src.root, f);
    const parts = rel.split(/[\\/]/);
    const subject = cleanSubject(parts[0]);
    const chapter = cleanChapter(basename(f));
    const body = readFileSync(f, 'utf8');
    // 关联笔记路径：**只在这里算一次**，题库题目与笔记两边共用同一个值。
    // 原先两边各写一遍同样的字符串，而题库那侧的字段白名单里根本没有 note——
    // 于是「答错自动进错题本」在全部 111,548 道题上静默失效（不报错，只是永不收录）。
    const notePath = questionNotePath(src.noteRoot, subject, chapter);
    const qs = parseFile(body, subject, chapter, src.label).map((q) => ({ ...q, subject, note: notePath }));
    const markers = countMarkers(body);
    if (markers !== qs.length) gaps.push({ file: rel, markers, parsed: qs.length, diff: markers - qs.length });
    all.push(...qs);
    notes.push({
      path: notePath,
      content: noteContent(chapter, body, { key: src.key, subject, label: src.label, date: DATE }),
    });
  }

  // ① 笔记备份（与 knowlattice-导入-*.json 同构）
  const backup = { app: 'knowlattice', version: 5, exportedAt: new Date().toISOString(), files: notes };
  const noteFile = join(OUT, `knowlattice-导入-${src.key}题库.json`);
  writeFileSync(noteFile, JSON.stringify(backup));

  // ② 题库 JSON：按学科切，超限再按章切
  const bySubject = new Map();
  for (const q of all) {
    if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
    bySubject.get(q.subject).push(q);
  }
  const bankDir = join(OUT, 'knowlattice-题库');
  mkdirSync(bankDir, { recursive: true });
  const made = [];
  /** 先拼成真正要写盘的对象再量大小——按原始题对象估会低估一倍，上限就形同虚设 */
  const payloadFor = (subject, cq, i, n) => ({
    name: n > 1 ? `${src.key}·${subject}（${i + 1}/${n}）` : `${src.key}·${subject}`,
    questions: cq.map((q, k) => ({
      id: `q-${src.key === '绿皮书' ? 'lps' : 'ykb'}-${subject}-${i}-${k}`,
      type: q.type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      answerText: q.answerText,
      ...(q.explanation ? { explanation: q.explanation } : {}),
      chapter: `${subject}·${q.chapter}`,
      // 字段白名单：这里漏一个字段，就是一个静默失效的功能（note 就这么漏了）
      ...(q.note ? { note: q.note } : {}),
    })),
  });
  const sizeOf = (subject, cq, i, n) => Buffer.byteLength(JSON.stringify(payloadFor(subject, cq, i, n)));

  for (const [subject, qs] of bySubject) {
    // 按章节贪心装箱，每箱都按最终 JSON 体积判断，保证每份都能进 localStorage
    const chunks = [];
    let cur = [];
    const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
    const byChapter = new Map();
    for (const q of qs) {
      if (!byChapter.has(q.chapter)) byChapter.set(q.chapter, []);
      byChapter.get(q.chapter).push(q);
    }
    for (const [, cqs] of byChapter) {
      if (sizeOf(subject, [...cur, ...cqs], 0, 1) <= MAX_BANK_BYTES) { cur.push(...cqs); continue; }
      flush();
      if (sizeOf(subject, cqs, 0, 1) <= MAX_BANK_BYTES) { cur.push(...cqs); continue; }
      // 单章都超限：对半切到每一份都能装下
      const queue = [cqs];
      while (queue.length) {
        const part = queue.shift();
        if (part.length <= 1 || sizeOf(subject, part, 0, 1) <= MAX_BANK_BYTES) { chunks.push(part); continue; }
        const half = Math.ceil(part.length / 2);
        queue.unshift(part.slice(half), part.slice(0, half));
      }
    }
    flush();

    chunks.forEach((cq, i) => {
      const payload = payloadFor(subject, cq, i, chunks.length);
      const file = join(bankDir, `${payload.name.replace(/[\\/:*?"<>|]/g, '_')}.json`);
      const text = JSON.stringify(payload);
      writeFileSync(file, text);
      made.push({ file: basename(file), subject, name: payload.name, questions: cq.length, bytes: Buffer.byteLength(text) });
      report.banks.push({ source: src.key, file: basename(file), subject, questions: cq.length, bytes: Buffer.byteLength(text) });
    });
  }

  const byType = {};
  for (const q of all) {
    const k = TYPE_LABEL[q.mark] ?? q.mark;
    byType[k] = (byType[k] ?? 0) + 1;
  }
  report.sources.push({
    key: src.key, label: src.label, mdFiles: files.length, notes: notes.length,
    questions: all.length, choice: all.filter((q) => q.type === 'choice').length,
    recall: all.filter((q) => q.type === 'recall').length,
    byType, banks: made.length,
    noteFile: basename(noteFile), noteBytes: Buffer.byteLength(JSON.stringify(backup)),
    filesWithGap: gaps.length,
    totalGap: gaps.reduce((a, g) => a + g.diff, 0),
    worstGaps: gaps.sort((a, b) => b.diff - a.diff).slice(0, 8),
  });
  console.log(`[${src.key}] ${files.length} 个 md → ${notes.length} 篇笔记；解析出 ${all.length} 题（选择 ${report.sources.at(-1).choice} / 自判 ${report.sources.at(-1).recall}）；题库 ${made.length} 份`);
  if (gaps.length) {
    console.log(`  对账：${gaps.length} 个文件有差额，共 ${report.sources.at(-1).totalGap} 题`);
    for (const g of report.sources.at(-1).worstGaps) console.log(`    ${g.file}: 标记 ${g.markers} / 解析 ${g.parsed}（差 ${g.diff}）`);
  }
}

writeFileSync(join(OUT, 'knowlattice-题库-统计.json'), JSON.stringify(report, null, 2));

// 索引：告诉使用者哪个文件进哪个入口、多大、有什么坑
const idx = [];
idx.push('# 题库导入包索引\n');
idx.push(`生成时间：${report.generatedAt}\n`);
idx.push('## 一、笔记形式（推荐，无损）\n');
idx.push('入口：**笔记树右上角 ⋯ →「从备份 .json 恢复」**。题目原文一字不改，连解析、共用题干、表格都在。\n');
idx.push('| 文件 | 大小 | 内容 |');
idx.push('| --- | --- | --- |');
for (const s of report.sources) {
  idx.push(`| ${s.noteFile} | ${(s.noteBytes / 1024 / 1024).toFixed(1)} MB | ${s.notes} 篇笔记 / ${s.mdFiles} 个源文件 |`);
}
idx.push('');
idx.push('导入后笔记落在 `题库/<源>/<学科>/<章节>.md`，带 frontmatter（aliases / tags / chapter / source / created），可在标签页按 `题库`、`绿皮书`、`医考帮` 筛。\n');
idx.push('## 二、题库形式（可练习，注意配额）\n');
idx.push('入口：**题库练习 → 导入题库文件**。每题带章节标签，医考帮带解析。\n');
idx.push('⚠️ 题库存在浏览器 localStorage（约 5 MB），**一次只导几份**，导多了会提示写入失败。用完可在题库列表里删除再换。\n');
idx.push('| 文件 | 题数 | 大小 |');
idx.push('| --- | --- | --- |');
for (const b of report.banks) idx.push(`| knowlattice-题库/${b.file} | ${b.questions} | ${(b.bytes / 1024).toFixed(0)} KB |`);
idx.push('');
idx.push('## 三、已知的数据问题（源数据本身的，不是转换丢的）\n');
idx.push('- **绿皮书 B1（共用选项）题**：源文件导出时丢了 A 选项，只剩 B–E。这类题一律降级成自判题（题干里带选项 + 正确答案），不做字母重排——重排会让字母和原书对不上。');
idx.push('- **多选题（X 型）**：晶格的答案是单选下标，装不下多选。同样降级成自判题，正确答案以「ABCE：A. xx；B. yy」形式给出，宁可自判也不给错判。');
idx.push('- **填空题 / 简答题 / 名词解释 / 论述题**：无选项，本来就是自判题。');
idx.push('- 绿皮书没有解析（源里就没有），医考帮的解析原样保留在 `explanation`。');
idx.push('- 两个源的题有重叠的可能（同一道题两边都收），没有去重。\n');
writeFileSync(join(OUT, 'knowlattice-题库-INDEX.md'), idx.join('\n'));

console.log('\n产出目录：' + OUT);
for (const s of report.sources) {
  console.log(`  ${s.noteFile}  ${(s.noteBytes / 1024 / 1024).toFixed(1)} MB  （${s.notes} 篇笔记）`);
  console.log(`  题库 ${s.banks} 份（${s.questions} 题）`);
}
}

export { SOURCES, CHOICE_MARK, RECALL_MARK, extractOptions, noteContent, cleanSubject, cleanChapter, parseFile, countMarkers };
export const walkDir = walk;

// 只有被直接执行时才跑（被 import 时只拿函数，供测试/诊断用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
