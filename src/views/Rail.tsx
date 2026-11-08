/**
 * 左侧导航轨：只放**去处**，不放功能。
 *
 * 两态内容一致：收起态（66px 图标列）与展开态（208px 带文字）都只列**五个母主题**——
 * 工作区 / 学习 / 资料 / 工具 / 系统。条目挂在母主题下。
 *
 * 展开态是**竖向手风琴**：点母主题就在它下面把条目摊在轨上，可以同时摊开几组、再点收回；
 * 摊开了哪几组记在 localStorage（knowlattice-rail-open-groups）。头一次打开默认摊开当前
 * 所在的那一组——用户没表过态时替他们露一次入口，之后一律听他们的。
 * 收起态只有 66px，放不下文字，才用右侧浮层。
 *
 * 为什么是「右侧浮层」而不是球状/扇形展开：
 *   - 扇形的命中区按角度切，要求指针从圆心笔直出去；这里的动作是「从轨道横移→选一项」，
 *     两段折线，绕弧走必然扫过邻项，5 个母主题的扇形还会互相压住，hover 会抖。
 *   - 66px 的轨装 6 项扇形，弧上相邻可点间距不足 32px，比 Fitts 能忍的还小。
 *   - 键盘 Tab 没法沿弧走。纵向浮层的顺序就是 DOM 顺序，可访问性免费。
 *   折中保留「分支」的读感：母按钮到浮层之间有一条 8px 引线，浮层顶部对齐母按钮中心。
 *
 * hover 容错：进 120ms 才浮出（横穿整条轨不会连闪），出 170ms 才收起（斜着划进浮层不会掉），
 * 期间进任何浮层都取消收起。已有浮层时换组只等 60ms——换组要快，重开要慢。
 * 滚动或窗口尺寸变了直接关：浮层是 position: fixed 按按钮屏幕坐标定位的，锚点一移就错位。
 *
 * 窄屏（<=1040px）走抽屉，指针悬停不可用：点母主题在该组下方原地展开。
 * 加一个功能 = 往 railCatalog.tsx 的 RAIL_GROUPS 加一行，再去 Workspace 的 openFeature 补处理器。
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { IconChevron, IconLogo } from './icons';
import { RAIL_GROUPS, type Entry, type RailKey } from './railCatalog';

interface Props {
  activeItem: string | null;
  treeOpen: boolean;
  onHome: () => void;
  /** 每个去处一个处理器；键必须覆盖 RailKey（漏一个会编译失败） */
  actions: Record<RailKey, () => void>;
  /** 悬停/聚焦时通知外部预取该面板的 chunk（可选：不传就只做导航） */
  onPrefetch?: (key: RailKey) => void;
}

/** 浮层与母按钮之间的水平间距（px）；引线宽度跟着它走 */
const BRANCH_GAP = 8;
/** 手风琴展开集合的存储键 */
const RAIL_OPEN_KEY = 'knowlattice-rail-open-groups';

/** 五个母主题的语义色调：只染图标一个维度（hover/激活由 CSS 用同一变量加深）。
 *  给「五组是同一 Dock 里的五类」提供一眼可辨的锚点。全部取自既有语义令牌，
 *  不引入新色值——四套主题都随令牌自动适配（国风下 muted/cyan/amber 有各自覆写）。 */
const GROUP_TINTS: Record<string, string> = {
  工作区: 'var(--accent)',
  学习: 'var(--accent)',
  资料: 'var(--cyan-text)',
  工具: 'var(--amber-text)',
  系统: 'var(--muted)',
};

export default function Rail(p: Props) {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const groupRefs = useRef(new Map<string, HTMLButtonElement>());
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia?.('(max-width: 1040px)').matches === true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopExpanded, setDesktopExpanded] = useState(() => {
    try {
      const preference = localStorage.getItem('knowlattice-rail-expanded');
      return preference === null
        ? window.matchMedia?.('(min-width: 1041px)').matches === true
        : preference === 'true';
    } catch { return false; }
  });
  // 窄屏走抽屉；宽屏两态，宽度不同但都只列五个母主题
  const expanded = isNarrow ? mobileOpen : desktopExpanded;
  /** 宽屏浮出的分支面板；top/left 是母按钮的屏幕坐标（面板 position: fixed，绕开 .rail-scroll 的裁剪） */
  const [branch, setBranch] = useState<{ title: string; top: number; left: number; pinned: boolean } | null>(null);
  /**
   * 轨上摊开的母主题（手风琴）。用户可以单开、多开、全收，选择记在 localStorage：
   * 「折叠还是展开」是用户的事，不该由「当前在哪一页」替他们决定。
   */
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(RAIL_OPEN_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(list)) return new Set(list.filter((title): title is string => typeof title === 'string'));
    } catch { /* 隐私模式或坏数据：退回默认 */ }
    // 头一次用：把当前所在那一组摊开；没有当前项时摊工作区，目录/搜索因此永远看得见
    const key = p.treeOpen ? 'tree' : p.activeItem;
    const here = RAIL_GROUPS.find((group) => group.entries.some((entry) => entry.key === key)) ?? RAIL_GROUPS[0];
    return new Set([here.title]);
  });
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const branchRef = useRef<HTMLDivElement>(null);
  /** 这次浮出是不是键盘要的（是的话把焦点送进去，鼠标悬停不抢焦点） */
  const wantFocus = useRef(false);

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1040px)');
    if (!media) return;
    const syncViewport = () => {
      setIsNarrow(media.matches);
      setMobileOpen(false);
      setBranch(null);
    };
    media.addEventListener?.('change', syncViewport);
    return () => media.removeEventListener?.('change', syncViewport);
  }, []);

  useEffect(() => {
    if (!isNarrow || !mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isNarrow, mobileOpen]);

  // 浮层按屏幕坐标定位：锚点一动（轨内滚动、窗口缩放、失焦）就关掉，不做跟随。
  // Escape 关掉并把焦点还给母按钮——键盘用户从浮层退回上一级。
  useEffect(() => {
    if (!branch) return;
    const title = branch.title;
    const close = () => setBranch(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setBranch(null);
      groupRefs.current.get(title)?.focus();
    };
    const scroller = document.querySelector('.rail-scroll');
    scroller?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      scroller?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [branch]);

  // 键盘打开：焦点落在该组「当前项」上，没有当前项就落第一项。
  // 悬停打开不抢焦点——鼠标用户不该被偷走输入焦点。
  useEffect(() => {
    if (!branch || !wantFocus.current) return;
    wantFocus.current = false;
    const group = RAIL_GROUPS.find((item) => item.title === branch.title);
    if (!group) return;
    const key = p.treeOpen ? 'tree' : p.activeItem;
    const index = Math.max(0, group.entries.findIndex((entry) => entry.key === key));
    const items = Array.from(branchRef.current?.querySelectorAll<HTMLButtonElement>('.rail-branch-item') ?? []);
    (items[index] ?? items[0])?.focus();
  }, [branch, p.activeItem, p.treeOpen]);

  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  /** 把浮层摆到母按钮右侧并垂直居中，再夹进视口 */
  const placeBranch = (title: string, el: HTMLElement, pinned = false) => {
    const group = RAIL_GROUPS.find((item) => item.title === title);
    if (!group) return;
    const rect = el.getBoundingClientRect();
    // 预算高度：条目 32 + 表头 26 + 上下内边距 12；实际高度由内容决定，这里只用来居中与夹边
    const budget = Math.min(group.entries.length * 32 + 38, window.innerHeight - 24);
    const centered = rect.top + rect.height / 2 - budget / 2;
    const top = Math.max(8, Math.min(centered, window.innerHeight - budget - 8));
    setBranch({ title, top, left: rect.right + BRANCH_GAP, pinned });
  };

  /** 键盘路线：ArrowRight / Enter 打开并把焦点送进浮层当前项 */
  const openWithKeys = (title: string, el: HTMLElement) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    wantFocus.current = true;
    placeBranch(title, el, true);
  };

  /** 摊开/收起某一组（手风琴）。选择立刻落盘：用户表过的态，下次打开还是那样 */
  const setGroupOpen = (title: string, open: boolean) => {
    setOpenGroups((current) => {
      if (current.has(title) === open) return current;
      const next = new Set(current);
      if (open) next.add(title);
      else next.delete(title);
      try { localStorage.setItem(RAIL_OPEN_KEY, JSON.stringify([...next])); } catch { /* 隐私模式 */ }
      return next;
    });
  };

  const hoverGroup = (title: string, el: HTMLElement) => {
    // 展开态与窄屏都是手风琴：条目就在轨上，不再浮一份重复的东西
    if (expanded || isNarrow) return;
    window.clearTimeout(closeTimer.current);
    if (branch?.title === title) {
      window.clearTimeout(openTimer.current);
      return;
    }
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => placeBranch(title, el), branch ? 60 : 120);
  };

  const leaveRail = () => {
    if (isNarrow) return;
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setBranch(null), 170);
  };

  const clickGroup = (title: string, el: HTMLElement) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    // 窄屏抽屉还关着：先把抽屉打开，同时摊开这一组
    if (isNarrow && !mobileOpen) {
      setMobileOpen(true);
      setGroupOpen(title, true);
      return;
    }
    // 展开态：点母主题 = 在轨上摊开/收起它（同一组可以再点收回）
    if (expanded) {
      setBranch(null);
      setGroupOpen(title, !openGroups.has(title));
      return;
    }
    // 收起态（66px 图标轨）放不下文字，只能浮层：钉住的再点一次收起，
    // 悬停浮出来的那一个点下去是钉住而不是关掉（否则鼠标用户指过去点一下，浮层就没了）
    if (branch?.title === title && branch.pinned) {
      setBranch(null);
      return;
    }
    placeBranch(title, el, true);
  };

  /** 一条去处的渲染模板；浮层里与窄屏内联共用，避免两套样式走散 */
  const entryRow = (entry: Entry, inline: boolean) => {
    const active = entry.key === 'tree' ? p.treeOpen : p.activeItem === entry.key;
    return (
      <button
        key={entry.key}
        className={`${inline ? 'rail-btn' : 'rail-branch-item'}${active ? ' on' : ''}`}
        aria-label={entry.label}
        aria-current={p.activeItem === entry.key ? 'page' : undefined}
        aria-pressed={entry.key === 'tree' ? p.treeOpen : undefined}
        data-stay-open={entry.keepDrawer ? 'true' : undefined}
        onPointerEnter={() => p.onPrefetch?.(entry.key)}
        onFocus={() => p.onPrefetch?.(entry.key)}
        onClick={() => {
          p.actions[entry.key]();
          setBranch(null);
        }}
      >
        {entry.icon}
        <span className="rail-label">{entry.label}</span>
      </button>
    );
  };

  // 展开态是手风琴：哪几组摊在轨上完全由用户决定（openGroups），当前所在的那一组只是默认摊开。

  const openGroup = branch ? RAIL_GROUPS.find((group) => group.title === branch.title) : null;

  return (
    <Fragment>
      <nav
        className={`rail${expanded ? ' rail--expanded' : ''}`}
        aria-label="主导航"
        onClick={(event) => {
          if (event.target === event.currentTarget && isNarrow && mobileOpen) {
            setMobileOpen(false);
            return;
          }
          // 选中条目才收抽屉；点母主题是「原地展开/收起」，不是离开
          const action = (event.target as HTMLElement).closest('.rail-home, .rail-inline .rail-btn');
          // 浮层类入口（data-stay-open）不收抽屉：收起来就点不到第二次，开关语义当场失效
          if (isNarrow && mobileOpen && action && !action.classList.contains('rail-group-btn')
            && !action.hasAttribute('data-stay-open')) {
            setMobileOpen(false);
          }
        }}
      >
        <button
          ref={menuButtonRef}
          className="rail-expand"
          aria-label={isNarrow ? (mobileOpen ? '关闭导航' : '打开导航') : (desktopExpanded ? '收起导航标签' : '展开导航标签')}
          aria-expanded={expanded}
          title={expanded ? undefined : '展开导航'}
          onClick={() => {
            if (isNarrow) {
              setMobileOpen((open) => !open);
              return;
            }
            const next = !desktopExpanded;
            try { localStorage.setItem('knowlattice-rail-expanded', String(next)); } catch {}
            setDesktopExpanded(next);
          }}
        >
          <span className="rail-expand-icon"><IconChevron /></span>
          <span className="rail-expand-label">{expanded ? '收起导航' : '展开导航'}</span>
        </button>

        <div className="rail-scroll">
          <button className="rail-home" aria-label="回到主界面" title="回到主界面" onClick={p.onHome}>
            <IconLogo /><span className="rail-label">KnowLattice</span>
          </button>

          {RAIL_GROUPS.map((group) => {
            const here = group.entries.find((entry) => entry.key === (p.treeOpen ? 'tree' : p.activeItem));
            const isOpen = branch?.title === group.title;
            const isFolded = expanded && openGroups.has(group.title);
            return (
              <div className="rail-group" key={group.title}>
                <button
                  ref={(el) => { if (el) groupRefs.current.set(group.title, el); }}
                  className={`rail-btn rail-group-btn${here ? ' on' : ''}${isOpen ? ' is-open' : ''}`}
                  style={{ ['--rail-tint' as string]: GROUP_TINTS[group.title] }}
                  aria-label={group.title}
                  aria-haspopup={expanded ? undefined : 'true'}
                  aria-expanded={isFolded || isOpen}
                  aria-current={here ? 'page' : undefined}
                  onPointerEnter={(event) => hoverGroup(group.title, event.currentTarget)}
                  onPointerLeave={leaveRail}
                  onClick={(event) => clickGroup(group.title, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    // 手风琴：先摊开这一组，再把焦点送进第一条（下一帧才有 DOM）
                    if (expanded || isNarrow) {
                      setBranch(null);
                      setGroupOpen(group.title, true);
                      window.setTimeout(() => {
                        groupRefs.current.get(group.title)?.parentElement
                          ?.querySelector<HTMLButtonElement>('.rail-inline .rail-btn')?.focus();
                      }, 0);
                      return;
                    }
                    openWithKeys(group.title, event.currentTarget);
                  }}
                >
                  {group.icon}
                  <span className="rail-label">{group.title}</span>
                  <span className="rail-group-caret" aria-hidden="true" />
                  {/* 收起态：组内条目数与当前位置压成点阵（灰阶、不占宽、当前项实心） */}
                  <span className="rail-group-dots" aria-hidden="true">
                    {group.entries.map((entry) => (
                      <i key={entry.key} className={entry.key === (p.treeOpen ? 'tree' : p.activeItem) ? 'on' : undefined} />
                    ))}
                  </span>
                </button>
                {isFolded && (
                  <div
                    className="rail-inline"
                    role="group"
                    aria-label={group.title}
                    onKeyDown={(event) => {
                      // 与浮层同一套键盘模型：↑↓ 组内走、Home/End 到两端、↑ 到顶退回母按钮、Esc 收起
                      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.rail-btn'));
                      const at = items.indexOf(document.activeElement as HTMLButtonElement);
                      const focus = (next: number) => { event.preventDefault(); items[next]?.focus(); };
                      if (event.key === 'ArrowDown') focus(Math.min(items.length - 1, at + 1));
                      else if (event.key === 'ArrowUp') {
                        if (at <= 0) { event.preventDefault(); groupRefs.current.get(group.title)?.focus(); }
                        else focus(at - 1);
                      } else if (event.key === 'Home') focus(0);
                      else if (event.key === 'End') focus(items.length - 1);
                      else if (event.key === 'Escape') {
                        event.preventDefault();
                        setGroupOpen(group.title, false);
                        groupRefs.current.get(group.title)?.focus();
                      }
                    }}
                  >
                    {group.entries.map((entry) => entryRow(entry, true))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {branch && openGroup && (
        <div
          ref={branchRef}
          className="rail-branch"
          role="group"
          aria-label={openGroup.title}
          style={{ top: branch.top, left: branch.left }}
          onPointerEnter={() => window.clearTimeout(closeTimer.current)}
          onPointerLeave={leaveRail}
          onKeyDown={(event) => {
            // 纵向浮层的键盘模型：↑↓ 在组内走，Home/End 到两端，←/Esc 退回母按钮
            const items = Array.from(branchRef.current?.querySelectorAll<HTMLButtonElement>('.rail-branch-item') ?? []);
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const focus = (next: number) => { event.preventDefault(); items[next]?.focus(); };
            if (event.key === 'ArrowDown') focus(Math.min(items.length - 1, at + 1));
            else if (event.key === 'ArrowUp') {
              if (at <= 0) { event.preventDefault(); groupRefs.current.get(openGroup.title)?.focus(); }
              else focus(at - 1);
            } else if (event.key === 'Home') focus(0);
            else if (event.key === 'End') focus(items.length - 1);
          }}
        >
          <div className="rail-branch-head">
            <span>{openGroup.title}</span>
            <span className="rail-branch-count">{openGroup.entries.length}</span>
          </div>
          {openGroup.entries.map((entry) => entryRow(entry, false))}
        </div>
      )}
    </Fragment>
  );
}
