// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeRenderedHtml } from '../domSanitize';

describe('sanitizeRenderedHtml', () => {
  it('移除脚本、内嵌页面和事件处理器', () => {
    const clean = sanitizeRenderedHtml('<p onclick="alert(1)">正文</p><script>alert(1)</script><iframe src="https://evil.example"></iframe>');
    expect(clean).toContain('<p>正文</p>');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<iframe');
  });

  it('移除危险链接协议，保留正常链接', () => {
    const clean = sanitizeRenderedHtml('<a href="javascript:alert(1)">坏</a><a href="https://example.com">好</a>');
    expect(clean).toContain('>坏</a>');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('href="https://example.com"');
  });

  it('拒绝非图片 data URL 与危险图片事件', () => {
    const clean = sanitizeRenderedHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" onerror="alert(1)"><img src="https://example.com/a.png">');
    expect(clean).not.toContain('data:text/html');
    expect(clean).not.toContain('onerror');
    expect(clean).toContain('src="https://example.com/a.png"');
  });

  it('保留 KaTeX / 通路图需要的 class、style 与安全 SVG', () => {
    const clean = sanitizeRenderedHtml('<span class="katex" style="height:1em"><svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg></span>');
    expect(clean).toContain('class="katex"');
    expect(clean).toContain('style="height:1em"');
    expect(clean).toContain('<svg');
    expect(clean).toContain('<path');
  });
});
