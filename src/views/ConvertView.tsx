/**
 * 格式转换：PDF / Word(.docx) → Markdown（纯前端离线，core/convert）。
 * 面板模式与 DraftGen 一致：转换 → 预览/编辑 → 复制 / 下载 / 入库为笔记。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import MarkdownIt from 'markdown-it';
import { ATTACH_DIR, docxToMarkdown, pdfToMarkdown, type ConvertedImage, type ConvertResult } from '../core/convert';
import { anydocErrorCode, anydocToMarkdown } from '../core/anydoc';
import { ocrPdfToMarkdown } from '../core/ocr';
import { netErrorHint } from '../core/netError';
import { stripPageAnchors } from '../core/pageAnchor';
import { toast } from '../core/feedback';
import { IconConvert, IconClose } from './icons';
import Loading from './Loading';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

interface Props {
  /** 入库：保存完整 md 笔记，返回路径 */
  onSave: (dir: string, title: string, content: string) => Promise<string>;
  /** 落库内嵌图片（与 Editor 贴图同一个入口），返回 vault 相对路径。
   *  故意设成必填：留成可选就等于允许「图片静默丢失」那条老路重新出现。 */
  onAttach: (filename: string, blob: Blob) => Promise<string>;
  onClose: () => void;
}

export default function ConvertView({ onSave, onAttach, onClose }: Props) {
  // Esc 关闭；焦点在可编辑的转换结果里时先退出输入框，再按一次才关——避免未入库的结果丢掉
  useEsc(escThenClose(onClose));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [dir, setDir] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [engine, setEngine] = useState<'anydoc' | 'builtin' | 'ocr'>('anydoc');
  const [usedEngine, setUsedEngine] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  /** docx 抽出的内嵌图片（尚未落库）：正文里已写成 _attachments/<filename> */
  const [images, setImages] = useState<ConvertedImage[]>([]);
  /** 预览用的 blob URL：这些图还没落库，vault 解析不到，直接渲染会得到一排碎图。
   *  在 useMemo 里建（渲染期派生）而不是 effect + setState：后者要多一轮渲染，
   *  也会踩 react(set-state-in-effect)。回收单独放 effect —— 只 revoke、不 setState。 */
  const imageUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const img of images) urls.set(img.filename, URL.createObjectURL(img.blob));
    return urls;
  }, [images]);
  useEffect(() => () => { for (const u of imageUrls.values()) URL.revokeObjectURL(u); }, [imageUrls]);

  /** 预览正文：把 _attachments/<name> 换成本次转换内存里的 blob URL */
  const previewMarkdown = useMemo(() => {
    if (!images.length) return markdown;
    return markdown.replace(/\]\((_attachments\/[^)\s]+)\)/g, (whole, p: string) => {
      const url = imageUrls.get(p.slice(ATTACH_DIR.length));
      return url ? `](${url})` : whole;
    });
  }, [markdown, images, imageUrls]);

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
      if (engine === 'ocr') {
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          throw new Error('OCR 只用于 PDF 扫描件；Word 文档请用 anydoc 或内置引擎');
        }
        r = await ocrPdfToMarkdown(file, (p) => setProgress(`${file.name} · ${p.label}`));
      } else if (engine === 'anydoc') {
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
      setImages(r.images ?? []);
      setTitle(r.title);
      setUsedEngine(r.engine ?? 'builtin');
      setElapsed(performance.now() - started);
      if (r.warning) toast(r.warning, 'info', 6000);
    } catch (e) {
      const msg = (e as Error).message;
      // 扫描件是预期内的失败：直接把下一步怎么做说清楚，而不是只丢一句报错
      toast(
        engine !== 'ocr' && /OCR/i.test(msg)
          ? `${msg}。把上方「引擎」切换成「OCR 扫描件」再试一次即可。`
          : `转换失败：${msg}`,
        'err',
        10000,
      );
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
      // 附件必须先落库、再写笔记：笔记一旦写下去就引用了这些路径，
      // 顺序反了会留下「笔记在、图不在」的碎图状态（正是原来图片全丢的表现）。
      let attached = 0;
      const failed: string[] = [];
      for (const img of images) {
        try {
          await onAttach(img.filename, img.blob);
          attached += 1;
        } catch {
          failed.push(img.filename);
        }
      }
      const path = await onSave(dir.trim(), t, markdown);
      if (failed.length) {
        toast(`已入库：${path}；但有 ${failed.length} 张图片写入失败，正文对应位置会显示为空缺，可再点一次「存为笔记」重试`, 'err', 9000);
      } else if (attached) {
        toast(`已入库：${path}（含 ${attached} 张图片）`, 'ok', 4200);
      } else {
        toast(`已入库：${path}`, 'ok');
      }
      onClose();
    } catch (e) {
      toast(netErrorHint(e), 'err');
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="quiz-panel convert-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">格式转换 · PDF / Word → Markdown</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
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
                <Loading label={progress || '转换中…'} compact />
              ) : (
                <>
                  <b>点击选择，或把文件拖到这里</b>
                  <span className="muted">支持 .pdf 与 .docx，全程本地处理，不上传任何数据</span>
                  <span className="muted">PDF 依据文字层重建标题 / 段落 / 列表；扫描版请把引擎切到「OCR 扫描件」</span>
                </>
              )}
            </div>
            <div className="convert-engine">
              <span className="muted">引擎</span>
              <select value={engine} onChange={(e) => setEngine(e.target.value as 'anydoc' | 'builtin' | 'ocr')}>
                <option value="anydoc">anydoc (WASM - 本地)</option>
                <option value="builtin">内置启发式</option>
                <option value="ocr">OCR 扫描件 (本地识别)</option>
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
              {/* 图片数必须当场显示：原来图片是在转换过程中被静默丢掉的，
                  用户只能等打开笔记才发现。 */}
              {images.length > 0 && <span className="muted">{images.length} 张图片</span>}
              <span className="muted">{usedEngine}{elapsed > 0 ? ' - ' + (elapsed / 1000).toFixed(2) + 's' : ''}</span>
              <span className="spacer" />
              <button className="btn-small" onClick={() => { setResult(null); setMarkdown(''); setImages([]); }}>
                换个文件
              </button>
            </div>
            <div className="convert-tabs">
              <button className={`btn-small${showPreview ? '' : ' active'}`} onClick={() => setShowPreview(false)}>Markdown</button>
              <button className={`btn-small${showPreview ? ' active' : ''}`} onClick={() => setShowPreview(true)}>预览</button>
            </div>
            {showPreview ? (
              <div className="convert-preview-scroll">
                <div className="preview" dangerouslySetInnerHTML={{ __html: md.render(stripPageAnchors(previewMarkdown)) }} />
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
