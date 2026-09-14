/**
 * 智能草稿：粘贴/选中讲义文本 → 一键生成原子笔记骨架 → 人工审核 → 入库。
 * 纯前端规则引擎（core/noteGen），零成本离线可用。
 */
import { useRef, useState } from 'react';
import { generateDraft, draftToMarkdown, type Draft } from '../core/noteGen';
import { loadPdfjs } from '../core/pdfLib';
import { IconWand } from './icons';
import { toast } from '../core/feedback';

interface Props {
  /** 预填文本（来自编辑器选中内容） */
  initialText?: string;
  /** 入库：保存完整 md 笔记，返回路径 */
  onSave: (dir: string, title: string, content: string) => Promise<string>;
  onClose: () => void;
}

export default function DraftGen({ initialText = '', onSave, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [chapter, setChapter] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const pdfRef = useRef<HTMLInputElement>(null);

  /** PDF → 纯文本（pdf.js 懒加载，只有导入时才下载该 chunk） */
  const importPdf = async (file: File) => {
    setBusy(true);
    try {
      const pdfjs = await loadPdfjs();
      const buf = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      let txt = '';
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        txt += tc.items.map((it: { str?: string }) => (it.str ?? '')).join(' ') + '\n';
        if (txt.length > 40000) break; // 过长只取前 40k 字符，防止卡顿
      }
      if (!txt.trim()) throw new Error('未提取到文字（可能是扫描版 PDF，需 OCR）');
      setText(txt);
      toast(`已提取 ${doc.numPages} 页文字，共 ${txt.length} 字，可点「生成草稿」`, 'ok');
    } catch (e) {
      toast(`PDF 导入失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const gen = () => {
    try {
      setDraft(generateDraft(text, { chapter, tags }));
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  // 编辑草稿字段
  const up = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const content = draftToMarkdown(draft);
      const dir = draft.chapter.trim();
      const path = await onSave(dir, draft.title.trim(), content);
      toast(`已入库：${path}`, 'ok');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="quiz-panel draft-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">智能草稿 · 讲义转原子笔记</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        {!draft ? (
          // ---------- 输入阶段 ----------
          <div className="draft-input">
            <p className="muted">粘贴讲义/教材段落，或导入 PDF（自动提取文字），再一键生成原子笔记骨架</p>
            <div className="draft-import">
              <button className="btn-small" disabled={busy} onClick={() => pdfRef.current?.click()}>
                {busy ? '提取中…' : '导入 PDF 讲义'}
              </button>
              <input
                ref={pdfRef}
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importPdf(f);
                  e.target.value = '';
                }}
              />
              <span className="muted">扫描版 PDF 需先 OCR；提取后仍可手动改</span>
            </div>
            <textarea
              className="quiz-paste"
              rows={8}
              placeholder="或直接粘贴：氧解离曲线是指血红蛋白氧饱和度与血氧分压的关系曲线，呈S形。其上段平坦反映氧储备，下段陡峭提示组织供氧。影响因素包括pH、CO2、温度与2,3-DPG……"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="draft-row">
              <input placeholder="章节（可选，如 生理学/呼吸）" value={chapter} onChange={(e) => setChapter(e.target.value)} />
              <input placeholder="标签（可选，逗号分隔）" value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
            <div className="quiz-actions">
              <button className="btn-primary draft-gen" disabled={!text.trim()} onClick={gen}>
                <IconWand /> 生成草稿
              </button>
              <button className="btn-small" onClick={onClose}>取消</button>
            </div>
          </div>
        ) : (
          // ---------- 审核阶段 ----------
          <div className="draft-review">
            <div className="draft-row">
              <label>标题</label>
              <input value={draft.title} onChange={(e) => up({ title: e.target.value })} />
            </div>
            <div className="draft-row">
              <label>目录/章节</label>
              <input value={draft.chapter} onChange={(e) => up({ chapter: e.target.value })} placeholder="保存目录，如 病理学/呼吸" />
            </div>
            <div className="draft-row">
              <label>来源</label>
              <input value={draft.source} onChange={(e) => up({ source: e.target.value })} />
            </div>
            <textarea
              className="quiz-paste draft-body"
              rows={11}
              value={draft.body}
              onChange={(e) => up({ body: e.target.value })}
            />
            <div className="quiz-actions">
              <button className="btn-primary draft-gen" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '入库为笔记'}
              </button>
              <button className="btn-small" onClick={() => setDraft(null)}>返回修改</button>
              <button className="btn-small" onClick={onClose}>取消</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
