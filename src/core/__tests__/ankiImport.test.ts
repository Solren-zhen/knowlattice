import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import JSZip from 'jszip';
import {
  apkgSummary,
  apkgToVaultFiles,
  notesToNotes,
  notesToQuestions,
  readAnkiTsv,
  readApkg,
  type ApkgContent,
  type ImportedNote,
} from '../ankiImport';

// 往返测试要用**真实的导出器**造包（"我们自己导出的东西自己读得回来"才是要证明的事），
// 所以这里 import core/anki 的 buildApkgBytes；手搓的 makeApkg 只用来测解析容错。
import { buildApkgBytes } from '../anki';

/**
 * 自造一个最小 .apkg（不依赖任何外部文件，也不 import core/anki 的构建函数）。
 * 结构照 Anki 的老库来：collection.anki2（SQLite，含 col/notes/cards 三表）
 * + zip 根下的 media 清单；字段用 Anki 固定的 \u001f 分隔。
 * col.models 里放 Basic（两字段）与 Cloze（两字段）两个模型，覆盖 readApkg 要读的三种信息：
 * 模型名、字段切分、每个 note 的卡数。
 */
const MID_BASIC = 1000;
const MID_CLOZE = 1001;

const MODELS: Record<string, unknown> = {
  [MID_BASIC]: {
    id: MID_BASIC,
    name: 'Basic',
    type: 0,
    sortf: 0,
    flds: [
      { name: 'Front', ord: 0 },
      { name: 'Back', ord: 1 },
    ],
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
  },
  [MID_CLOZE]: {
    id: MID_CLOZE,
    name: 'Cloze',
    type: 1,
    sortf: 0,
    flds: [
      { name: 'Text', ord: 0 },
      { name: 'Extra', ord: 1 },
    ],
    tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }],
  },
};

/** 造一个 note 行（字段自动用 \u001f 连接；tags 用 Anki 的「前后各一空格」写法） */
function noteRow(id: number, mid: number, fields: string[], tags = '') {
  return {
    id,
    guid: `g${id}`,
    mid,
    mod: 1700000000,
    usn: 0,
    tags: tags ? ` ${tags} ` : '',
    flds: fields.join('\u001f'),
    sfld: fields[0] ?? '',
    csum: 12345,
    flags: 0,
    data: '',
  };
}

/** 按 Anki 老库结构建一个空库（col/notes/cards 三表齐全） */
function makeDb(SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
    CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld text not null, csum integer not null, flags integer not null, data text not null);
    CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
  `);
  db.run('INSERT INTO col VALUES (1,1700000000,1700000000,1700000000,11,0,0,0,?,?,?,?,?)', [
    JSON.stringify({ curModel: MID_BASIC }),
    JSON.stringify(MODELS),
    JSON.stringify({ 1: { id: 1, name: 'Default' } }),
    JSON.stringify({ 1: { id: 1, name: 'Default' } }),
    '{}',
  ]);
  return db;
}

/** 插入 note 行（表结构固定 11 列） */
function insertNotes(db: ReturnType<typeof makeDb>, rows: Array<ReturnType<typeof noteRow>>) {
  const stmt = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of rows) {
    stmt.run([n.id, n.guid, n.mid, n.mod, n.usn, n.tags, n.flds, n.sfld, n.csum, n.flags, n.data]);
  }
  stmt.free();
}

/** 插入 cards 行（表结构固定 18 列） */
function insertCards(db: ReturnType<typeof makeDb>, rows: Array<{ id: number; nid: number }>) {
  const stmt = db.prepare('INSERT INTO cards VALUES (?,?,1,0,1700000000,0,0,0,0,0,0,0,0,0,0,0,0,?)');
  for (const c of rows) stmt.run([c.id, c.nid, '']);
  stmt.free();
}

/** 把 db 字节 + media 清单打包成 .apkg 字节 */
async function zipIt(dbBytes: Uint8Array, mediaNames: string[], dbName = 'collection.anki2'): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(dbName, dbBytes);
  const media = mediaNames.reduce<Record<string, string>>((acc, n, i) => {
    acc[String(i)] = n;
    return acc;
  }, {});
  zip.file('media', JSON.stringify(media));
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return new Uint8Array(ab);
}

/**
 * 造一个「正常」的 .apkg：Basic 两条（第二条带标签）+ Cloze 一条（两张卡）。
 * 字段分隔符是 Anki 固定的 \u001f，tags 按 Anki 的「前后各一空格」写法。
 */
async function makeApkg(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = makeDb(SQL);
  insertNotes(db, [
    noteRow(1, MID_BASIC, ['氧解离曲线是什么？', '定义：血红蛋白氧饱和度与氧分压的关系曲线。']),
    noteRow(2, MID_BASIC, ['右移的意义？', 'P50 增大，易放氧。'], '生理学 呼吸'),
    noteRow(3, MID_CLOZE, ['心输出量 = {{c1::每搏输出量}} × {{c1::心率}}', '心脏泵血']),
  ]);
  insertCards(db, [
    { id: 11, nid: 1 },
    { id: 21, nid: 2 },
    { id: 31, nid: 3 },
    { id: 32, nid: 3 }, // cloze 拆两问：这个 note 应有 2 张卡
  ]);
  const bytes = db.export();
  db.close();
  return zipIt(bytes, ['img-1.png', 'audio-2.mp3']);
}

/** 造一条 ImportedNote（映射函数的输入形状） */
function note(fields: string[], modelName = 'Basic', tags: string[] = []): ImportedNote {
  return { fields, modelName, tags, cards: 1 };
}

// ---------- readApkg ----------

describe('readApkg（自造 .apkg）', () => {
  it('读正常包：note 数、字段切分、模型名、每个 note 的卡数、媒体清单', async () => {
    const content = await readApkg(await makeApkg());
    expect(content.notes).toHaveLength(3);
    // 模型名去重：Basic 与 Cloze 都在
    expect(content.modelNames.sort()).toEqual(['Basic', 'Cloze']);
    // flds 按 \u001f 切成 fields
    expect(content.notes[0].fields).toEqual([
      '氧解离曲线是什么？',
      '定义：血红蛋白氧饱和度与氧分压的关系曲线。',
    ]);
    expect(content.notes[0].modelName).toBe('Basic');
    expect(content.notes[0].tags).toEqual([]);
    // Anki 标签是「前后各一空格」的空格分隔串，readApkg 要 trim 掉
    expect(content.notes[1].tags).toEqual(['生理学', '呼吸']);
    // cloze note 有两张卡 → cards = 2（不是写死的 1）
    expect(content.notes[2].modelName).toBe('Cloze');
    expect(content.notes[2].cards).toBe(2);
    expect(content.notes[0].cards).toBe(1);
    // media 清单只取名字，不读文件内容
    expect(content.mediaNames).toEqual(['img-1.png', 'audio-2.mp3']);
  });

  it('不是 zip 的字节 → 抛中文错误', async () => {
    await expect(readApkg(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/不是有效的 \.apkg/);
  });

  it('空字节 → 抛中文错误', async () => {
    await expect(readApkg(new Uint8Array())).rejects.toThrow(/文件是空的/);
  });

  it('zip 里没有 collection.anki2 → 抛中文错误', async () => {
    const SQL = await initSqlJs();
    const db = makeDb(SQL);
    const bytes = await zipIt(db.export(), [], 'not-a-collection.db');
    db.close();
    await expect(readApkg(bytes)).rejects.toThrow(/没有 collection\.anki2/);
  });

  it('库不是 Anki 卡库（没有 notes 表）→ 抛中文错误', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE something (a integer)');
    const bytes = await zipIt(db.export(), []);
    db.close();
    await expect(readApkg(bytes)).rejects.toThrow(/没有 notes 表/);
  });

  it('没有 cards 表的包仍能读出笔记，卡数保守记 1', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
      CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld text not null, csum integer not null, flags integer not null, data text not null);
    `);
    db.run('INSERT INTO col VALUES (1,1,1,1,11,0,0,0,?,?,?,?,?)', ['{}', JSON.stringify(MODELS), '{}', '{}', '{}']);
    insertNotes(db, [noteRow(1, MID_BASIC, ['正面', '背面'])]);
    const bytes = await zipIt(db.export(), []);
    db.close();

    const content = await readApkg(bytes);
    expect(content.notes).toHaveLength(1);
    expect(content.notes[0].cards).toBe(1);
    expect(content.notes[0].modelName).toBe('Basic');
  });
});

// ---------- readAnkiTsv ----------

describe('readAnkiTsv（Anki 导出的 .txt）', () => {
  it('两列：正面/背面', () => {
    const c = readAnkiTsv('正面1\t背面1\n正面2\t背面2');
    expect(c.notes).toHaveLength(2);
    expect(c.notes[0].fields).toEqual(['正面1', '背面1']);
    expect(c.notes[1].fields).toEqual(['正面2', '背面2']);
    expect(c.notes[0].tags).toEqual([]);
  });

  it('三列：第三列空格分隔的标签', () => {
    const c = readAnkiTsv('正面\t背面\t生理学 呼吸');
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].tags).toEqual(['生理学', '呼吸']);
  });

  it('空行与只有一列的残行被跳过，CRLF 也认', () => {
    const c = readAnkiTsv('A\tB\r\n\n\n只有正面\nC\tD\r\n');
    expect(c.notes).toHaveLength(2);
    expect(c.notes.map((n) => n.fields[0])).toEqual(['A', 'C']);
  });

  it('字段内的 <br> 原样保留（交给映射阶段统一处理换行）', () => {
    const c = readAnkiTsv('第一行<br>第二行\t答案');
    expect(c.notes[0].fields[0]).toBe('第一行<br>第二行');
    expect(c.modelNames).toEqual(['Anki 文本导入']);
  });

  it('空文本 → 没有笔记', () => {
    expect(readAnkiTsv('').notes).toEqual([]);
  });
});

describe('readAnkiTsv · 认 Anki 导出的声明行（#separator / #tags column）', () => {
  it('#separator:comma：逗号分隔也读得出来（默认第 3 列仍是标签）', () => {
    const c = readAnkiTsv('#separator:comma\n正面甲,背面甲,生理学 呼吸\n');
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].fields).toEqual(['正面甲', '背面甲', '生理学 呼吸']);
    expect(c.notes[0].tags).toEqual(['生理学', '呼吸']);
    expect(c.skippedLines).toBe(0);
  });

  it('#tags column:2：标签列按声明走（拿第 2 列，不是写死的第 3 列）', () => {
    const c = readAnkiTsv('#separator:comma\n#tags column:2\n正面甲,生理学 呼吸\n');
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].tags).toEqual(['生理学', '呼吸']);
    expect(c.notes[0].fields).toEqual(['正面甲', '生理学 呼吸']);
  });

  it('正文首行的 `#定义: …` 不能被当成声明吃掉（声明键走白名单）', () => {
    const c = readAnkiTsv('#定义: 一段正文\t背面甲\n');
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].fields).toEqual(['#定义: 一段正文', '背面甲']);
  });

  it('一行都切不出两列：不静默跳过，把行数说出来（概要据此不再说「文件选错了」）', () => {
    const c = readAnkiTsv('正面甲,背面甲\n正面乙,背面乙\n');
    expect(c.notes).toEqual([]);
    expect(c.skippedLines).toBe(2);
    expect(apkgSummary(c)).toContain('读到了 2 行');
    expect(apkgSummary(c)).toContain('分隔符');
  });
});

// ---------- notesToNotes ----------

describe('notesToNotes（note → 笔记）', () => {
  it('多字段：标题取首字段第一行，body 是首字段 + 其余字段', () => {
    const r = notesToNotes([
      note(['氧解离曲线是什么？', '定义：血红蛋白氧饱和度与氧分压的关系曲线。'], 'Basic', ['生理学']),
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toBe('氧解离曲线是什么？');
    expect(r.items[0].body).toContain('氧解离曲线是什么？');
    expect(r.items[0].body).toContain('定义：血红蛋白氧饱和度与氧分压的关系曲线。');
    expect(r.items[0].tags).toEqual(['生理学']);
  });

  it('单字段：标题取第一行，body 是其余内容', () => {
    const r = notesToNotes([note(['什么是肺牵张反射？\n肺牵张反射是指……'], '问答题')]);
    expect(r.items[0].title).toBe('什么是肺牵张反射？');
    expect(r.items[0].body).toBe('肺牵张反射是指……');
  });

  it('单字段只有一行 → 没有正文，进 skipped，reason 是中文', () => {
    const r = notesToNotes([note(['只有一行'], '问答题')]);
    expect(r.items).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('Cloze：{{c1::答案}} 与 {{c1::答案::提示}} 都还原成本项目的 {{答案}}，不残留 c1 与 ::', () => {
    const r = notesToNotes([
      note(['心输出量 = {{c1::每搏输出量}} × {{c1::心率}}', '心脏泵血'], 'Cloze'),
      note(['瞳孔对光反射的中枢在{{c1::中脑::简称}}', '神经'], 'Cloze'),
    ]);
    expect(r.items[0].body).toContain('{{每搏输出量}}');
    expect(r.items[0].body).toContain('{{心率}}');
    expect(r.items[0].body).not.toContain('c1::');
    expect(r.items[1].title).toBe('瞳孔对光反射的中枢在{{中脑}}');
    expect(r.items[1].body).not.toContain('c1::');
    expect(r.items[1].body).not.toContain('::'); // 提示不混进答案
  });

  it('<br> 变换行，[sound:] 与 <img> 被去掉，HTML 实体解码，其余标签剥掉', () => {
    const r = notesToNotes([
      note(['第一行<br>第二行', '<div>答案</div>[sound:clip.mp3]<img src="x.png">a&nbsp;b &amp; c']),
    ]);
    expect(r.items[0].title).toBe('第一行');
    expect(r.items[0].body).toContain('第一行\n第二行');
    expect(r.items[0].body).toContain('a b & c');
    expect(r.items[0].body).not.toContain('[sound:');
    expect(r.items[0].body).not.toContain('<img');
    expect(r.items[0].body).not.toContain('<div>');
  });

  it('空内容进 skipped，reason 是中文', () => {
    const r = notesToNotes([note(['', ''], 'Basic'), note(['   ', '  '], 'Basic')]);
    expect(r.items).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    for (const s of r.skipped) {
      expect(s.reason).toBe('内容为空');
      expect(s.reason).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});

// ---------- notesToQuestions ----------

describe('notesToQuestions（note → 题目）', () => {
  it('A. B. 选项行被解析成选择题，答案字母映射成下标', () => {
    const r = notesToQuestions([
      note(['低渗性缺水首选的补液是？\nA. 5% 葡萄糖\nB. 0.9% 氯化钠\nC. 3% 氯化钠\nD. 林格液', 'B']),
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].options).toEqual(['5% 葡萄糖', '0.9% 氯化钠', '3% 氯化钠', '林格液']);
    expect(r.items[0].answer).toBe(1);
    // 必须完全相等：原来的 slice(0, firstIdx) 会把题干最后一行重复一遍，toContain 抓不到
    expect(r.items[0].stem).toBe('低渗性缺水首选的补液是？');
    expect(r.items[0].answerText).toBe('B');
  });

  it('答案是 D 时映射成下标 3；带「答案：D. …」前缀也认', () => {
    const r = notesToQuestions([
      note([
        '下列哪项是休克的早期表现？\nA. 血压下降\nB. 脉搏细速\nC. 尿量减少\nD. 意识淡漠',
        '答案：D. 意识淡漠',
      ]),
    ]);
    expect(r.items[0].options).toHaveLength(4);
    expect(r.items[0].answer).toBe(3);
  });

  it('没有选项行 → recall（options 空、answer -1、answerText=答案字段）', () => {
    const r = notesToQuestions([note(['何为氧解离曲线？', '定义：血红蛋白氧饱和度与氧分压的关系曲线。'])]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].options).toEqual([]);
    expect(r.items[0].answer).toBe(-1);
    expect(r.items[0].answerText).toBe('定义：血红蛋白氧饱和度与氧分压的关系曲线。');
    expect(r.items[0].explanation).toBe('定义：血红蛋白氧饱和度与氧分压的关系曲线。');
  });

  it('有选项行但答案里找不到任何选项字母 → 仍建 recall，不猜字母', () => {
    const r = notesToQuestions([note(['问题？\nA. 甲\nB. 乙', '见教材第 12 页'])]);
    expect(r.items[0].options).toEqual([]);
    expect(r.items[0].answer).toBe(-1);
  });

  it('单字段 → skipped，reason 是中文', () => {
    const r = notesToQuestions([note(['只有正面'], 'Cloze')]);
    expect(r.items).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('第二个字段为空 → skipped', () => {
    const r = notesToQuestions([note(['题干', '  '])]);
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toContain('第二个字段为空');
  });

  it('opts.chapter 透传到题目', () => {
    const r = notesToQuestions([note(['问题？', '答案'])], { chapter: '生理学' });
    expect(r.items[0].chapter).toBe('生理学');
  });
});

// ---------- apkgSummary ----------

describe('apkgSummary', () => {
  it('包含条数与模型名', async () => {
    const content = await readApkg(await makeApkg());
    const s = apkgSummary(content);
    expect(s).toContain('3');
    expect(s).toContain('Basic');
    expect(s).toContain('Cloze');
    expect(s).toContain('2'); // 媒体文件 2 个
  });

  it('空包给出可读提示', () => {
    const empty: ApkgContent = { notes: [], modelNames: [], mediaNames: [] };
    expect(apkgSummary(empty)).toContain('没有读到任何卡片');
  });
});

// ---------- apkgToVaultFiles（note → 可直接写盘的文件） ----------

describe('apkgToVaultFiles（note → 可写盘的文件）', () => {
  it('正常包：文件数正确、路径在 imported/anki/ 下、每篇 source 有值', async () => {
    const content = await readApkg(await makeApkg());
    const r = apkgToVaultFiles(content);
    expect(r.skipped).toEqual([]);
    expect(r.files).toHaveLength(3);
    for (const f of r.files) {
      expect(f.path.startsWith('imported/anki/')).toBe(true);
      expect(f.path.endsWith('.md')).toBe(true);
      expect(f.content).toMatch(/^source: .+$/m); // source 字段非空
      expect(f.content).toContain('source: Anki 导入（Basic、Cloze）');
      expect(f.content).toContain('\n# '); // 共用模块组装的 H1 还在
    }
    // 标签透传进 frontmatter
    const tagged = r.files.find((f) => f.path.includes('右移的意义'));
    expect(tagged?.content).toContain('tags: [生理学, 呼吸]');
    // 标签里没有「章节:」这类标记 → chapter 留空（不猜）
    expect(tagged?.content).toMatch(/^chapter: *$/m);
  });

  it('标签里有「章节:生理学」时写进 chapter', () => {
    const content: ApkgContent = {
      notes: [note(['问题？', '答案'], 'Basic', ['章节:生理学', '呼吸'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].content).toMatch(/^chapter: 生理学$/m);
    expect(r.files[0].content).toContain('source: Anki 导入（Basic）');
  });

  it('Cloze 包：{{c1::…}} 先还原成本项目的 {{…}} 再落盘', async () => {
    const content = await readApkg(await makeApkg());
    const r = apkgToVaultFiles(content);
    const clozeFile = r.files.find((f) => f.path.includes('心输出量'));
    expect(clozeFile?.content).toContain('{{每搏输出量}}');
    expect(clozeFile?.content).not.toContain('c1::');
  });

  it('空内容条目进 skipped，reason 是中文，且不产出文件', () => {
    const content: ApkgContent = {
      notes: [note(['', ''], 'Basic')],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content);
    expect(r.files).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe('内容为空');
    expect(r.skipped[0].reason).toMatch(/[\u4e00-\u9fa5]/);
    expect(r.skipped[0].title).toBeTruthy(); // 每一条都要报出"少了什么"
  });

  it('标题含非法字符（ASCII ? 与斜杠）时**清洗后照常导入**，不再整条跳过', () => {
    const content: ApkgContent = {
      notes: [note(['What is P50?', '答案']), note(['A/B 对比', '答案'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content);
    // 关键回归：英文卡组的 `What is P50?` / `A/B 对比` 以前会被整条（标题+正文）跳过，
    // 用户看到"导入完成"却一篇都没落盘——静默丢正文是本项目最忌讳的失败形态
    expect(r.skipped).toEqual([]);
    expect(r.files).toHaveLength(2);
    expect(r.files.map((f) => f.path)).toEqual([
      'imported/anki/What is P50.md',
      'imported/anki/A_B 对比.md',
    ]);
    // 正文一字未动（只有文件名/H1 里的非法字符换成 `_`）
    expect(r.files[0].content).toContain('答案');
    expect(r.files[1].content).toContain('答案');
  });

  it('同批重名（两张卡正面相同）只留第一篇，第二篇报重名', () => {
    const content: ApkgContent = {
      notes: [note(['同一个问题？', '答案一']), note(['同一个问题？', '答案二'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content);
    expect(r.files).toHaveLength(1);
    expect(r.skipped).toEqual([{ title: '同一个问题？', reason: '同一批里重名' }]);
  });

  it('自定义 dir 与 sourceNote 生效', () => {
    const content: ApkgContent = {
      notes: [note(['问题？', '答案'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content, { dir: 'Anki/生理', sourceNote: '我的 Anki 备份' });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe('Anki/生理/问题？.md');
    expect(r.files[0].content).toContain('source: 我的 Anki 备份');
    expect(r.files[0].content).not.toContain('Anki 导入（');
  });

  it('以 . 开头的目录被共用模块整批拒绝（所以默认落点不带前导点）', () => {
    const content: ApkgContent = {
      notes: [note(['问题？', '答案'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content, { dir: '.imported/anki' });
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ title: '问题？', reason: '目录名不安全' }]);
  });
});

// ---------- 往返闭环：core/anki 导出的 .apkg 再导回来 ----------

/**
 * 「导出 → 再导入」的章节闭环。
 *
 * 为什么要单独钉一条：导出与导入是两个模块、各自的测试都是绿的，但两边对"章节"的约定
 * 曾经不一致——导出把章节名平铺成一个裸标签，而导入端的 chapterOf 只认显式的
 * `章节:` / `chapter:` / `科目:` 标记（刻意不猜）。于是**我们自己导出的包自己读回来，章节全丢**，
 * 而两边测试都发现不了：导出侧只断言"标签里有生理学"，导入侧只断言"标签里有 章节:生理学 时能取到"。
 * 这条测试走真实代码（buildApkgBytes → readApkg → apkgToVaultFiles），把这条契约钉死。
 */
describe('往返闭环：导出的 .apkg 再导入，章节不丢', () => {
  const NOTE_MD = `---
tags: [生理学, 呼吸]
chapter: 生理学
source: 讲义
created: 2026-01-01
exam: []
---

# 氧解离曲线

- 定义: 氧饱和度与氧分压的关系曲线
`;

  it('导出侧写出 `章节:生理学` 标签；导回来 frontmatter 的 chapter 仍是 生理学', async () => {
    const { bytes, count } = await buildApkgBytes(new Map([['生理/氧解离曲线.md', NOTE_MD]]));
    expect(count).toBe(1);

    // 1) 导出侧：章节必须是带前缀的标签（裸标签在 Anki 里就是一条普通标签，无法与章节区分）
    const SQL = await initSqlJs();
    const zip = await JSZip.loadAsync(bytes);
    const dbBytes = await zip.file('collection.anki2')!.async('uint8array');
    const db = new SQL.Database(dbBytes);
    const tags = String(db.exec('SELECT tags FROM notes')[0].values[0][0]);
    db.close();
    expect(tags).toContain('章节:生理学');

    // 2) 导入侧：同一个包读回来，章节落进 frontmatter 的 chapter（而不是被当成普通标签丢掉）
    const content = await readApkg(bytes);
    const r = apkgToVaultFiles(content);
    expect(r.skipped).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].content).toMatch(/^chapter: 生理学$/m);
    // 其它标签照旧（不因为加了章节标记而丢标签）
    expect(r.files[0].content).toContain('tags: [生理学, 呼吸, 章节:生理学]');
  });

  it('Anki 里手写的 `chapter:`/`章节:` 标签同样被认出来（不依赖本应用的导出）', () => {
    const content: ApkgContent = {
      notes: [note(['问题？', '答案'], 'Basic', ['chapter:生理学'])],
      mediaNames: [],
      modelNames: ['Basic'],
    };
    const r = apkgToVaultFiles(content);
    expect(r.files[0].content).toMatch(/^chapter: 生理学$/m);
  });
});
