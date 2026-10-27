/**
 * addBankBatch 的 IndexedDB 行为测试（fake-indexeddb）。
 *
 * 为什么单独测这个：内容包一次导 327 个单元，逐个 addBank 会退化成 O(n²)
 * （每次 getAllBanks 把全部题目读一遍再反序列化），表现成「导入卡死」。
 * 批量通道只允许「一次读、一次写」，但语义必须与 addBank 完全一致——
 * 同名合并、旧选项批注按题干+选项接回。这两条错一条，用户的选项批注就被静默冲掉。
 */
import { describe, expect, it } from 'vitest';
import { addBank, addBankBatch, loadBanks, type QuizQuestion } from '../qbank';

function q(stem: string, options = ['甲', '乙'], answer = 0): QuizQuestion {
  return { id: '', type: 'choice', stem, options, answer, answerText: '' };
}


describe('addBankBatch', () => {
  // 库是模块级单例（storage/qbank 缓存了 openDB 的 promise），删不掉也用不着删：
  // 每个用例用不同的题库名，互不干扰。
  it('一次写入多个题库，全部可按名字读回', async () => {
    await addBankBatch([
      { name: 'b1-A', questions: [q('a1')] },
      { name: 'b1-B', questions: [q('b1'), q('b2')] },
    ]);
    const banks = await loadBanks();
    // 不校验顺序：同一毫秒写入的两条库里，importedAt 相同、次序不稳定
    expect(banks.map((b) => b.name)).toEqual(expect.arrayContaining(['b1-A', 'b1-B']));
    expect(banks.find((b) => b.name === 'b1-B')?.questions).toHaveLength(2);
  });

  it('同名题库走合并语义，不覆盖已有内容', async () => {
    await addBank('b2-A', [q('a1'), q('a2')]);
    await addBankBatch([{ name: 'b2-A', questions: [q('a1'), q('a3')] }]);
    const a = (await loadBanks()).find((b) => b.name === 'b2-A');
    expect(a?.questions).toHaveLength(2);
  });

  it('旧题的用户批注按题干+选项接回新题', async () => {
    await addBank('b3-A', [{ ...q('同一个题干'), optionNotes: ['我的批注', ''] }]);
    // 再导一次「没有批注」的同一题：批注必须被接回，不能丢
    await addBankBatch([{ name: 'b3-A', questions: [q('同一个题干')] }]);
    const a = (await loadBanks()).find((b) => b.name === 'b3-A');
    expect(a?.questions[0].optionNotes).toEqual(['我的批注', '']);
  });

  it('空批量不写盘也不报错', async () => {
    const before = (await loadBanks()).length;
    const banks = await addBankBatch([]);
    expect(banks).toHaveLength(before);
  });
});
