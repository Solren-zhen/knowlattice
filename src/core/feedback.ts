/**
 * 全局反馈系统：toast 轻提示 + confirmBox 模态确认框。
 * 与 tooltip.ts 同思路的命令式单例（直接挂 body），任何模块可同步调用：
 * - toast(msg, kind)：成功/错误/信息三类，自动消失，替代原生 alert
 * - confirmBox(opts)：Promise<boolean>，Esc/取消 = false，替代原生 confirm
 * 样式走全局设计令牌（index.css .mv-toast / .mv-confirm）。
 */

export type ToastKind = 'ok' | 'err' | 'info';

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'mv-toast-host';
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message: string, kind: ToastKind = 'info', durationMs?: number) {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.className = `mv-toast ${kind}`;
  el.textContent = message;
  ensureHost().appendChild(el);
  // 下一帧再加 on，触发入场动画
  requestAnimationFrame(() => el.classList.add('on'));
  const ms = durationMs ?? (kind === 'err' ? 4200 : 2400);
  setTimeout(() => {
    el.classList.remove('on');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

export interface ConfirmOptions {
  title: string;
  detail?: string;
  /** 危险操作（删除等）：确认键用红色 */
  danger?: boolean;
  okText?: string;
  cancelText?: string;
}

export function confirmBox(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(false); return; }
    const overlay = document.createElement('div');
    overlay.className = 'mv-confirm-overlay';
    overlay.innerHTML = `
      <div class="mv-confirm" role="alertdialog" aria-modal="true" aria-label="${opts.title}">
        <div class="mv-confirm-title">${opts.danger ? '<span class="mv-confirm-danger-dot"></span>' : ''}${opts.title}</div>
        ${opts.detail ? `<div class="mv-confirm-detail"></div>` : ''}
        <div class="mv-confirm-actions">
          <button class="mv-confirm-cancel">${opts.cancelText ?? '取消'}</button>
          <button class="mv-confirm-ok ${opts.danger ? 'danger' : ''}">${opts.okText ?? '确定'}</button>
        </div>
      </div>`;
    if (opts.detail) {
      // detail 走 textContent 防注入（innerHTML 只用于固定结构）
      overlay.querySelector('.mv-confirm-detail')!.textContent = opts.detail;
    }
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('on'));

    const done = (result: boolean) => {
      overlay.classList.remove('on');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('mv-confirm-ok')) done(true);
      else if (t.classList.contains('mv-confirm-cancel') || t === overlay) done(false);
    });
    // 默认聚焦确认键，Enter 直接触发
    requestAnimationFrame(() => (overlay.querySelector('.mv-confirm-ok') as HTMLElement | null)?.focus());
  });
}
