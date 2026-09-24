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
    const titleText = String(opts.title ?? '');
    const dialog = document.createElement('div');
    dialog.className = 'mv-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', titleText);

    const title = document.createElement('div');
    title.className = 'mv-confirm-title';
    if (opts.danger) {
      const dot = document.createElement('span');
      dot.className = 'mv-confirm-danger-dot';
      title.append(dot);
    }
    title.append(document.createTextNode(titleText));
    dialog.append(title);

    if (opts.detail) {
      const detail = document.createElement('div');
      detail.className = 'mv-confirm-detail';
      detail.textContent = String(opts.detail);
      dialog.append(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'mv-confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'mv-confirm-cancel';
    cancel.textContent = String(opts.cancelText ?? '取消');
    const ok = document.createElement('button');
    ok.className = `mv-confirm-ok${opts.danger ? ' danger' : ''}`;
    ok.textContent = String(opts.okText ?? '确定');
    actions.append(cancel, ok);
    dialog.append(actions);
    overlay.append(dialog);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('on'));

    let finished = false;
    const done = (result: boolean) => {
      if (finished) return;
      finished = true;
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
    requestAnimationFrame(() => ok.focus());
  });
}
