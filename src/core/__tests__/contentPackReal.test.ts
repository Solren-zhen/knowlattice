/**
 * 真实内容包（`content-packs/out`）的全量冒烟。
 *
 * 为什么默认跳过：它要读 ~190MB、跑十几秒——塞进日常 `npm run test` 只会让人不想跑测试。
 * 需要时显式打开：
 *   KQ_PACK_DIR=content-packs/out npx vitest run src/core/__tests__/contentPackReal.test.ts
 *
 * 它守的是「映射层不会悄悄丢题」：题数不能低于索引声明的 95%，整单元解析不出来的不能超过 5%。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectContentPack, packUnitToQuestions } from '../contentPack';
import { bookMarkdown, groupBooks, packPageLinks, packPages, unitBriefIndex } from '../contentPackNotes';

const DIR = process.env.KQ_PACK_DIR ? join(process.cwd(), process.env.KQ_PACK_DIR) : '';
const suite = DIR ? describe : describe.skip;

suite('真实内容包全量映射', () => {
  it('每个单元都能映射出题目，题数不低于索引声明的 95%', () => {
    const idx = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')) as {
      units: { unitId: string; count?: number }[];
    };
    expect(detectContentPack(idx)).toBe('index');
    const declared = new Map(idx.units.map((u) => [u.unitId, u.count ?? 0]));

    const files = readdirSync(join(DIR, 'unit')).filter((f) => f.endsWith('.json'));
    let declaredTotal = 0;
    let mapped = 0;
    const empty: string[] = [];
    const byType: Record<string, number> = {};

    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(DIR, 'unit', f), 'utf8')) as { unitId: string };
      expect(detectContentPack(raw)).toBe('unit');
      const { questions } = packUnitToQuestions(raw);
      for (const q of questions) byType[q.type] = (byType[q.type] ?? 0) + 1;
      mapped += questions.length;
      declaredTotal += declared.get(raw.unitId) ?? 0;
      if (!questions.length) empty.push(raw.unitId);
    }

    console.log(JSON.stringify({ files: files.length, declaredTotal, mapped, byType, emptyUnits: empty }, null, 1));
    expect(files.length).toBe(idx.units.length);
    expect(mapped).toBeGreaterThan(declaredTotal * 0.95);
    expect(empty.length / files.length).toBeLessThan(0.05);
  }, 300_000);
});

suite('真实内容包：讲义页 → 笔记', () => {
  it('分册、页码有序、页题映射能命中', () => {
    const pages = packPages(JSON.parse(readFileSync(join(DIR, 'topic/jiangyi-pages.json'), 'utf8')));
    const links = packPageLinks(JSON.parse(readFileSync(join(DIR, 'link/page2item.json'), 'utf8')));
    expect(pages.length).toBeGreaterThan(2000);
    // 本包实测 0 条：讲义页与题目在源数据里没有关联（只有页注释带题干片段），
    // 这里不断言 >0，只要求形状可用、不抛。
    expect(typeof links).toBe('object');

    const books = groupBooks(pages);
    expect(books.length).toBeGreaterThanOrEqual(6);
    // 页码必须单调不减：'9' 排在 '10' 后面就是整本讲义读乱
    for (const b of books) {
      const nums = b.pages.map((p) => Number.parseInt(p.page, 10));
      for (let i = 1; i < nums.length; i += 1) expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
    }

    const hit = pages.filter((p) => links[`${p.paper}:${p.page}`]).length;
    console.log(JSON.stringify({ pages: pages.length, books: books.length, links: Object.keys(links).length, pagesWithItems: hit }, null, 1));
    // 有关联时必须真的指到页上（不能出现「键在、页不在」的孤儿链接）
    for (const k of Object.keys(links)) {
      expect(pages.some((p) => `${p.paper}:${p.page}` === k)).toBe(true);
    }

    const md = bookMarkdown(books[0], { links, mediaPath: (ref) => `_attachments/${ref}.png` });
    expect(md).toContain('## 第 ');
    expect(md).toContain('![](_attachments/');
    // 讲义页自带的「本页要点」是唯一可用的页级正文线索，不能丢
    expect(md).toMatch(/本页要点：/);
  }, 120_000);

  it('单元文件能提供题干摘要，供讲义页列相关题', () => {
    const dir = join(DIR, 'unit');
    const first = readdirSync(dir).filter((f) => f.endsWith('.json'))[0];
    const idx = unitBriefIndex(JSON.parse(readFileSync(join(dir, first), 'utf8')));
    expect(idx.size).toBeGreaterThan(0);
    for (const brief of idx.values()) expect(brief.stem.length).toBeLessThanOrEqual(60);
  }, 60_000);
});
