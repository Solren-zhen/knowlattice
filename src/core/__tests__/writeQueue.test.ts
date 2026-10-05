import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueWrite, resetWriteQueuesForTests } from '../writeQueue';

/** 复现原始事故形状：两个异步写同一文件，验证落盘顺序 == 调用顺序。 */
describe('enqueueWrite', () => {
  beforeEach(() => {
    resetWriteQueuesForTests();
  });

  it('同一路径：严格按调用顺序执行（先发先落盘）', async () => {
    const order: string[] = [];
    const gate = { open: false };
    // 第一个写刻意挂起（模拟在途 rename），第二个写随后入队
    const first = enqueueWrite('a.md', async () => {
      await new Promise<void>((r) => {
        const t = setInterval(() => {
          if (gate.open) { clearInterval(t); r(); }
        }, 5);
      });
      order.push('first');
    });
    const second = enqueueWrite('a.md', async () => {
      order.push('second');
    });
    gate.open = true;
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('同一路径：前一次写失败不阻塞后续写，且各自透传成败', async () => {
    const results: string[] = [];
    const failing = enqueueWrite('a.md', async () => {
      throw new Error('磁盘写失败');
    });
    const ok = enqueueWrite('a.md', async () => {
      results.push('ok');
    });
    await expect(failing).rejects.toThrow('磁盘写失败');
    await ok;
    expect(results).toEqual(['ok']);
    // 失败之后再入队仍正常
    await enqueueWrite('a.md', async () => { results.push('after'); });
    expect(results).toEqual(['ok', 'after']);
  });

  it('不同路径并行：互不等待', async () => {
    let aDone = false;
    const a = enqueueWrite('a.md', async () => {
      await new Promise((r) => setTimeout(r, 20));
      aDone = true;
    });
    const b = enqueueWrite('b.md', async () => {
      // b 不排队等 a：此时 a 还没完成
      expect(aDone).toBe(false);
    });
    await Promise.all([a, b]);
    expect(aDone).toBe(true);
  });
});
