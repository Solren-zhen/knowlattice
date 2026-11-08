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
const SAFE_RENDERED_HREF_PROTOCOLS = new Set([...SAFE_HREF_PROTOCOLS, 'mv-wikilink:']);
const SAFE_RESOURCE_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'asset:', 'mv-image:']);
const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link']);

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

function safeRenderedUrl(raw: string | null, kind: 'href' | 'resource'): boolean {
  if (raw === null || raw.trim() === '') return true;
  const value = raw.trim();
  if (kind === 'resource' && /^data:image\//i.test(value)) return true;
  try {
    const protocol = new URL(value, 'https://knowlattice.invalid/').protocol;
    return kind === 'href'
      ? SAFE_RENDERED_HREF_PROTOCOLS.has(protocol)
      : SAFE_RESOURCE_PROTOCOLS.has(protocol);
  } catch {
    return false;
  }
}

/**
 * 清洗完整 HTML 字符串，作为所有 dangerouslySetInnerHTML 渲染前的统一闸门。
 * 在 Node（无 DOM）中原样返回，浏览器和 jsdom 中通过惰性 template 解析并剥离危险节点/属性。
 */
export function sanitizeRenderedHtml(html: string): string {
  if (!html || typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  root.querySelectorAll([...BLOCKED_TAGS].join(',')).forEach((element) => element.remove());
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' && !safeRenderedUrl(attribute.value, 'href')) {
        element.removeAttribute(attribute.name);
        element.setAttribute('title', '链接已禁用：使用了不允许的协议');
      }
      if ((name === 'src' || name === 'poster') && !safeRenderedUrl(attribute.value, 'resource')) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === 'a') element.setAttribute('rel', 'noreferrer noopener');
  });
  return template.innerHTML;
}
