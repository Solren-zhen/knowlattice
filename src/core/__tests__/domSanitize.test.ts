// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { isSafeHref, sanitizeRenderedHyperlinks, safeExternalUrl } from '../domSanitize';

describe('isSafeHref', () => {
  it('放行 http/https/mailto', () => {
    expect(isSafeHref('http://a.b/c')).toBe(true);
    expect(isSafeHref('https://a.b/c')).toBe(true);
    expect(isSafeHref('mailto:x@y.z')).toBe(true);
  });

  it('拒绝脚本与文件类协议（大小写/空白混淆也要挡住）', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHref(' javascript:alert(1)')).toBe(false);
    expect(isSafeHref('vbscript:msgbox')).toBe(false);
    expect(isSafeHref('file:///C:/secret.txt')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('相对地址按当前页面协议（https）解析 → 安全', () => {
    expect(isSafeHref('/help/page')).toBe(true);
    expect(isSafeHref('../other.md')).toBe(true);
  });

  it('无 href 属性视为安全（无可执行面）', () => {
    expect(isSafeHref(null)).toBe(true);
  });
});

describe('sanitizeRenderedHyperlinks（渲染后 DOM 清洗，审计 M1）', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('摘除 javascript:/file: 的 href，保留文本与排版结构', () => {
    host.innerHTML = `
      <section class="docx-wrapper">
        <p>正文 <a href="javascript:alert(1)">坏链接</a> 与
        <a href="https://ok.example/x">好链接</a> 与
        <a href="file:///C:/x">本地链</a>。</p>
      </section>`;
    const cleaned = sanitizeRenderedHyperlinks(host);
    expect(cleaned).toBe(2);
    const links = host.querySelectorAll('a');
    expect(links[0].getAttribute('href')).toBeNull();
    expect(links[0].textContent).toBe('坏链接'); // 文本保留，只是不可点执行
    expect(links[1].getAttribute('href')).toBe('https://ok.example/x');
    expect(links[2].getAttribute('href')).toBeNull();
    // 不动子树结构（docx-preview 排版依赖 wrapper）
    expect(host.querySelector('.docx-wrapper')).not.toBeNull();
    // 统一加 no-referrer
    expect(links[1].getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('空容器/null 返回 0，不抛错', () => {
    expect(sanitizeRenderedHyperlinks(null)).toBe(0);
    expect(sanitizeRenderedHyperlinks(host)).toBe(0);
  });
});

describe('safeExternalUrl（审计 L1：window.open 前的白名单）', () => {
  it('放行 http/https/mailto 并归一化', () => {
    expect(safeExternalUrl('https://a.b/c')).toBe('https://a.b/c');
    expect(safeExternalUrl('http://a.b/c')).toBe('http://a.b/c');
    expect(safeExternalUrl('mailto:x@y.z')).toBe('mailto:x@y.z');
    // 相对地址按页面协议解析，安全
    expect(safeExternalUrl('legal.md', 'https://app.example/')).toBe('https://app.example/legal.md');
  });

  it('拒绝脚本/文件/数据协议（大小写混淆也要挡）', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeExternalUrl(' javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('vbscript:msgbox')).toBeNull();
    expect(safeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeExternalUrl('ms-settings:display')).toBeNull();
  });

  it('非法 URL 返回 null 而不是抛错', () => {
    expect(safeExternalUrl('http://[::z/')).toBeNull();
  });
});
