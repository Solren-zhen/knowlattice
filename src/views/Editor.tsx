/**
 * 编辑器（M1+M3）：CodeMirror 6 + Markdown + [[双链自动补全。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, undo, redo } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { livePreview, toggleLivePreview } from '../core/livePreview';
import { FORMAT_KEYS, toggleMark, wikiLink } from '../core/mdFormat';
import { insertTable, tableSkeleton, TABLE_MAX_COLS, TABLE_MAX_ROWS, textToTable } from '../core/mdTable';
import { toast } from '../core/feedback';
import { IconEye } from './icons';

/** 行内标记：工具栏按钮与快捷键共用同一段实现（见 applyMark / applyWikiLink）。 */
const MARK_BOLD = ['**', '加粗内容'] as const;
const MARK_HIGHLIGHT = ['==', '高亮内容'] as const;
const MARK_ITALIC = ['*', '斜体内容'] as const;

const applyMark = (v: EditorView, [marker, placeholder]: readonly [string, string]) => {
  const { from, to } = v.state.selection.main;
  v.dispatch(toggleMark(v.state.doc.toString(), from, to, marker, placeholder));
};

/** 选区的规范化边界：从右往左拖选时 CM 的 from/to 会反向，直接用会取到空串或非法区间 */
const selBounds = (v: EditorView) => {
  const { from, to } = v.state.selection.main;
  return from <= to ? { from, to } : { from: to, to: from };
};

const applyWikiLink = (v: EditorView) => {
  const { from, to } = v.state.selection.main;
  v.dispatch(wikiLink(v.state.doc.toString(), from, to));
  // 插入 [[]] 是程序化改动，不会触发补全的「打字激活」，于是工具栏/快捷键插入后
  // 输入中文永远等不到候选（手打 [[ 会弹，是因为那两个键本身激活了补全）。
  // 这里显式拉一次候选，让「插入双链就能从列表里挑笔记」名副其实。
  if (from === to) startCompletion(v);
};

/**
 * 四个格式命令：名称 + 键位（来自 core/mdFormat.ts）+ 动作。
 * 快捷键、右键菜单都由这张表生成，界面提示也从同一处取键名——改键不会再漏改提示。
 */
const FORMAT_ACTIONS: Array<{ name: string; key: (typeof FORMAT_KEYS)[keyof typeof FORMAT_KEYS]; run: (v: EditorView) => void }> = [
  { name: '加粗', key: FORMAT_KEYS.bold, run: (v) => applyMark(v, MARK_BOLD) },
  { name: '高亮', key: FORMAT_KEYS.highlight, run: (v) => applyMark(v, MARK_HIGHLIGHT) },
  { name: '斜体', key: FORMAT_KEYS.italic, run: (v) => applyMark(v, MARK_ITALIC) },
  { name: '插入双链', key: FORMAT_KEYS.wiki, run: (v) => applyWikiLink(v) },
];

/**
 * 写剪贴板：优先 Clipboard API；非安全上下文或未授权时退回临时 textarea + execCommand。
 * 自定义右键菜单接管了系统菜单，复制/剪切必须自己可靠地完成。
 */
async function copyText(text: string): Promise<boolean> {
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

/** 读剪贴板：只有 Clipboard API 一条路，失败返回 null 由调用方提示（按 Ctrl+V 仍可粘贴） */
async function readClipboardText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    // 未授权 / 非安全上下文
  }
  return null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 所有可用笔记名，供 [[ 补全（M3） */
  linkNames?: string[];
  /** 点击 [[双链]] 时跳转到对应笔记（编辑器内点链直达） */
  onOpenLink?: (name: string) => void;
  /** 粘贴/拖入图片时保存附件（Blob 直接入库，不转 base64），返回 vault 路径（M1 图片支持） */
  onAttach?: (filename: string, blob: Blob) => Promise<string>;
  /** 「草稿」按钮：把选中文本交给智能草稿 */
  onDraft?: (text: string) => void;
  /** vault 相对路径 → 文件内容，用于实时预览内联渲染图片 */
  readFile?: (path: string) => string | undefined;
}

export default function Editor({ value, onChange, linkNames = [], onOpenLink, onAttach, onDraft, readFile }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const namesRef = useRef(linkNames);
  /** 预转小写的补全源：只在 linkNames 变化时重算，避免每个按键对全库名字重复 toLowerCase */
  const lowerNamesRef = useRef<string[] | null>(null);
  const attachRef = useRef(onAttach);
  const openLinkRef = useRef(onOpenLink);
  const readFileRef = useRef(readFile);
  /** 右键菜单位置（视口坐标）；null = 关闭。CM 的事件处理器只建一次，用 ref 改状态 */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuAtRef = useRef(setMenuAt);
  /** 简易表格面板：点格子选行列，或把选中的多行文字一键转成表格 */
  const [tableOpen, setTableOpen] = useState(false);
  /** 面板打开时用到的选区文本：由 updateListener 同步，渲染期不再直接读 viewRef（保持渲染纯净） */
  const [selText, setSelText] = useState('');
  const tableOpenRef = useRef(false);
  /** 菜单根节点：打开后量尺寸做视口夹紧（锚到触发按钮，不再依赖工具栏硬编码高度） */
  const tableMenuRef = useRef<HTMLDivElement>(null);
  /** 行列提示直接改 DOM 文本，不走 React 状态：悬停不必触发重渲染 */
  const tableHeadRef = useRef<HTMLDivElement>(null);
  /** 菜单根节点：打开后要量尺寸做视口夹紧，键盘唤出时还要把焦点放进去 */
  const menuRef = useRef<HTMLDivElement>(null);
  /** 是否键盘唤出的菜单（Shift+F10 / 菜单键）：鼠标右键不该抢走编辑器焦点 */
  const menuFocusRef = useRef(false);
  /** 程序化同步内容时置 true：dispatch 是同步的，可拦住 updateListener 的回声 onChange */
  const applyingRef = useRef(false);
  onChangeRef.current = onChange;
  if (namesRef.current !== linkNames || lowerNamesRef.current === null) {
    namesRef.current = linkNames;
    lowerNamesRef.current = linkNames.map((n) => n.toLowerCase());
  }
  attachRef.current = onAttach;
  openLinkRef.current = onOpenLink;
  readFileRef.current = readFile;
  menuAtRef.current = setMenuAt;
  tableOpenRef.current = tableOpen;

  // 图片 → Blob 直接入库（不转 base64，避免内存膨胀）→ 插入 markdown 引用
  const insertImage = async (file: File) => {
    if (!file.type.startsWith('image/')) return false;
    const ext = file.type.split('/')[1] || 'png';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const path = (await attachRef.current?.(name, file)) ?? '';
    const view = viewRef.current;
    if (view && path) {
      view.dispatch(
        view.state.replaceSelection(`![](${path})`)
      );
    }
    return true;
  };

  // [[双链补全源：光标前是 [[xxx 时触发
  const wikiLinkSource = (ctx: CompletionContext) => {
    const before = ctx.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    const typed = before.text.slice(2).toLowerCase();
    const all = namesRef.current;
    const lowered = lowerNamesRef.current ?? [];
    const options: Array<{ label: string; type: string }> = [];
    for (let i = 0; i < all.length && options.length < 12; i++) {
      if (!typed || lowered[i].includes(typed)) options.push({ label: all[i], type: 'wiki' });
    }
    if (options.length === 0 && typed) return null;
    return {
      from: before.from + 2,
      options,
      validFor: /^[^\]\n]*$/,
    };
  };

  // 初始化一次
  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([
            // 撤销/重做无条件消费按键。CM 的 undo() 在撤销栈为空时返回 false，按键就没人拦，
            // 浏览器会对 contenteditable 跑原生撤销：把 DOM 退回挂载时的空内容，CM 再把这次
            // DOM 变化当成用户输入吃进文档——于是「刚打开笔记按一次 Ctrl+Z」整篇清空并被自动保存。
            {
              key: 'Mod-z',
              run: (v) => { undo(v); return true; },
            },
            {
              key: 'Mod-y',
              run: (v) => { redo(v); return true; },
            },
            {
              key: 'Mod-Shift-z',
              run: (v) => { redo(v); return true; },
            },
            // 行内格式快捷键：Alt+字母不与上面的撤销/重做冲突，也必须排在
            // defaultKeymap、searchKeymap 之前，否则会被它们的同键绑定覆盖。
            // 键位定义见 core/mdFormat.ts（工具栏提示与右键菜单同源）。
            ...FORMAT_ACTIONS.map((a) => ({
              key: a.key.cm,
              mac: a.key.cmMac,
              run: (v: EditorView) => { a.run(v); return true; },
            })),
            // 旧版行内格式键位（Ctrl/⌘+B 加粗、+I 斜体、+H 高亮）已废弃，改到 Alt 系（见 core/mdFormat.ts）。
            // 它们由 Workspace 里的应用级守卫统一消费——焦点在哪都拦得住，不必在这里再绑一遍。
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          closeBrackets(),
          highlightSelectionMatches(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          autocompletion({ override: [wikiLinkSource] }),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview(() => readFileRef.current),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            // 原生撤销/重做事件同样要拦（键盘之外还有菜单等入口），否则它会绕过 CM 的撤销栈
            beforeinput: (e) => {
              if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
                e.preventDefault();
                return true;
              }
              return false;
            },
            click: (e) => {
              const view = viewRef.current;
              if (!view) return false;
              const target = e.target as HTMLElement;
              // 标准链接（实时预览部件）→ 开新窗口
              const linkEl = target.closest?.('.lp-link') as HTMLElement | null;
              if (linkEl) {
                const url = linkEl.getAttribute('data-lp-url');
                if (url) { e.preventDefault(); window.open(url, '_blank', 'noopener'); return true; }
              }
              // [[双链]]（实时预览部件）→ 跳转笔记
              const fn = openLinkRef.current;
              const wikiEl = target.closest?.('.lp-wiki') as HTMLElement | null;
              if (wikiEl && fn) {
                const name = wikiEl.getAttribute('data-lp-target');
                if (name) { e.preventDefault(); fn(name); return true; }
              }
              // 源码模式兜底：用 posAtCoords 识别光标点中的 [[x]] / [x](url)
              if (!fn) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos == null) return false;
              const line = view.state.doc.lineAt(pos);
              const col = pos - line.from;
              const wikiRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
              let m: RegExpExecArray | null;
              while ((m = wikiRe.exec(line.text))) {
                if (col >= m.index && col <= m.index + m[0].length) {
                  e.preventDefault();
                  fn((m[2] ?? m[1]).trim());
                  return true;
                }
              }
              const linkRe = /(?<!!)\[([^\]\n]+?)\]\(([^)]+)\)/g;
              while ((m = linkRe.exec(line.text))) {
                if (col >= m.index && col <= m.index + m[0].length) {
                  e.preventDefault();
                  window.open(m[2], '_blank', 'noopener');
                  return true;
                }
              }
              return false;
            },
            // 选中文字后右键 → 打开格式菜单（没有选区时交回系统菜单）
            contextmenu: (e) => {
              const view = viewRef.current;
              if (!view || view.state.selection.main.empty) return false;
              e.preventDefault();
              // 只用键盘唤出（Shift+F10 / 菜单键）时把焦点移进菜单。实测鼠标右键的 contextmenu
              // 事件 detail 也是 0，唯一可靠的区分是 button：右键为 2，键盘触发为 -1/0。
              // macOS 的 Ctrl+点击是鼠标手势（button 0 + ctrlKey），同样不该抢焦点。
              menuFocusRef.current = e.button !== 2 && !e.ctrlKey;
              menuAtRef.current({ x: e.clientX, y: e.clientY });
              return true;
            },
            paste: (e) => {
              const items = e.clipboardData?.items;
              if (!items) return false;
              for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                  const f = item.getAsFile();
                  if (f) {
                    e.preventDefault();
                    void insertImage(f);
                    return true;
                  }
                }
              }
              return false;
            },
            drop: (e) => {
              const files = e.dataTransfer?.files;
              if (!files?.length) return false;
              const images = [...files].filter((f) => f.type.startsWith('image/'));
              if (images.length === 0) return false; // 非图片文件不拦截（如拖入文本）
              e.preventDefault();
              for (const f of images) void insertImage(f);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingRef.current) onChangeRef.current(u.state.doc.toString());
            // 表格面板打开时同步选区，供「转成表格」入口使用：渲染期不再直接读 viewRef，
            // 面板打开后选区变化也能即时刷新（旧写法读的是上一次渲染时的旧选区）。
            if (u.selectionSet && tableOpenRef.current) {
              const s = u.state.selection.main;
              const text = s.empty ? '' : u.state.sliceDoc(s.from, s.to);
              setSelText((prev) => (prev === text ? prev : text));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部切换笔记时同步内容（程序化替换不回写 onChange，避免误标 dirty）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value !== cur) {
      applyingRef.current = true;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        // 装载笔记这一步不进撤销栈：否则刚打开一篇笔记按 Ctrl+Z 会把整篇撤成空白
        // （切换笔记时撤销还会把上一篇的内容贴进这一篇），自动保存随后就把空白存下去。
        annotations: Transaction.addToHistory.of(false),
      });
      applyingRef.current = false;
    }
  }, [value]);

  const [liveOn, setLiveOn] = useState(true);
  const draftRef = useRef(onDraft);
  draftRef.current = onDraft;

  /** 关闭菜单。refocus=true 时把焦点还给编辑器（Esc、选中某一项之后），点别处则不动焦点 */
  const closeMenu = (refocus = false) => {
    setMenuAt(null);
    if (refocus) viewRef.current?.focus();
  };

  // 菜单打开后：夹进视口（贴着窗口底边右键时整块菜单会跑到屏幕外），
  // 键盘唤出时把焦点放进第一项（Shift+F10 能打开却按不到任何一项）。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const dx = r.right > innerWidth - pad ? innerWidth - pad - r.right : r.left < pad ? pad - r.left : 0;
    const dy = r.bottom > innerHeight - pad ? innerHeight - pad - r.bottom : r.top < pad ? pad - r.top : 0;
    if (dx || dy) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    if (menuFocusRef.current) el.querySelector<HTMLButtonElement>('.cm-ctx-item')?.focus();
  }, [menuAt]);

  /** ↑↓ / Home / End 在菜单项之间移动焦点；没有焦点时从第一项（或最后一项）开始 */
  const moveMenuFocus = (delta: 1 | -1 | 'home' | 'end') => {
    const el = menuRef.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLButtonElement>('.cm-ctx-item')];
    if (items.length === 0) return;
    if (delta === 'home') return items[0].focus();
    if (delta === 'end') return items[items.length - 1].focus();
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = cur < 0 ? (delta > 0 ? 0 : items.length - 1) : (cur + delta + items.length) % items.length;
    items[next].focus();
  };

  // 右键菜单：点别处 / Esc / 改窗口大小即关闭。菜单里按方向键不关（那是菜单自己的导航）
  useEffect(() => {
    if (!menuAt) return;
    const onPointer = () => setMenuAt(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeMenu(true);
      // 焦点不在菜单里（鼠标唤出，焦点还在编辑器）：任何按键都关掉菜单，不挡打字
      if (!menuRef.current?.contains(e.target as Node)) return setMenuAt(null);
      // 焦点在菜单里（键盘唤出）：方向键/回车/Tab 留给菜单，其它按键关菜单并把焦点还给
      // 编辑器，否则字母会被聚焦的按钮吞掉、菜单还赖着不走、接下来的输入也落不到正文
      const MENU_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab', 'Enter', ' '];
      if (!MENU_KEYS.includes(e.key)) closeMenu(true);
    };
    const onBlur = () => setMenuAt(null);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [menuAt]);

  // ---------- 格式工具栏：让新手点按钮完成语法操作（鼠标按下不抢编辑器焦点） ----------
  const withView = (fn: (v: EditorView) => void) => () => {
    const v = viewRef.current;
    if (v) fn(v);
  };

  /** 表格面板：点外部或 Esc 关闭（与右键菜单同一套交互约定） */
  useEffect(() => {
    if (!tableOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('.cm-table-menu') || t.closest?.('[data-table-btn]')) return;
      setTableOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTableOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tableOpen]);

  // 表格菜单：打开后夹进视口（按钮靠右时菜单会溢出到屏幕外），与右键菜单同一套处理
  useLayoutEffect(() => {
    const el = tableMenuRef.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const dx = r.right > innerWidth - pad ? innerWidth - pad - r.right : r.left < pad ? pad - r.left : 0;
    const dy = r.bottom > innerHeight - pad ? innerHeight - pad - r.bottom : r.top < pad ? pad - r.top : 0;
    if (dx || dy) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
  }, [tableOpen]);

  /** 插一张空白表格：光标处另起一段，光标选中表头第一格 */
  const insertEmptyTable = (rows: number, cols: number) => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = selBounds(v);
    v.dispatch(insertTable(v.state.doc.toString(), from, to, tableSkeleton(rows, cols)));
    setTableOpen(false);
    if (tableHeadRef.current) tableHeadRef.current.textContent = '拖选行列';
    v.focus();
  };

  /** 把选中的多行文字按分隔符转成表格 */
  const convertSelectionToTable = () => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = selBounds(v);
    const table = textToTable(v.state.sliceDoc(from, to));
    if (!table) return;
    v.dispatch(insertTable(v.state.doc.toString(), from, to, table));
    setTableOpen(false);
    v.focus();
  };

  const toolbarActions: Array<{ label: ReactNode; title: string; run: (v: EditorView) => void }> = [
    { label: '↺', title: '撤销（Ctrl/⌘+Z）', run: (v) => undo(v) },
    { label: '↻', title: '重做（Ctrl/⌘+Shift+Z 或 Ctrl+Y）', run: (v) => redo(v) },
    {
      label: <b>B</b>, title: `加粗（${FORMAT_KEYS.bold.labelMac}，再按一次取消）`,
      run: (v) => applyMark(v, MARK_BOLD),
    },
    {
      label: '==', title: `高亮（${FORMAT_KEYS.highlight.labelMac}，再按一次取消）`,
      run: (v) => applyMark(v, MARK_HIGHLIGHT),
    },
    {
      label: <i>I</i>, title: `斜体（${FORMAT_KEYS.italic.labelMac}，再按一次取消）`,
      run: (v) => applyMark(v, MARK_ITALIC),
    },
    {
      label: '•', title: '本行变为条目（- 开头，再点一次取消）',
      run: (v) => {
        const line = v.state.doc.lineAt(v.state.selection.main.head);
        const next = line.text.startsWith('- ') ? line.text.slice(2) : '- ' + line.text;
        v.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
      },
    },
    { label: '⇥', title: '缩进一层（Tab）', run: (v) => indentMore(v) },
    { label: '⇤', title: '反缩进（Shift+Tab）', run: (v) => indentLess(v) },
    {
      label: '[[', title: `插入双链（${FORMAT_KEYS.wiki.labelMac}），接着输入笔记名可自动补全`,
      run: (v) => applyWikiLink(v),
    },
    {
      label: '诀', title: '插入口诀行',
      run: (v) => v.dispatch(v.state.replaceSelection('\n- 口诀: ')),
    },
    {
      label: '草稿', title: '把选中文本整理成原子笔记草稿（未选中则用全文）',
      run: (v) => {
        const sel = v.state.selection.main;
        const text = sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
        draftRef.current?.(text);
      },
    },
  ];

  /** 选中文字后的右键菜单：格式一栏（另一种施加方式是快捷键），都不需要手打标记符 */
  const CTX_ACTIONS: Array<{ label: string; keys: string; run: (v: EditorView) => void }> =
    FORMAT_ACTIONS.map((a) => ({ label: a.name, keys: a.key.label, run: a.run }));

  /** 接管了系统右键菜单，就得把它最常用的三项补回来，否则选中文字后点不到复制/粘贴 */
  const CTX_EDIT: Array<{ label: string; keys: string; run: (v: EditorView) => void }> = [
    {
      label: '复制', keys: 'Ctrl+C',
      run: (v) => {
        const { from, to } = selBounds(v);
        void copyText(v.state.sliceDoc(from, to)).then((ok) => {
          if (!ok) toast('复制失败：浏览器没有授权剪贴板', 'err');
        });
      },
    },
    {
      label: '剪切', keys: 'Ctrl+X',
      run: (v) => {
        const { from, to } = selBounds(v);
        void copyText(v.state.sliceDoc(from, to)).then((ok) => {
          if (ok) v.dispatch({ changes: { from, to, insert: '' } });
          else toast('剪切失败：浏览器没有授权剪贴板', 'err');
        });
      },
    },
    {
      label: '粘贴', keys: 'Ctrl+V',
      run: (v) => {
        void readClipboardText().then((text) => {
          if (text) v.dispatch(v.state.replaceSelection(text));
          else toast('读不到剪贴板，直接按 Ctrl+V 即可粘贴', 'info');
        });
      },
    },
  ];

  const selLines = selText ? selText.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  /** 面板打开且选区能拆成表格时，给出「转成表格」入口 */
  const convertible = tableOpen && selLines >= 2 ? textToTable(selText) : null;

  return (
    <div className="editor-wrap">
      <div className="cm-toolbar">
        {toolbarActions.map((a, i) => (
          <button
            key={i}
            className="cm-tool-btn"
            data-tip={a.title}
            aria-label={a.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={withView(a.run)}
          >
            {a.label}
          </button>
        ))}
        <span className="cm-table-anchor">
          <button
            className={`cm-tool-btn ${tableOpen ? 'on' : ''}`}
            data-table-btn="1"
            data-tip="插入表格：点格子选行列；选中多行文字可一键转成表格"
            aria-label="插入表格"
            aria-expanded={tableOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!tableOpen) {
                const v = viewRef.current;
                const s = v?.state.selection.main;
                setSelText(s && !s.empty && v ? v.state.sliceDoc(s.from, s.to) : '');
              }
              setTableOpen((o) => !o);
            }}
          >
            ▦
          </button>
          {tableOpen && (
            <div className="cm-table-menu" ref={tableMenuRef} role="dialog" aria-label="插入表格">
              <div className="cm-table-head" ref={tableHeadRef}>拖选行列</div>
              <div className="cm-table-grid" onMouseLeave={() => { if (tableHeadRef.current) tableHeadRef.current.textContent = '拖选行列'; }}>
                {Array.from({ length: TABLE_MAX_ROWS }, (_, r) => (
                  <div className="cm-table-row" key={r}>
                    {Array.from({ length: TABLE_MAX_COLS }, (_, c) => (
                      <button
                        key={c}
                        type="button"
                        className="cm-table-cell"
                        aria-label={`${r + 1} 行 ${c + 1} 列`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => { if (tableHeadRef.current) tableHeadRef.current.textContent = `${r + 1} × ${c + 1} 表格`; }}
                        onFocus={() => { if (tableHeadRef.current) tableHeadRef.current.textContent = `${r + 1} × ${c + 1} 表格`; }}
                        onClick={() => insertEmptyTable(r + 1, c + 1)}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {convertible && (
                <button
                  type="button"
                  className="cm-table-convert"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={convertSelectionToTable}
                >
                  把选中的 {selLines} 行转成表格
                </button>
              )}
              <div className="cm-table-hint muted">点格子插入表格；选中多行文字可一键转表格</div>
            </div>
          )}
        </span>
        <button
          className={`cm-tool-btn ${liveOn ? 'on' : ''}`}
          data-tip="实时预览：光标所在行显示源码，其余行显示排版效果（关闭则全部显示源码）"
          aria-label="实时预览开关"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setLiveOn(!liveOn);
            const v = viewRef.current;
            if (v) toggleLivePreview(v);
          }}
        >
          <IconEye />
        </button>
        <span className="cm-toolbar-hint muted">选中文字后右键，或按 {FORMAT_ACTIONS.map((a) => `${a.key.labelMac} ${a.name}`).join(' / ')}（标记符不会显示在正文里）</span>
      </div>
      <div className="editor-host" ref={hostRef} />
      {menuAt && (
        <div
          className="cm-ctx-menu"
          ref={menuRef}
          style={{ left: menuAt.x, top: menuAt.y }}
          role="menu"
          aria-label="选中文字的格式与编辑"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); moveMenuFocus(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); moveMenuFocus(-1); }
            else if (e.key === 'Home') { e.preventDefault(); moveMenuFocus('home'); }
            else if (e.key === 'End') { e.preventDefault(); moveMenuFocus('end'); }
          }}
        >
          {CTX_ACTIONS.map((a) => (
            <button
              key={a.label}
              className="cm-ctx-item"
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { withView(a.run)(); closeMenu(true); }}
            >
              <span>{a.label}</span>
              <kbd>{a.keys}</kbd>
            </button>
          ))}
          <div className="cm-ctx-sep" role="separator" />
          {CTX_EDIT.map((a) => (
            <button
              key={a.label}
              className="cm-ctx-item"
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { withView(a.run)(); closeMenu(true); }}
            >
              <span>{a.label}</span>
              <kbd>{a.keys}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
