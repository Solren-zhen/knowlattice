/**
 * 演示数据落盘回归：seedDemo 必须与存储适配器用同一个库版本。
 * 之前 demo.ts 自己 openDB(…, 1)，而适配器已经是版本 2——库先被适配器建/升过之后，
 * 点「载入演示数据」只会拿到 VersionError，一篇笔记都写不进去，界面上还看不出原因。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { WebAdapter } from '../../storage/web';
import { seedDemo } from '../demo';

describe('演示数据', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    });
  });

  it('库已由适配器建到当前版本后，载入演示数据仍能写进笔记', async () => {
    const adapter = new WebAdapter();
    await adapter.write('00-我的笔记.md', '# 我的\n'); // 触发建库：版本号以适配器为准

    const n = await seedDemo();

    expect(n).toBeGreaterThan(0);
    const paths = (await adapter.listAll()).map((f) => f.path);
    expect(paths).toContain('01-生理学/呼吸/肺牵张反射.md');
    expect(paths).toContain('00-我的笔记.md'); // 原有笔记不被演示数据顶掉
  });
});
