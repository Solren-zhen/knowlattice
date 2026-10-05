/**
 * 渲染后 DOM 的超链接清洗。
 *
 * docx-preview 的 renderHyperlink 对 a[href] 没有协议白名单
 * （node_modules/docx-preview/dist/docx-preview.js:3536-3547），Word 文档里的
 * javascript:/file: 链接会原样落进 DOM，点击即执行或转交系统。渲染器是第三方库
 * 不好改，所以在渲染完成后对挂载点做一遍清扫。
 */

/** 允许出现在 a[href] 里的协议；其余（javascript:/data:/file:/vbscript:…）一律摘除 */
const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** 判断 href 是否安全；空 href（a 无 href 属性）也按安全处理（无可执行面） */
export function isSafeHref(href: string | null): boolean {
  if (href === null) return true;
  try {
    return SAFE_HREF_PROTOCOLS.has(new URL(href, 'https://knowlattice.invalid/').protocol);
  } catch {
    return false;
  }
}

/** 相对 href 按当前页面协议解析后的协议；仅用于测试与展示 */
export function resolveHrefProtocol(href: string, base = 'https://knowlattice.invalid/'): string {
  return new URL(href, base).protocol;
}

/**
 * 外链开窗白名单：window.open 之前判协议。
 * 只放行 http(s) 与 mailto——javascript:/data:/vbscript: 在部分上下文可执行，
 * file:/自定义协议会被转交系统处理（可能拉起外部程序）。相对地址按页面协议
 * 解析后放行。不安全返回 null，由调用方决定忽略还是提示。
 */
export function safeExternalUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base ?? globalThis.location?.href ?? 'https://knowlattice.invalid/');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * 清洗挂载点内所有 a[href]：协议不在白名单里就摘 href、降级为纯文本外观，
 * 并加 no-referrer。返回被清洗的链接数（供测试与调试日志）。
 * 对渲染后 DOM 只做属性级修改，不动子树结构（保住 docx-preview 的排版）。
 */
export function sanitizeRenderedHyperlinks(root: Element | null | undefined): number {
  if (!root) return 0;
  let cleaned = 0;
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!isSafeHref(href)) {
      a.removeAttribute('href');
      a.setAttribute('title', '链接已禁用：文档内链接使用了不允许的协议');
      cleaned += 1;
    }
    a.setAttribute('rel', 'noreferrer noopener');
  });
  return cleaned;
}
