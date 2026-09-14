/**
 * 编辑器（M1+M3）：CodeMirror 6 + Markdown + [[双链自动补全。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, undo, redo } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { livePreview, toggleLivePreview } from '../core/livePreview';
import { IconEye } from './icons';

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
      });
      applyingRef.current = false;
    }
  }, [value]);

  const [liveOn, setLiveOn] = useState(true);
  const draftRef = useRef(onDraft);
  draftRef.current = onDraft;

  // ---------- 格式工具栏：让新手点按钮完成语法操作（鼠标按下不抢编辑器焦点） ----------
  const withView = (fn: (v: EditorView) => void) => () => {
    const v = viewRef.current;
    if (v) fn(v);
  };
  const toolbarActions: Array<{ label: ReactNode; title: string; run: (v: EditorView) => void }> = [
    { label: '↺', title: '撤销（Ctrl/⌘+Z）', run: (v) => undo(v) },
    { label: '↻', title: '重做（Ctrl/⌘+Shift+Z 或 Ctrl+Y）', run: (v) => redo(v) },
    {
      label: <b>B</b>, title: '加粗（选中后点击，或手动 **文字**）',
      run: (v) => {
        const { from, to, empty } = v.state.selection.main;
        const text = empty ? '加粗内容' : v.state.sliceDoc(from, to);
        v.dispatch(v.state.replaceSelection(`**${text}**`));
      },
    },
    {
      label: '==', title: '高亮（选中后点击，或手动 ==文字==）',
      run: (v) => {
        const { from, to, empty } = v.state.selection.main;
        const text = empty ? '高亮内容' : v.state.sliceDoc(from, to);
        v.dispatch(v.state.replaceSelection(`==${text}==`));
      },
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
      label: '[[', title: '插入双链，接着输入笔记名可自动补全',
      run: (v) => {
        v.dispatch(v.state.replaceSelection('[[]]'));
        const pos = v.state.selection.main.head - 2; // 光标落在 [[ 和 ]] 之间
        v.dispatch({ selection: { anchor: pos } });
      },
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
        <span className="cm-toolbar-hint muted">Ctrl+Z 撤销 · Ctrl+Y 重做 · Tab 缩进 · [[ 双链 · **加粗** · ==高亮== · Ctrl+S 保存</span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
