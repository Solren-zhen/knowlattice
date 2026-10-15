/**
 * 选择滑动（v4）：活动项的高亮不再「旧的消失、新的出现」，而是由一枚共享「墨迹」
 * 滑过去 —— 键盘 ↑↓ 或指针划过时，高亮像被拎着走。这是高级列表里最容易被感知、
 * 又最难靠 CSS 单点做出来的细节。
 *
 * 与 core/navIndicator.ts 的分工：那边专门负责导航轨（它有 aria-current / 展开态 /
 * 滚动内容等特例），这里做的是**可复用的通用列表容器**——每个匹配的容器各挂一枚墨迹，
 * 容器何时出现（面板条件挂载）也不关心，靠一层发现式观察者补挂。navIndicator 一行不改。
 *
 * 位置换算用 getBoundingClientRect 的差再补上容器的 scrollLeft / scrollTop：
 * 墨迹是**滚动内容的一部分**，容器滚动时它跟着内容走，不需要额外监听滚动。
 * 挂 html.glide-ink-on 后，活动项自己的底色被隐藏（见 index.css），避免两层重叠。
 */

export interface GlideGroup {
  /** 容器选择器：墨迹就放在它里面，它需要 position:relative（见 index.css） */
  container: string;
  /** 列表项选择器：带 .active 的那一项就是墨迹要去的位置 */
  item: string;
}

/** 需要滑动的列表容器。加一处就多一处「墨迹」，不需要改组件。 */
export const GLIDE_GROUPS: readonly GlideGroup[] = [
  { container: '.qs-results', item: '.qs-item' },
  { container: '.todo-side__group', item: '.todo-side__item' },
];

export const GLIDE_INK_CLASS = 'glide-ink';
/** 挂在 <html> 上的总开关：CSS 据此隐藏活动项自己的底色 */
export const GLIDE_ROOT_CLASS = 'glide-ink-on';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把激活项的**视口矩形**换算成容器**内容坐标系**下的墨迹盒子：补上容器的滚动量后，
 * 墨迹就锚在内容上（容器滚动时不需要重测）。纯函数，可直接单测。
 */
export function inkBox(active: Box, container: Box, scrollLeft = 0, scrollTop = 0): Box {
  return {
    left: active.left - container.left + scrollLeft,
    top: active.top - container.top + scrollTop,
    width: active.width,
    height: active.height,
  };
}

export function initSelectionGlide(): () => void {
  if (typeof document === 'undefined') return () => {};

  const attached = new Map<HTMLElement, () => void>();
  document.documentElement.classList.add(GLIDE_ROOT_CLASS);

  function attach(container: HTMLElement, item: string): () => void {
    const ink = document.createElement('span');
    ink.className = GLIDE_INK_CLASS;
    ink.setAttribute('aria-hidden', 'true');
    container.prepend(ink);

    let placed = false;
    let raf = 0;

    function place() {
      raf = 0;
      const active = container.querySelector<HTMLElement>(`${item}.active`);
      if (!active) {
        ink.classList.remove('on');
        return;
      }
      const box = inkBox(
        active.getBoundingClientRect(),
        container.getBoundingClientRect(),
        container.scrollLeft,
        container.scrollTop,
      );
      if (!placed) {
        // 首次落位不许从 (0,0) 滑过来：先关过渡、直接摆到目标，下一帧再打开
        placed = true;
        ink.style.transition = 'none';
        requestAnimationFrame(() => ink.style.removeProperty('transition'));
      }
      ink.style.transform = `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px)`;
      ink.style.width = `${box.width.toFixed(2)}px`;
      ink.style.height = `${box.height.toFixed(2)}px`;
      ink.classList.add('on');
    }

    /** 合并触发的重测（一次批处理里可能改多处 class） */
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(place);
    }

    // 关键约束：墨迹自己也在这个被观察的子树里，忽略它的 class/style 变化，
    // 否则 place 写一次 .on 就会再次触发观察者 —— measure ↔ observer 死循环。
    const mo = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== ink) {
          schedule();
          break;
        }
      }
    });
    mo.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => schedule());
      ro.observe(container);
    }

    place();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      mo.disconnect();
      ro?.disconnect();
      ink.remove();
    };
  }

  let scanRaf = 0;
  function scan() {
    scanRaf = 0;
    // 先回收已卸载的容器（面板条件挂载，关闭后 DOM 被移除）
    for (const [el, dispose] of attached) {
      if (!el.isConnected) {
        dispose();
        attached.delete(el);
      }
    }
    for (const group of GLIDE_GROUPS) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(group.container))) {
        if (attached.has(el)) continue;
        attached.set(el, attach(el, group.item));
      }
    }
  }

  function scheduleScan() {
    if (scanRaf) return;
    scanRaf = requestAnimationFrame(scan);
  }

  scan();

  const rootMo =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => scheduleScan())
      : null;
  rootMo?.observe(document.body, { childList: true, subtree: true });

  return () => {
    if (scanRaf) cancelAnimationFrame(scanRaf);
    rootMo?.disconnect();
    for (const dispose of attached.values()) dispose();
    attached.clear();
    document.documentElement.classList.remove(GLIDE_ROOT_CLASS);
  };
}
