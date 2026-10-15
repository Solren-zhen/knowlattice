/**
 * 统一导入的格式判定（core/importFormat）单测。
 *
 * 这是「一个入口吃掉所有文件」的分派大脑：判定错一次，用户就会把题库当备份导、
 * 或把数据集当题库导，而且往往要到「导入后一片空白」才被发现。所以逐格式钉死：
 *  ① 扩展名明确的按扩展名（md / apkg / docx / pdf / xlsx / csv …）；
 *  ② .json 必须先看**显式标记**（备份 app 字段 / 知识包 format 字段）再看形状探测；
 *  ③ 认不出的**绝不猜**：返回 unknown，由调用方如实报错、不改动原文件。
 */
import { describe, expect, it } from 'vitest';
import { detectImportFormat, detectJsonFormat, extOf } from '../importFormat';

const json = (v: unknown) => JSON.stringify(v);

describe('extOf', () => {
  it('取小写扩展名；无扩展名 / 带空格都稳', () => {
    expect(extOf('甲.MD')).toBe('md');
    expect(extOf(' 乙.JSON ')).toBe('json');
    expect(extOf('没有扩展名')).toBe('');
    expect(extOf('')).toBe('');
  });
});

describe('detectImportFormat · 按扩展名', () => {
  it('Markdown 笔记', () => {
    expect(detectImportFormat('甲.md')).toBe('note-md');
    expect(detectImportFormat('乙.markdown')).toBe('note-md');
  });
  it('Anki：.apkg 是牌组包，.txt/.tsv 是「导出为 .txt」', () => {
    expect(detectImportFormat('牌组.apkg')).toBe('anki-apkg');
    expect(detectImportFormat('导出.txt')).toBe('anki-tsv');
    expect(detectImportFormat('导出.tsv')).toBe('anki-tsv');
  });
  it('Word / PDF 走文档转换', () => {
    for (const n of ['甲.docx', '乙.doc', '丙.pdf']) expect(detectImportFormat(n)).toBe('document');
  });
  it('Excel / CSV 走表格题库', () => {
    for (const n of ['甲.xlsx', '乙.xls', '丙.csv']) expect(detectImportFormat(n)).toBe('qbank-sheet');
  });
  it('.json 不给内容就判不出（要读文本）', () => {
    expect(detectImportFormat('甲.json')).toBe('unknown');
  });
  it('完全不认识的扩展名 → unknown', () => {
    expect(detectImportFormat('病毒.exe')).toBe('unknown');
    expect(detectImportFormat('图片.png')).toBe('unknown');
  });
});

describe('detectJsonFormat · 显式标记优先', () => {
  it('备份：app 标记 + files 数组', () => {
    expect(detectJsonFormat(json({ app: 'knowlattice', files: [{ path: '甲.md', content: 'x' }] }))).toBe('vault-backup');
    // 旧版备份以 medvault 命名，结构一致
    expect(detectJsonFormat(json({ app: 'medvault', files: [] }))).toBe('vault-backup');
  });
  it('知识包：format 标记', () => {
    expect(detectJsonFormat(json({ format: 'knowlattice-pack', notes: [] }))).toBe('knowledge-pack');
  });
  it('坏的 JSON → unknown（不抛）', () => {
    expect(detectJsonFormat('{不是 JSON')).toBe('unknown');
  });
});

describe('detectJsonFormat · 形状探测（无明显标记时）', () => {
  it('结构化数据集：症状→疾病', () => {
    expect(detectJsonFormat(json({ entries: [{ symptom: '症状甲', diseases: ['疾病甲'] }] }))).toBe('dataset-json');
  });
  it('题库：短键形状', () => {
    expect(detectJsonFormat(json([{ s: '题干甲？', o: ['A', 'B'], a: 0 }]))).toBe('qbank-json');
  });
  it('都认不出 → unknown（绝不猜着导）', () => {
    expect(detectJsonFormat(json({ 随便: [1, 2, 3] }))).toBe('unknown');
    expect(detectJsonFormat(json(42))).toBe('unknown');
  });
});

describe('detectImportFormat · .json 端到端', () => {
  it('备份 JSON 文本 → vault-backup', () => {
    expect(detectImportFormat('甲.json', json({ app: 'knowlattice', files: [] }))).toBe('vault-backup');
  });
  it('知识包 JSON 文本 → knowledge-pack', () => {
    expect(detectImportFormat('甲.json', json({ format: 'knowlattice-pack', notes: [] }))).toBe('knowledge-pack');
  });
  it('题库 JSON 文本 → qbank-json', () => {
    expect(detectImportFormat('甲.json', json([{ s: '题干甲？', o: ['甲', '乙'], a: 0 }]))).toBe('qbank-json');
  });
});
