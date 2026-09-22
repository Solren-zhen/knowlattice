// @vitest-environment node
/**
 * 题库 → 笔记章节索引的验收。
 *
 * 这一块的存在理由是一个**静默失效**的功能：错题本收录条件是 `if (!correct && q.note)`，
 * 而转换器产出的 111,548 道题一个 note 都没有——不报错、不提示，只是永远不收录。
 * 所以这里除了纯函数单测，还要有一条**真实全量数据**的回归：只要哪天 chapter 与
 * 笔记路径的约定被改坏，这条会立刻红，而不是等用户刷完一整套题才发现错题本空的。
 *
 * 真实数据在仓库外（桌面/由 KNOWLATTICE_QBANK_OUT 指定），不存在就整体跳过，
 * 不让 CI 依赖用户数据。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChapterIndex,
  chapterKeyOfNotePath,
  questionNoteLabel,
  resolveQuestionNote,
} from '../qbankNotes';

describe('chapterKeyOfNotePath', () => {
  it('四段结构 → 学科·章节', () => {
    expect(chapterKeyOfNotePath('题库/绿皮书/生理学/第6章 消化和吸收.md'))
      .toBe('生理学·第6章 消化和吸收');
    expect(chapterKeyOfNotePath('题库/医考帮/内科学/第1章 绪论.md')).toBe('内科学·第1章 绪论');
  });

  it('非题库笔记一律不认（普通笔记 / 附件 / 更深层级 / 非 md）', () => {
    expect(chapterKeyOfNotePath('生理学/呼吸.md')).toBeNull();
    expect(chapterKeyOfNotePath('题库/绿皮书/生理学/图.png')).toBeNull();
    expect(chapterKeyOfNotePath('题库/绿皮书/生理学/子目录/章节.md')).toBeNull();
    expect(chapterKeyOfNotePath('题库/绿皮书/生理学')).toBeNull();
    expect(chapterKeyOfNotePath('_attachments/题库/绿皮书/生理学/x.md')).toBeNull();
  });
});

describe('buildChapterIndex', () => {
  it('只收题库笔记，且同名键保留第一条', () => {
    const idx = buildChapterIndex([
      '生理学/呼吸.md',
      '题库/绿皮书/生理学/第5章 呼吸.md',
      '题库/绿皮书/生理学/第5章 呼吸.md', // 重复路径
      '题库/医考帮/生理学/第5章 呼吸.md', // 同学科章节名、不同源 → 键相同，留第一条
    ]);
    expect([...idx.keys()]).toEqual(['生理学·第5章 呼吸']);
    expect(idx.get('生理学·第5章 呼吸')).toBe('题库/绿皮书/生理学/第5章 呼吸.md');
  });
});

describe('resolveQuestionNote', () => {
  const idx = buildChapterIndex([
    '题库/绿皮书/生理学/第6章 消化和吸收.md',
    '题库/绿皮书/生理学/第5章 呼吸.md',
  ]);
  const noLink = () => null;
  /** 模拟 resolveLink：按文件名 / 标题 / alias 解析（这里只演示按名命中） */
  const byName = (name: string) =>
    name === '氧解离曲线' ? '生理学/氧解离曲线.md' : null;

  it('① note 是笔记名 → 走 resolveLink', () => {
    expect(resolveQuestionNote({ note: '氧解离曲线' }, byName, idx)).toBe('生理学/氧解离曲线.md');
  });

  it('① note 是路径且 hasPath 认账 → 直接返回（转换器未来的产出）', () => {
    const p = '题库/绿皮书/生理学/第6章 消化和吸收.md';
    expect(resolveQuestionNote({ note: p }, noLink, idx, (x) => x === p)).toBe(p);
  });

  it('① note 是路径但 hasPath 不认账 → 不凭空相信，落回 chapter', () => {
    const p = '题库/绿皮书/生理学/第6章 消化和吸收.md';
    expect(resolveQuestionNote({ note: p, chapter: '生理学·第5章 呼吸' }, noLink, idx, () => false))
      .toBe('题库/绿皮书/生理学/第5章 呼吸.md');
  });

  it('② note 解析不出来 → 落回 chapter 精确反查', () => {
    expect(resolveQuestionNote({ note: '查无此笔记', chapter: '生理学·第6章 消化和吸收' }, byName, idx))
      .toBe('题库/绿皮书/生理学/第6章 消化和吸收.md');
  });

  it('只有 chapter（真实题库就是这种）→ 命中', () => {
    expect(resolveQuestionNote({ chapter: '生理学·第5章 呼吸' }, byName, idx))
      .toBe('题库/绿皮书/生理学/第5章 呼吸.md');
  });

  it('空白 note 不该把 chapter 短路掉', () => {
    expect(resolveQuestionNote({ note: '   ', chapter: '生理学·第5章 呼吸' }, byName, idx))
      .toBe('题库/绿皮书/生理学/第5章 呼吸.md');
  });

  it('chapter 对不上 / 什么都没有 → null，不抛错', () => {
    expect(resolveQuestionNote({ chapter: '生理学·第99章 不存在' }, byName, idx)).toBeNull();
    expect(resolveQuestionNote({}, byName, idx)).toBeNull();
    expect(resolveQuestionNote({ note: '查无此笔记' }, byName, idx)).toBeNull();
  });
});

describe('questionNoteLabel', () => {
  const p = '题库/绿皮书/生理学/第6章 消化和吸收.md';

  it('手写题库的 note 本身就是给人看的名字 → 原样用', () => {
    expect(questionNoteLabel({ note: '氧解离曲线' }, '生理学/氧解离曲线.md')).toBe('氧解离曲线');
  });

  it('转换器产出的 note 是路径 → 用解析路径的末段，别把整条路径糊到按钮上', () => {
    expect(questionNoteLabel({ note: p }, p)).toBe('第6章 消化和吸收');
    expect(questionNoteLabel({}, p)).toBe('第6章 消化和吸收');
  });
});

// ---------- 真实全量数据回归 ----------

const OUT = process.env.KNOWLATTICE_QBANK_OUT
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Desktop', 'KNOWLATTICE');
const NOTE_FILES = ['knowlattice-导入-绿皮书题库.json', 'knowlattice-导入-医考帮题库.json'];
const BANK_DIR = join(OUT, 'knowlattice-题库');
const have = NOTE_FILES.every((f) => existsSync(join(OUT, f))) && existsSync(BANK_DIR);

describe.skipIf(!have)('真实题库：每道题都能找到自己的笔记', () => {
  it('111,548 道题的 chapter 全部命中题库笔记（0 未命中、0 空）', { timeout: 120_000 }, () => {
    // ① 用真实笔记备份建索引（就是运行时 buildChapterIndex(vault.docs.keys()) 的那一步）
    const paths: string[] = [];
    for (const f of NOTE_FILES) {
      const raw = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as { files: { path: string }[] };
      paths.push(...raw.files.map((x) => x.path));
    }
    const idx = buildChapterIndex(paths);
    expect(idx.size).toBeGreaterThan(2000);

    // ② 逐题解析
    const banks = readdirSync(BANK_DIR).filter((f) => f.endsWith('.json'));
    let total = 0;
    const unresolved: string[] = [];
    for (const f of banks) {
      const raw = JSON.parse(readFileSync(join(BANK_DIR, f), 'utf8')) as {
        questions: { stem: string; chapter?: string; note?: string }[];
      };
      for (const q of raw.questions) {
        total++;
        if (!resolveQuestionNote(q, () => null, idx)) {
          if (unresolved.length < 10) unresolved.push(`${f} :: ${q.chapter ?? '(空 chapter)'}`);
        }
      }
    }
    expect(total).toBeGreaterThan(100_000);
    expect(unresolved).toEqual([]);
  });
});
