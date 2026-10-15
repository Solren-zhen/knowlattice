/**
 * 「⋯」菜单的几何守卫（读 index.css 文本断言不变量）。
 *
 * 为什么不用 DOM 测试：jsdom 没有布局引擎，量不出「菜单比侧栏宽」。上次的事故就是一路绿灯——
 * 单元测试绿、lint 绿、构建绿，只有用户看到面板底部孤零零一行
 * 「…pkg / .txt / .docx / .pdf / .xlsx / .csv)」。
 *
 * 实测（真实 CSS + ChapterTree 的真实标记，侧栏 263px）：
 *   改前：菜单内容宽 417px，左边缘 x=-154（面板外约 167px），被 .tree-panel{overflow:hidden}
 *         裁掉——所有行的文字都从面板外开始，只剩最长那行的尾巴露在面板底部。
 *   改后：菜单 239px、x=25，完整落在面板内；两处长标签折行（行高 36px → 55px）。
 *
 * 这里钉住让改后结果成立的四条原因，任何一条被删掉，裁剪都会回来。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** 取选择器的声明块首段（`\n选择器 { … }`）：不解析嵌套，够用且不会误匹配注释里的同类文字 */
function block(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`index.css 里找不到规则 ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

describe('「⋯」菜单几何（视图 ↔ CSS 不变量）', () => {
  it('定位上下文是侧栏头部：宽度基准 = 面板宽，而不是 28px 的按钮外壳', () => {
    expect(block('.sidebar-header')).toContain('position: relative');
    // 按钮外壳一旦也是定位上下文，菜单的 100% 就变成 28px，宽度上限形同虚设
    expect(css).not.toContain('.more-wrap { position: relative');
  });

  it('菜单宽度上限以 100%（= 侧栏头部宽）为基准，且 min-width 不许超过它', () => {
    const menu = block('.more-wrap .more-menu');
    expect(menu).toContain('right: 12px');
    expect(menu).toMatch(/max-width:\s*calc\(100% - 24px\)/);
    // min-width 优先于 max-width：死值 220px 会让窄侧栏下再次溢出
    expect(block('.import-menu')).toMatch(/min-width:\s*min\(220px,\s*calc\(100% - 24px\)\)/);
  });

  it('长标签允许换行：一行放不下时折行，而不是把菜单顶得比侧栏宽', () => {
    expect(block('.more-menu div')).toContain('white-space: normal');
  });

  it('面板仍然裁剪溢出：所以「菜单比面板宽」必然表现为内容被切掉', () => {
    expect(block('.tree-panel')).toContain('overflow: hidden');
  });
});
