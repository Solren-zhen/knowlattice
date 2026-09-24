import { useEffect, useRef, type KeyboardEvent, type MouseEventHandler, type ReactNode } from 'react';

interface Props {
  label: string;
  className: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const activeDialogs = new Set<HTMLElement>();
let returnFocusTarget: HTMLElement | null = null;
let restoreFrame: number | null = null;

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    const style = window.getComputedStyle(element);
    const closedDetails = element.closest('details:not([open])');
    return !element.hidden && !element.closest('[hidden], [aria-hidden="true"]') && (!closedDetails || element.tagName === 'SUMMARY') && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

export default function DialogSurface({ label, className, children, onClick }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (restoreFrame !== null) {
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
      const currentFocus = document.activeElement;
      if (currentFocus instanceof HTMLElement && currentFocus !== document.body) {
        returnFocusTarget = currentFocus;
      } else if (!returnFocusTarget?.isConnected || returnFocusTarget === document.body) {
        returnFocusTarget = null;
      }
    }
    if (activeDialogs.size === 0 && !returnFocusTarget?.isConnected) {
      returnFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    activeDialogs.add(dialog);
    dialog?.focus();
    const app = dialog?.closest('.app');
    const dialogLayer = dialog?.closest('.panel-backdrop, .panel--full') ?? dialog;
    const inertSiblings = app && dialogLayer
      ? (Array.from(app.children) as HTMLElement[]).filter((element) => element !== dialogLayer).map((element) => ({ element, inert: element.inert }))
      : [];
    inertSiblings.forEach(({ element }) => { element.inert = true; });
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      const target = event.target;
      if (!dialog || !(target instanceof Node) || dialog.contains(target)) return;
      if (document.querySelector('[role="alertdialog"][aria-modal="true"]')) return;
      const modalDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
      const topmostDialog = modalDialogs.at(-1);
      if (target instanceof Element && target.closest('[role="dialog"][aria-modal="true"]')) return;
      if (topmostDialog !== dialog) return;
      dialog.focus();
    };
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      if (dialog) activeDialogs.delete(dialog);
      inertSiblings.forEach(({ element, inert }) => { element.inert = inert; });
      if (activeDialogs.size === 0) {
        restoreFrame = window.requestAnimationFrame(() => {
          restoreFrame = null;
          if (activeDialogs.size > 0) return;
          if (document.querySelector('[role="alertdialog"][aria-modal="true"], [role="dialog"][aria-modal="true"], .panel--full, .panel-backdrop')) return;
          if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          const target = returnFocusTarget;
          returnFocusTarget = null;
          if (target?.isConnected) target.focus();
        });
      }
    };
  }, []);

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      onKeyDown={trapTab}
    >
      {children}
    </div>
  );
}
