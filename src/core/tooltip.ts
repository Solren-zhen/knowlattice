/**
 * 全局悬浮提示：监听所有 [data-tip] 元素，单一气泡挂在 body 上智能定位。
 * - 左右贴边钳制（永不超出屏幕）；上方空间不足自动翻到下方；箭头对准按钮中心
 * - 180ms 显示延迟防快速划过串扰；滚动/缩放时隐藏（位置会失效）
 */

let tipEl: HTMLDivElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let currentAnchor: HTMLElement | null = null;

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'mv-tooltip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hide() {
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(() => tipEl?.classList.remove('on'), 60);
}

function show(anchor: HTMLElement) {
  const text = anchor.getAttribute('data-tip');
  if (!text) return;
  const el = ensureEl();
  window.clearTimeout(hideTimer);
  if (currentAnchor === anchor && el.classList.contains('on')) return;
  currentAnchor = anchor;
  showTimer = window.setTimeout(() => {
    el.textContent = text;
    el.classList.add('on');
    // 先隐藏再测量，避免闪跳
    el.style.visibility = 'hidden';
    el.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    // 水平：对准按钮中心，左右贴边钳制
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    // 垂直：优先上方；空间不足翻到下方
    const flip = r.top < th + 14;
    const top = flip ? r.bottom + 10 : r.top - th - 10;
    el.classList.toggle('below', flip);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    // 箭头对准按钮中心（钳制在气泡内）
    const arrowLeft = Math.max(12, Math.min(r.left + r.width / 2 - left, tw - 12));
    el.style.setProperty('--arrow-left', `${Math.round(arrowLeft)}px`);
    el.style.visibility = '';
  }, 180);
}

/** 在应用入口调用一次即可 */
export function initTooltips() {
  if (typeof document === 'undefined') return;
  document.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.('[data-tip]') as HTMLElement | null;
    if (anchor && anchor.getAttribute('data-tip')) show(anchor);
    else if (currentAnchor && (!anchor || anchor !== currentAnchor)) { hide(); currentAnchor = null; }
  });
  document.addEventListener('mousedown', () => { hide(); currentAnchor = null; });
  window.addEventListener('scroll', () => { hide(); currentAnchor = null; }, true);
  window.addEventListener('resize', () => { hide(); currentAnchor = null; });
}
