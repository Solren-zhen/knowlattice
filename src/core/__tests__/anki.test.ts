import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { bankToAnki, buildApkgBytes, notesToAnki } from '../anki';

const NOTE = `---
aliases: [氧离曲线]
tags: [生理学, 呼吸]
chapter: 生理学
source: 讲义
created: 2026-01-01
exam: []
---

# 氧解离曲线

- 定义: 氧解离曲线是指……
- 口诀: 右移放氧

[[肺牵张反射]] 相关
`;

function bank() {
  return {
    name: '生理题库',
    importedAt: 1,
    questions: [
      { id: 'q-1', type: 'choice' as const, stem: '右移的意义？', options: ['易放氧', '易结合氧'], answer: 0, answerText: '易放氧', explanation: 'P50 增大', chapter: '生理学' },
      { id: 'q-2', type: 'recall' as const, stem: '何为氧解？', options: [], answer: -1, answerText: '答', chapter: '生理学' },
    ],
  };
}

describe('notesToAnki（.txt 导出）', () => {
  it('正面=标题+属性键，背面纯文本，标签=tags+带前缀的章节标记', () => {
    const tsv = notesToAnki(new Map([['生理/肺.md', NOTE]]));
    const lines = tsv.split('\n');
    expect(lines).toHaveLength(1);
    const [front, back, tags] = lines[0].split('\t');
    expect(front).toContain('氧解离曲线');
    expect(front).toContain('定义');
    expect(front).toContain('口诀');
    // 背面：去 frontmatter/标题符/双链/语法符号，换行转 <br>
    expect(back).toContain('- 定义:');
    expect(back).toContain('肺牵张反射');
    expect(back).not.toContain('# 氧解离曲线');
    expect(back).not.toContain('---');
    // 标签去重：tags 原样 + 章节以 `章节:` 前缀标明（章节名平铺成裸标签时，
    // 再导回来没人能断定它是章节——见 core/anki 里 CHAPTER_TAG_PREFIX 的注释）
    expect(tags).toBe('生理学 呼吸 章节:生理学');
  });

  it('字段内的制表符与换行被清理（TSV 合法性）', () => {
    const tsv = notesToAnki(new Map([['x.md', '# A\n\n- 定义: a\tb\n再换行']]));
    expect(tsv.split('\t').length).toBe(3);
  });
});

describe('bankToAnki', () => {
  it('选择题正面带选项，背面答案+解析', () => {
    const tsv = bankToAnki(bank());
    // 取第一条记录：字段以 \t 为界（正反面内部含换行，不能按 \n 切）
    const fields = tsv.split('\t');
    const front = fields[0];
    const back = fields[1];
    const tags = fields[2];
    expect(front).toContain('A. 易放氧');
    expect(back).toContain('答案：A. 易放氧');
    expect(back).toContain('解析：P50 增大');
    // 章节以 `章节:` 前缀出现（题库导出的裸章节标签已去掉，避免同一章节出现两次）
    // 章节以 `章节:` 前缀出现（题库导出的裸章节标签已去掉，避免同一章节出现两次）；
    // fields[2] 会连上下一条记录的正面（TSV 按 \t 切时行界会被跨过），只取第一行
    expect(tags.split('\n')[0]).toBe('章节:生理学');
  });
});

describe('buildApkgBytes（真 .apkg 结构）', () => {
  it('生成含合法 collection.anki2 的 zip，笔记/卡片数量正确', async () => {
    const { bytes, count } = await buildApkgBytes(new Map([
      ['生理/肺.md', NOTE],
      ['生化/三羧酸循环.md', `---\ntags: [生化]\nchapter: 生化\n---\n\n# 三羧酸循环\n\n- 定义: 柠檬酸循环`],
    ]));
    expect(count).toBe(2);

    // zip 内容
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(['collection.anki2', 'media']);
    const dbBytes = await zip.file('collection.anki2')!.async('uint8array');
    expect(dbBytes.byteLength).toBeGreaterThan(0);

    // sqlite 可打开；col/notes/cards 结构完整
    const SQL = await initSqlJs();
    const db = new SQL.Database(dbBytes);
    const notesN = db.exec('SELECT count(*) FROM notes')[0].values[0][0];
    const cardsN = db.exec('SELECT count(*) FROM cards')[0].values[0][0];
    const colVer = db.exec('SELECT ver FROM col')[0].values[0][0];
    const tags = db.exec('SELECT tags FROM notes')[0].values.map((r) => String(r[0]));
    expect(notesN).toBe(2);
    expect(cardsN).toBe(2);
    expect(colVer).toBe(11);
    expect(tags.some((t) => t.includes('生理学'))).toBe(true);
    // guid 唯一
    const guids = db.exec('SELECT DISTINCT guid FROM notes')[0].values;
    expect(guids).toHaveLength(2);
    db.close();
  });
});

describe('buildApkgBytes · 含 {{挖空}} 的笔记走 Cloze 卡型', () => {
  const CLOZE = `---
tags: [生理学]
chapter: 生理学
---

# 心输出量

- 定义: 心输出量 = {{每搏输出量}} × {{心率}}
`;

  it('转成 {{c1::…}} 且没有被"剥离语法符号"删掉；两处挖空同属一张卡', async () => {
    const { bytes, count } = await buildApkgBytes(new Map([['生理/心输出量.md', CLOZE]]));
    expect(count).toBe(1);
    const zip = await JSZip.loadAsync(bytes);
    const dbBytes = await zip.file('collection.anki2')!.async('uint8array');
    const SQL = await initSqlJs();
    const db = new SQL.Database(dbBytes);

    // 一个包里同时有 Basic 与 Cloze 两个模型（Anki 的常态）
    const models = JSON.parse(
      String(db.exec('SELECT models FROM col')[0].values[0][0])
    ) as Record<string, { name: string; type: number; flds: Array<{ name: string }> }>;
    expect(Object.values(models).map((m) => m.name).sort()).toEqual(['晶格 Basic', '晶格 Cloze']);

    const rows = db.exec('SELECT mid, flds, sfld FROM notes')[0].values;
    expect(rows).toHaveLength(1);
    const [mid, flds, sfld] = rows[0] as [number, string, string];
    expect(models[String(mid)].type).toBe(1);
    expect(flds).toContain('{{c1::每搏输出量}}');
    expect(flds).toContain('{{c1::心率}}');
    // 同一段里的多处挖空编成同一个 c1：复习界面就是"一张卡遮多处、一起揭开"
    expect(flds).not.toContain('c2::');
    // 去标记后的纯文本做排序字段与校验和
    expect(sfld).toContain('每搏输出量');
    expect(sfld).not.toContain('{{');
    db.close();
  });

  it('不含挖空的笔记仍然走 Basic 卡型（既有导出行为不变）', async () => {
    const { bytes } = await buildApkgBytes(new Map([['生理/肺.md', NOTE]]));
    const zip = await JSZip.loadAsync(bytes);
    const dbBytes = await zip.file('collection.anki2')!.async('uint8array');
    const SQL = await initSqlJs();
    const db = new SQL.Database(dbBytes);
    const models = JSON.parse(
      String(db.exec('SELECT models FROM col')[0].values[0][0])
    ) as Record<string, { name: string; type: number }>;
    const mid = db.exec('SELECT mid FROM notes')[0].values[0][0] as number;
    expect(models[String(mid)].type).toBe(0);
    expect(models[String(mid)].name).toBe('晶格 Basic');
    db.close();
  });
});
