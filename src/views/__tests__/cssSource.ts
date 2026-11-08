/**
 * 样式全集读取器（测试专用）。
 *
 * `src/index.css` 现在只是入口：它按顺序 `@import './styles/*.css'`，规则本体在 partial 里。
 * 需要「整份 CSS 文本」做文本断言的守卫（类名守卫 / 菜单几何守卫）必须走这里，
 * 而不是直接读入口文件——直接读只能看到 12 行 @import，断言会全部落空。
 *
 * 拼接顺序与入口里 @import 的顺序一致，也就是构建产物里的级联顺序。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 样式入口（相对仓库根） */
export const STYLE_ENTRY = 'src/index.css';

/** 按入口的 @import 顺序展开成一份完整 CSS 文本 */
export function readStyles(): string {
  const entry = resolve(process.cwd(), STYLE_ENTRY);
  return readFileSync(entry, 'utf8').replace(
    /^@import\s+'([^']+)';/gm,
    (_, rel: string) => readFileSync(resolve(dirname(entry), rel), 'utf8'),
  );
}
