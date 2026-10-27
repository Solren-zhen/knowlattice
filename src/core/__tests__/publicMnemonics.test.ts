/**
 * 公有领域口诀的完整性守卫。
 *
 * 这份数据会被 `node tools/fetch_tangtou.mjs` 整文件重写，所以断言的重点不是「内容对不对」，
 * 而是「重写之后还是不是可用形状」：有几个方、每条有没有方名与韵文、有没有重复方名。
 * 抓取脚本一旦解析跑偏（比如只解析出 3 个方），这里会立刻红，而不是等界面空白才发现。
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_MNEMONIC_BOOK } from '../publicMnemonics';

describe('汤头歌诀', () => {
  it('是一本书，带出处说明', () => {
    expect(PUBLIC_MNEMONIC_BOOK.book).toBe('汤头歌诀');
    expect(PUBLIC_MNEMONIC_BOOK.note).toMatch(/公有领域/);
  });

  it('方子数量在合理区间（重新抓取后不能塌成个位数）', () => {
    expect(PUBLIC_MNEMONIC_BOOK.entries.length).toBeGreaterThanOrEqual(20);
  });

  it('每方都有方名、门类和韵文', () => {
    for (const e of PUBLIC_MNEMONIC_BOOK.entries) {
      expect(e.term.trim().length).toBeGreaterThan(0);
      expect(e.cat.trim().length).toBeGreaterThan(0);
      expect(e.body.trim().length).toBeGreaterThanOrEqual(8);
    }
  });

  it('方名不重复（重复会让「编辑」改错条目）', () => {
    const terms = PUBLIC_MNEMONIC_BOOK.entries.map((e) => e.term);
    expect(new Set(terms).size).toBe(terms.length);
  });
});
