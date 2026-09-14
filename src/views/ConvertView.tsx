/**
 * 格式转换：PDF / Word(.docx) → Markdown（纯前端离线，core/convert）。
 * 面板模式与 DraftGen 一致：转换 → 预览/编辑 → 复制 / 下载 / 入库为笔记。
 */
import { useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { docxToMarkdown, pdfToMarkdown, type ConvertResult } from '../core/convert';
import { anydocErrorCode, anydocToMarkdown } from '../core/anydoc';
import { toast } from '../core/feedback';
import { IconConvert } from './icons';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

interface Props {
  /** 入库：保存完整 md 笔记，返回路径 */
  onSave: (dir: string, title: string, content: string) => Promise<string>;
  onClose: () => void;
}

export default function ConvertView({ onSave, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [dir, setDir] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [engine, setEngine] = useState<'anydoc' | 'builtin'>('anydoc');
  const [usedEngine, setUsedEngine] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  const convert = async (file: File) => {
    if (busy) return;
    const ok = /\.(pdf|docx?|DOCX?)$/.test(file.name);
    if (!ok) {
      toast('仅支持 PDF 和 Word（.docx / .doc）文件', 'err');
      return;
    }
    setBusy(true);
    setResult(null);
    setProgress(file.name);
    const started = performance.now();
    try {
      const runBuiltin = async () => file.name.toLowerCase().endsWith('.pdf')
        ? await pdfToMarkdown(file, (done, total) => setProgress(`${file.name} · 第 ${done}/${total} 页`))
        : await docxToMarkdown(file);

      let r: ConvertResult;
      if (engine === 'anydoc') {
        try {
          r = await anydocToMarkdown(file);
        } catch (err) {
          if (anydocErrorCode(err) === null) throw err;
          // anydoc refuses scanned / unsupported files: fall back to the old engine.
          r = await runBuiltin();
        }
      } else {
        r = await runBuiltin();
      }
      setResult(r);
      setMarkdown(r.markdown);
      setTitle(r.title);
      setUsedEngine(r.engine ?? 'builtin');
      setElapsed(performance.now() - started);
      if (r.warning) toast(r.warning, 'info', 6000);
    } catch (e) {
      toast(`转换失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast('已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败，请手动全选复制', 'err');
    }
  };

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title || 'converted'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const save = async () => {
    if (savingRef.current) return;
    const t = title.trim() || result?.title || '未命名';
    savingRef.current = true;
    try {
      const path = await onSave(dir.trim(), t, markdown);
      toast(`已入库：${path}`, 'ok');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="quiz-panel convert-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">格式转换 · PDF / Word → Markdown</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        {!result ? (
          <div className="convert-input">
            <div
              className={`convert-drop${dragOver ? ' over' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="选择或拖入 PDF / Word 文件"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void convert(f);
              }}
            >
              <IconConvert size={30} />
              {busy ? (
                <b>{progress || '转换中…'}</b>
              ) : (
                <>
                  <b>点击选择，或把文件拖到这里</b>
                  <span className="muted">支持 .pdf 与 .docx，全程本地处理，不上传任何数据</span>
                  <span className="muted">PDF 依据文字层重建标题 / 段落 / 列表；扫描版需先 OCR</span>
                </>
              )}
            </div>
            <div className="convert-engine">
              <span className="muted">引擎</span>
              <select value={engine} onChange={(e) => setEngine(e.target.value as 'anydoc' | 'builtin')}>
                <option value="anydoc">anydoc (WASM - 本地)</option>
                <option value="builtin">内置启发式</option>
              </select>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void convert(f);
                e.target.value = '';
              }}
            />
          </div>
        ) : (
          <div className="convert-result">
            <div className="convert-meta">
              <span className="convert-file">{result.title}</span>
              <span className="muted">{markdown.length} 字符</span>
              <span className="muted">{usedEngine}{elapsed > 0 ? ' - ' + (elapsed / 1000).toFixed(2) + 's' : ''}</span>
              <span className="spacer" />
              <button className="btn-small" onClick={() => { setResult(null); setMarkdown(''); }}>
                换个文件
              </button>
            </div>
            <div className="convert-tabs">
              <button className={`btn-small${showPreview ? '' : ' active'}`} onClick={() => setShowPreview(false)}>Markdown</button>
              <button className={`btn-small${showPreview ? ' active' : ''}`} onClick={() => setShowPreview(true)}>预览</button>
            </div>
            {showPreview ? (
              <div className="convert-preview-scroll">
                <div className="preview" dangerouslySetInnerHTML={{ __html: md.render(markdown) }} />
              </div>
            ) : (
              <textarea
                className="quiz-paste convert-md"
                spellCheck={false}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
              />
            )}
            <div className="convert-save">
              <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input placeholder="目录（可选，如 病理学/呼吸）" value={dir} onChange={(e) => setDir(e.target.value)} />
            </div>
            <div className="quiz-actions">
              <button className="btn-primary draft-gen" onClick={() => void save()}>
                <IconConvert /> 存为笔记
              </button>
              <button className="btn-small" onClick={() => void copy()}>复制</button>
              <button className="btn-small" onClick={download}>下载 .md</button>
              <button className="btn-small" onClick={onClose}>关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
