import { describe, expect, it } from 'vitest';
import { hasMathSyntax, renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('渲染标题为 HTML', async () => {
    expect(await renderMarkdown('# 标题')).toBe('<h1>标题</h1>\n');
  });

  it('转义原始 HTML（html:false，笔记里的 HTML 按纯文本显示）', async () => {
    const html = await renderMarkdown('<b>x</b>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('单换行转为 <br>（breaks:true）', async () => {
    expect(await renderMarkdown('a\nb')).toContain('<br>');
  });

  it('裸链接自动成链（linkify:true）', async () => {
    expect(await renderMarkdown('https://example.com')).toContain('href="https://example.com"');
  });

  it('重复调用共享同一实例，输出稳定', async () => {
    expect(await renderMarkdown('**加粗**')).toBe('<p><strong>加粗</strong></p>\n');
    expect(await renderMarkdown('**加粗**')).toBe('<p><strong>加粗</strong></p>\n');
  });
});

describe('数学公式（KaTeX）', () => {
  it('hasMathSyntax 识别各种公式语法', () => {
    expect(hasMathSyntax('能量 $E=mc^2$ 守恒')).toBe(true);
    expect(hasMathSyntax('$$\nE=mc^2\n$$')).toBe(true);
    expect(hasMathSyntax('行内 \\(a^2\\) 公式')).toBe(true);
    expect(hasMathSyntax('块级 \\[a^2\\] 公式')).toBe(true);
    expect(hasMathSyntax('普通文本，一点公式都没有')).toBe(false);
    expect(hasMathSyntax('血压 120/80 mmHg')).toBe(false);
  });

  it('行内公式渲染为 KaTeX 结构', async () => {
    const html = await renderMarkdown('质能方程 $E=mc^2$ 成立');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$E=mc^2$');
  });

  it('块级公式渲染为 katex-display', async () => {
    const html = await renderMarkdown('$$\nE=mc^2\n$$');
    expect(html).toContain('katex-display');
  });

  it('医学常用公式可渲染（肌酐清除率 / 阴离子间隙）', async () => {
    const cg = await renderMarkdown('$Ccr=\\frac{(140-age)\\times weight}{72\\times Scr}$');
    expect(cg).toContain('class="katex"');
    const ag = await renderMarkdown('$AG = Na^+ - (Cl^- + HCO_3^-)$');
    expect(ag).toContain('class="katex"');
  });

  it('无公式文档不引入 KaTeX（否则每篇笔记都白下约 1 MB 数学字体）', async () => {
    const html = await renderMarkdown('# 普通笔记\n\n正文没有公式');
    expect(html).not.toContain('katex');
  });

  it('畸形公式不抛异常', async () => {
    const html = await renderMarkdown('$\\frac{1}{$');
    expect(typeof html).toBe('string');
  });
});

describe('通路图（```pathway 围栏块）', () => {
  it('围栏块渲染为内联 SVG，而不是 <pre><code>', async () => {
    const html = await renderMarkdown('```pathway\n葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶\n```');
    expect(html).toContain('<svg');
    expect(html).toContain('己糖激酶');
    expect(html).not.toContain('language-pathway');
  });

  it('biochem 别名同样生效', async () => {
    const html = await renderMarkdown('```biochem\nA -> B\n```');
    expect(html).toContain('<svg');
  });

  it('普通围栏语言仍走代码块', async () => {
    const html = await renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('language-js');
    expect(html).not.toContain('<svg');
  });
});
