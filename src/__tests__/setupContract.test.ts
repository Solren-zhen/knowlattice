/**
 * 守住「全局等待预算真的生效」这件事。
 *
 * 价值不在断言本身，而在**接线**：`src/__tests__/setup.ts` 里 configure 的是
 * `@testing-library/dom` 的 config 子模块（为了省掉每文件 ~110ms 的加载成本而深引），
 * 而 RTL 的 `waitFor` / `findBy*` 读的是同一个模块实例。哪天有人换了导入方式（或依赖升级挪了
 * 内部路径），两边就可能各持一个实例——测试照样全绿，但「单跑绿、整套偶尔红」会悄悄回来，
 * 且没有任何提示：那正是这次要根治的那类假红。
 */
import { getConfig } from '@testing-library/dom/dist/config.js';
import { describe, expect, it } from 'vitest';

describe('测试环境契约', () => {
  it('RTL 的等待上限被全局 setup 放宽到 5s（改小等于把偶发假红放回来）', () => {
    expect(getConfig().asyncUtilTimeout).toBe(5000);
  });
});
