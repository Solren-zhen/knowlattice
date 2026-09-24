// @vitest-environment jsdom
/**
 * 「导入题库」这条路的端到端验收：真实题库文件 → 解析 → 落库 → 读回来。
 *
 * 用户报的就是这条路（他要的是刷题，不是存笔记），所以不能只测「能解析」——
 * 必须证明存进去之后还能原样读回来、同名重导是覆盖而不是重复、删除真的删掉。
 * 同时确认大题库能进入 IndexedDB，不再受 localStorage 配额限制。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { addBank, loadBanks, parseQbankJson, removeBank } from '../qbank';

// 注意：jsdom 环境下 import.meta.url 是 http://localhost:3000/…，node:fs 会拒绝
// （「URL must be of scheme file」），所以这里必须用 cwd 定位仓库文件。
const bankDir = resolve(process.cwd(), 'knowlattice-题库');
const have = existsSync(bankDir) && readdirSync(bankDir).some((f) => f.endsWith('.json'));

describe('导入题库：解析 → 落库 → 读回来', () => {
  beforeEach(async () => {
    localStorage.clear();
    await resetQbankStorageForTests();
  });

  it('一份小题库能完整走完（含覆盖与删除）', async () => {
    const text = JSON.stringify({
      name: '小题库',
      questions: [
        { stem: '1+1=?', options: ['1', '2'], answer: 1 },
        { stem: '背一句', answer: '答案' },
      ],
    });
    const { name, questions } = parseQbankJson(text, 'fallback');
    await addBank(name, questions);

    const back = await loadBanks();
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('小题库');
    expect(back[0].questions).toHaveLength(2);
    expect(back[0].questions[0].type).toBe('choice');
    expect(back[0].questions[0].answer).toBe(1);
    expect(back[0].questions[1].type).toBe('recall');

    // 同名重导 = 覆盖，不产生第二份
    await addBank(name, questions);
    expect(await loadBanks()).toHaveLength(1);

    // 删除是真的删掉
    expect(await removeBank(name)).toHaveLength(0);
    expect(await loadBanks()).toHaveLength(0);
  });

  it.skipIf(!have)('真实题库文件能落库，且读回同样多的题', async () => {
    const files = readdirSync(bankDir).filter((f) => f.endsWith('.json'));
    // 挑最大的那份当压力用例
    const pick = files.sort((a, b) => statSync(resolve(bankDir, b)).size - statSync(resolve(bankDir, a)).size)[0];
    const raw = readFileSync(resolve(bankDir, pick), 'utf8');
    const { name, questions } = parseQbankJson(raw, pick);
    await addBank(name, questions);

    const back = await loadBanks();
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe(name);
    expect(back[0].questions).toHaveLength(questions.length);

    expect(localStorage.getItem('knowlattice-qbanks')).toBeNull();
    console.log(`  [${pick}] ${questions.length} 题 · 文件 ${(statSync(resolve(bankDir, pick)).size / 1024).toFixed(0)} KB · IndexedDB 持久化成功`);
  });
});
