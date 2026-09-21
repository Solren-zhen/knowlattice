// @vitest-environment node
/**
 * 转换器的验收：用**晶格自己的导入器**读生成的文件。
 *
 * 这一步才是真验收——我自己再解析一遍只能证明「我自洽」，证明不了「晶格吃得下」。
 * 产物在仓库外（桌面/由 KNOWLATTICE_QBANK_OUT 指定），不存在就整体跳过，
 * 不让 CI 依赖用户数据。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeQuestions } from '../qbank';

const OUT = process.env.KNOWLATTICE_QBANK_OUT
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Desktop', 'KNOWLATTICE');
const NOTE_FILES = ['knowlattice-导入-绿皮书题库.json', 'knowlattice-导入-医考帮题库.json'];
const BANK_DIR = join(OUT, 'knowlattice-题库');
const have = NOTE_FILES.every((f) => existsSync(join(OUT, f))) && existsSync(BANK_DIR);

describe.skipIf(!have)('外部题库转换产物（晶格导入器验收）', () => {
  it.each(NOTE_FILES)('%s 是合法备份，且每篇笔记都有 frontmatter 与标题', (name) => {
    const raw = JSON.parse(readFileSync(join(OUT, name), 'utf8')) as {
      app: string;
      files: { path: string; content: string }[];
    };
    expect(raw.app).toBe('knowlattice');
    expect(Array.isArray(raw.files)).toBe(true);
    expect(raw.files.length).toBeGreaterThan(500);
    // 路径全是相对路径的 .md；内容非空、带 frontmatter、有 H1（导入后才进笔记树和标签页）
    expect(raw.files.filter((f) => !f.path.endsWith('.md') || f.path.startsWith('/'))).toEqual([]);
    expect(raw.files.filter((f) => !f.content.startsWith('---\n') || !/\n# /.test(f.content))).toEqual([]);
  });

  it('题库 JSON 能被 normalizeQuestions 原样吃下，且每题都有效', { timeout: 120_000 }, () => {
    const files = readdirSync(BANK_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(10);

    let total = 0;
    const shrunk: string[] = [];
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(BANK_DIR, f), 'utf8')) as { name: string; questions: unknown[] };
      const parsed = normalizeQuestions(raw);
      // 导入器会静默丢掉「无题干/无答案」的条目；产出的题不该有这种，有就是转换漏了字段
      if (parsed.length !== raw.questions.length) shrunk.push(`${f}(${raw.questions.length}→${parsed.length})`);
      total += parsed.length;
      for (const q of parsed) {
        expect(q.stem.trim().length, `${f} 题干为空`).toBeGreaterThan(0);
        expect(q.answerText.trim().length, `${f} 答案为空：${q.stem.slice(0, 60)}`).toBeGreaterThan(0);
        if (q.type === 'choice') {
          expect(q.options.length, `${f} 选项不足：${q.stem.slice(0, 60)}`).toBeGreaterThanOrEqual(2);
          expect(q.options.every((o) => o.trim())).toBe(true);
          expect(q.answer).toBeGreaterThanOrEqual(0);
          expect(q.answer).toBeLessThan(q.options.length);
        }
      }
    }
    expect(shrunk).toEqual([]);
    expect(total).toBeGreaterThan(100_000);
  });
});
