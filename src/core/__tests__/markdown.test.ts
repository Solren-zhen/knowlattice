import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';

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
