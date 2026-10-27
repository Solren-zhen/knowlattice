/**
 * 写剪贴板：优先 Clipboard API；非安全上下文或未授权时退回临时 textarea + execCommand。
 *
 * 为什么单独抽出来：编辑器的自定义右键菜单接管了系统菜单，复制/剪切必须自己可靠地完成；
 * 图片库的「复制识别文字」也需要同一份逻辑。两份实现的下场是——修了一处，另一处在
 * http 环境（非安全上下文）里静默失败，还查不出为什么。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
