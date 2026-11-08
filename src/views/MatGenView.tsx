/**
 * 资料生成面板：素材导入 → AI 规划大纲 → 分节生成 → 汇总落盘。
 *
 * 复用既有能力：解析走 core/anydoc（anydoc wasm / mammoth / pdfjs），AI 走 core/aiAgent
 * 的 runAgent（与课程工坊同一条链路、同一份配置），落盘走 vault。素材原文只活在内存里
 * （轻松超 localStorage 配额），任务结构持久化在 core/matgen 的 KV store，断点续跑时
 * 只恢复大纲与已完成正文；素材原文需重新导入才能继续生成（界面会明确提示，不静默失败）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { escThenClose, useEsc } from './useEsc';
import MarkdownIt from 'markdown-it';
import { anydocErrorCode, anydocToMarkdown } from '../core/anydoc';
import { docxToMarkdown, pdfToMarkdown } from '../core/convert';
import { loadAgentSettings } from '../core/agentSettings';
import { isAbortError, runAgent } from '../core/aiAgent';
import {
  assembleMatNote,
  asMatStyle,
  buildPlanMessages,
  buildSectionMaterials,
  buildSectionMessages,
  loadMatJob,
  MAT_STYLES,
  MAT_STYLE_LIST,
  MAT_KINDS,
  newMatJob,
  parseOutline,
  parseReview,
  persistSections,
  buildReviewMessages,
  resetRunningSections,
  sectionDigest,
  safeMatTitle,
  saveMatJob,
  type MatJob,
  type MatKind,
  type MatSource,
  type MatSection,
  type MatStyle,
} from '../core/matgen';
import { toast } from '../core/feedback';
import { IconClose, IconConvert, IconFile } from './icons';
import Loading from './Loading';
import PanelOverlay from './PanelOverlay';
import { sanitizeRenderedHtml } from '../core/domSanitize';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** 兜底解析：anydoc 不认的（如扫描 PDF）走既有引擎；都失败就拒绝这份素材 */
async function parseFile(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt)$/.test(lower)) return await file.text();
  if (lower.endsWith('.pdf')) {
    try {
      return (await anydocToMarkdown(file)).markdown;
    } catch (e) {
      if (anydocErrorCode(e) === null) throw e;
      return (await pdfToMarkdown(file)).markdown;
    }
  }
  if (lower.endsWith('.docx')) {
    try {
      return (await anydocToMarkdown(file)).markdown;
    } catch (e) {
      if (anydocErrorCode(e) === null) throw e;
      return (await docxToMarkdown(file)).markdown;
    }
  }
  try {
    return (await anydocToMarkdown(file)).markdown;
  } catch (e) {
    if (anydocErrorCode(e) === null) throw e;
    throw new Error('无法解析该文件（扫描版 PDF 请先在「格式转换」里 OCR，再把结果 .md 拖进来）');
  }
}

/** 按扩展名/文件名猜素材种类；猜错可在列表里改 */
function guessKind(name: string): MatKind {
  const n = name.toLowerCase();
  if (/\.(pptx?|key)$/.test(n) || /ppt|幻灯|课件/.test(name)) return 'ppt';
  if (/考|真题|exam/i.test(n)) return '考题';
  if (/题库|习题|练习|quiz/i.test(n)) return '题库';
  if (/大纲|提纲|syllabus|outline/i.test(n)) return '大纲';
  if (/教材|课本|chapter|textbook/i.test(n)) return '教材';
  return '资料';
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Props {
  /** 保存完整 md 笔记，返回路径（Workspace 转发 vault.save + openNote） */
  onSave: (dir: string, title: string, content: string) => Promise<string>;
  onClose: () => void;
}

type Stage = 'sources' | 'outline' | 'generate';

/** 断点恢复的初值（模块加载时读一次 KV）：素材原文不入 KV，只能恢复结构 */
function loadRestored(): { job: MatJob; sections: MatSection[] } | null {
  const job = loadMatJob();
  if (!job) return null;
  const secs = resetRunningSections(job.sections);
  if (!secs.some((s) => s.phase === 'done')) return null;
  return { job, sections: secs };
}

export default function MatGenView({ onSave, onClose }: Props) {
  useEsc(escThenClose(onClose));
  // 恢复放惰性初始化器而不是 effect：避免 set-state-in-effect 的级联渲染
  const [restored] = useState(loadRestored);
  const [stage, setStage] = useState<Stage>(restored ? 'generate' : 'sources');
  const [title, setTitle] = useState(restored?.job.title ?? '');
  const [brief, setBrief] = useState(restored?.job.brief ?? '');
  // 生成形式：恢复任务时用任务里存的，否则默认讲义
  const [style, setStyle] = useState<MatStyle>(asMatStyle(restored?.job.style));
  const [sources, setSources] = useState<MatSource[]>([]);
  const [sections, setSections] = useState<MatSection[]>(restored?.sections ?? []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [streamSec, setStreamSec] = useState<string | null>(null);
  const streamBuf = useRef('');
  const streamAt = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = useMemo(() => loadAgentSettings(), []);

  // async 生成循环里读写最新 sections：ref 只在事件/异步回调里访问
  const sectionsRef = useRef<MatSection[]>(sections);
  useEffect(() => { sectionsRef.current = sections; });

  /** 写 sections 的唯一出口：setState + 持久化一起走（job 不存在时只改内存） */
  const writeSections = (next: MatSection[]): void => {
    setSections(next);
    persistSections(next);
  };

  const patchSection = (id: string, patch: Partial<MatSection>): void => {
    writeSections(sectionsRef.current.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  // ---------------------------------------------------------------- 素材导入

  const addFiles = async (files: File[]): Promise<void> => {
    if (busy || !files.length) return;
    setBusy(true);
    setError('');
    const added: MatSource[] = [];
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      setStatus(`解析 ${i + 1}/${files.length}：${f.name}`);
      try {
        const content = await parseFile(f);
        if (!content.trim()) throw new Error('解析结果为空（可能是扫描件）');
        added.push({
          id: `s${Date.now().toString(36)}${i}`,
          name: f.name,
          kind: guessKind(f.name),
          content,
        });
      } catch (e) {
        failed.push(`${f.name}：${errText(e)}`);
      }
    }
    setBusy(false);
    setStatus('');
    if (added.length) setSources((prev) => [...prev, ...added]);
    if (failed.length) setError(`有 ${failed.length} 个文件解析失败：\n${failed.join('\n')}`);
  };

  const removeSource = (id: string): void => {
    setSources((prev) => prev.filter((s) => s.id !== id));
  };

  const setKind = (id: string, kind: MatKind): void => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, kind } : s)));
  };

  // ---------------------------------------------------------------- 规划

  const plan = async (): Promise<void> => {
    if (!settings) {
      setError('还没配置 AI：先到「AI 助手 → 设置」填接口地址与模型名。');
      return;
    }
    if (!sources.length) {
      setError('请先导入至少一份素材。');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError('');
    setStatus('正在阅读素材目录、规划大纲…');
    try {
      const res = await runAgent({
        settings,
        messages: buildPlanMessages({ title, brief, sources }),
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 2,
        signal: ctrl.signal,
      });
      const next = parseOutline(res.content, sources.map((s) => s.id));
      // 大纲要随任务一起落盘：只 setSections 的话，「规划完没生成任何节就关面板」会丢掉
      // 整次规划（decode 遇空 sections 返回 null，任务直接消失）。
      setSections(next);
      saveMatJob({ ...newMatJob(title || next[0]?.title || '复习讲义', sources, brief, style), sections: next });
      setStage('outline');
    } catch (e) {
      if (!isAbortError(e)) setError(`规划失败：${errText(e)}`);
    } finally {
      setBusy(false);
      setStatus('');
      abortRef.current = null;
    }
  };

  // ---------------------------------------------------------------- 分节生成

  const generateAll = async (): Promise<void> => {
    if (!settings) {
      setError('还没配置 AI：先到「AI 助手 → 设置」填接口地址与模型名。');
      return;
    }
    if (!sources.length) {
      setError('素材只存在于本次会话：请回到第一步重新导入素材（同名文件即可），再继续生成。');
      setStage('sources');
      return;
    }
    const targets = sectionsRef.current.filter((s) => s.phase !== 'done');
    if (!targets.length) {
      toast('所有节都已完成，可直接保存。', 'ok');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError('');
    const jobTitle = title || '复习讲义';
    try {
      for (const sec of targets) {
        setStatus(`生成 ${sectionsRef.current.indexOf(sec) + 1}/${sectionsRef.current.length}：${sec.title}`);
        patchSection(sec.id, { phase: 'running', error: undefined, body: '' });
        try {
          // 跨节上下文：其他节标题 + 已完成节要点摘要（防重复、引导交叉引用）
          const others = sectionsRef.current.filter((s) => s.id !== sec.id);
          const crossRef = others.length
            ? [
                `其他节：${others.map((s) => s.title).join('、')}`,
                ...others
                  .filter((s) => s.phase === 'done' && s.body.trim())
                  .map((s) => `「${s.title}」已覆盖：${sectionDigest(s.body)}`),
              ].join('\n')
            : undefined;
          streamBuf.current = '';
          streamAt.current = 0;
          setStreamSec(sec.id);
          const res = await runAgent({
            settings,
            messages: buildSectionMessages({
              title: jobTitle,
              brief,
              sectionTitle: sec.title,
              materials: buildSectionMaterials(sources, sec),
              isExamStyle: sources.some((s) => s.kind === '考题' || s.kind === '题库'),
              style,
              crossRef,
            }),
            tools: [],
            executeTool: async () => '本功能不启用工具',
            maxSteps: 2,
            signal: ctrl.signal,
            onDelta: (delta) => {
              streamBuf.current += delta;
              const now = Date.now();
              // 打字机节流：每 90ms 刷一次（与课程工坊同口径）
              if (now - streamAt.current > 90) {
                streamAt.current = now;
                patchSection(sec.id, { body: streamBuf.current });
              }
            },
          });
          patchSection(sec.id, { phase: 'done', body: res.content.trim() });
        } catch (e) {
          if (isAbortError(e)) throw e;
          patchSection(sec.id, { phase: 'error', error: errText(e) });
        } finally {
          setStreamSec(null);
        }
      }
      setStatus('生成完成，检查无误后保存。');
    } catch (e) {
      if (isAbortError(e)) {
        setStatus('已停止，已完成的部分保留。');
      } else {
        setError(`生成中断：${errText(e)}`);
      }
    } finally {
      setBusy(false);
      setStatus('');
      setStreamSec(null);
      abortRef.current = null;
      // 把还标着 running 的节复位（中断发生在当节 patch 之前的情况）
      const next = resetRunningSections(sectionsRef.current);
      writeSections(next);
    }
  };

  /** 整体审校：全部完成后一次调用，修衔接/重复/矛盾/套话并按节回填 */
  const reviewAll = async (): Promise<void> => {
    if (!settings || busy) return;
    const all = sectionsRef.current;
    if (!all.length || all.some((s) => s.phase !== 'done')) {
      toast('所有节都完成后再整体审校。', 'info');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError('');
    setStatus('终审中：通读全文、修衔接与重复…');
    try {
      const res = await runAgent({
        settings,
        messages: buildReviewMessages({ title: title || '复习讲义', brief, sections: all, style }),
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 2,
        signal: ctrl.signal,
      });
      const next = parseReview(res.content, all);
      writeSections(next);
      toast('整体审校完成，已按节回填修订。', 'ok');
    } catch (e) {
      if (!isAbortError(e)) setError(`审校失败：${errText(e)}`);
    } finally {
      setBusy(false);
      setStatus('');
      abortRef.current = null;
    }
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const retrySection = async (sec: MatSection): Promise<void> => {
    if (busy) return;
    if (!sources.length) {
      toast('素材只在本次会话内有效：请回到第一步重新导入素材（同名文件即可）再重试。', 'info', 6000);
      return;
    }
    if (!settings) {
      setError('还没配置 AI：先到「AI 助手 → 设置」填接口地址与模型名。');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError('');
    setStatus(`重新生成：${sec.title}`);
    patchSection(sec.id, { phase: 'running', error: undefined, body: '' });
    try {
      const others = sectionsRef.current.filter((s) => s.id !== sec.id);
      const crossRef = others.length
        ? [
            `其他节：${others.map((s) => s.title).join('、')}`,
            ...others
              .filter((s) => s.phase === 'done' && s.body.trim())
              .map((s) => `「${s.title}」已覆盖：${sectionDigest(s.body)}`),
          ].join('\n')
        : undefined;
      const res = await runAgent({
        settings,
        messages: buildSectionMessages({
          title: title || '复习讲义',
          brief,
          sectionTitle: sec.title,
          materials: buildSectionMaterials(sources, sec),
          isExamStyle: sources.some((s) => s.kind === '考题' || s.kind === '题库'),
          style,
          crossRef,
        }),
        tools: [],
        executeTool: async () => '本功能不启用工具',
        maxSteps: 2,
        signal: ctrl.signal,
      });
      patchSection(sec.id, { phase: 'done', body: res.content.trim() });
      setStatus('本节已更新。');
    } catch (e) {
      if (!isAbortError(e)) patchSection(sec.id, { phase: 'error', error: errText(e) });
    } finally {
      setBusy(false);
      setStatus('');
      abortRef.current = null;
    }
  };

  // ---------------------------------------------------------------- 保存

  const save = async (): Promise<void> => {
    const done = sectionsRef.current.filter((s) => s.phase === 'done' && s.body.trim());
    if (!done.length) {
      toast('还没有已生成的节，先完成至少一节。', 'info');
      return;
    }
    try {
      const job: MatJob = loadMatJob() ?? newMatJob(title || '复习讲义', sources, brief, style);
      const finalJob: MatJob = { ...job, sections: sectionsRef.current, title: title || job.title, style };
      const path = await onSave(MAT_STYLES[style].dir, safeMatTitle(finalJob.title), assembleMatNote({ job: finalJob }));
      toast(`已入库：${path}`, 'ok', 4200);
      onClose();
    } catch (e) {
      setError(`保存失败：${errText(e)}`);
    }
  };

  const removeSection = (id: string): void => {
    writeSections(sectionsRef.current.filter((s) => s.id !== id));
  };

  const renameSection = (id: string, t: string): void => {
    patchSection(id, { title: t });
  };

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ---------------------------------------------------------------- 渲染

  const doneCount = sections.filter((s) => s.phase === 'done').length;

  return (
    <PanelOverlay tone="quiz" onClose={onClose}>
      <div className="quiz-panel matgen-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">资料生成 · 复习讲义</span>
          <span className="muted matgen-stage-hint">
            {stage === 'sources' ? '① 导入素材' : stage === 'outline' ? '② 大纲确认' : '③ 生成讲义'}
          </span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        {error && <div className="matgen-error" role="alert">{error}</div>}

        {/* ---------- ① 素材 ---------- */}
        {stage === 'sources' && (
          <div className="matgen-body">
            <div className="matgen-row matgen-style-row" role="radiogroup" aria-label="生成形式">
              {MAT_STYLE_LIST.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={style === s.id}
                  className={`matgen-style-chip${style === s.id ? ' on' : ''}`}
                  title={s.hint}
                  onClick={() => setStyle(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="muted matgen-style-hint">{MAT_STYLES[style].hint}</p>
            <div className="matgen-row">
              <label htmlFor="matgen-title" className="sr-only">讲义主题</label>
              <input
                id="matgen-title"
                className="matgen-input"
                placeholder="讲义主题（如：呼吸系统 · 期末复习）"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="matgen-row">
              <label htmlFor="matgen-brief" className="sr-only">额外要求</label>
              <input
                id="matgen-brief"
                className="matgen-input"
                placeholder="额外要求（可选，如：重点第三章、面向期末笔试）"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </div>
            <div
              className={`convert-drop matgen-drop${busy ? ' busy' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="选择或拖入素材文件"
              onClick={() => !busy && fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const list = Array.from(e.dataTransfer.files ?? []);
                if (list.length) void addFiles(list);
              }}
            >
              <IconConvert size={30} />
              {busy ? (
                <Loading label={status || '解析中…'} compact />
              ) : (
                <>
                  <b>点击选择，或把素材拖到这里（可多选）</b>
                  <span className="muted">支持 PPT / Word / PDF / Markdown / TXT；全程本地解析，不上传</span>
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              aria-label="选择素材文件"
              multiple
              accept=".pdf,.docx,.doc,.pptx,.ppt,.md,.markdown,.txt,.epub"
              style={{ display: 'none' }}
              onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; void addFiles(list); }}
            />
            {sources.length > 0 && (
              <ul className="matgen-src-list">
                {sources.map((s) => (
                  <li key={s.id} className="matgen-src">
                    <IconFile size={14} />
                    <span className="matgen-src-name" title={s.name}>{s.name}</span>
                    <select
                      value={s.kind}
                      onChange={(e) => setKind(s.id, e.target.value as MatKind)}
                      aria-label={`素材种类：${s.name}`}
                    >
                      {MAT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <span className="muted">{(s.content.length / 1000).toFixed(1)}k 字</span>
                    <button className="btn-icon" onClick={() => removeSource(s.id)} aria-label={`移除 ${s.name}`}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="matgen-actions">
              <button className="btn-primary matgen-go" disabled={busy || !sources.length} onClick={() => void plan()}>
                {busy ? '规划中…' : `规划大纲（${MAT_STYLES[style].label}）→`}
              </button>
              <span className="muted">共 {sources.length} 份素材 · AI 模型：{settings?.model || '未配置'}</span>
            </div>
          </div>
        )}

        {/* ---------- ② 大纲 ---------- */}
        {stage === 'outline' && (
          <div className="matgen-body">
            <div className="matgen-row">
              <label htmlFor="matgen-title2" className="sr-only">讲义主题</label>
              <input
                id="matgen-title2"
                className="matgen-input"
                placeholder="讲义主题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <ul className="matgen-sec-list">
              {sections.map((s, i) => (
                <li key={s.id} className="matgen-sec">
                  <span className="matgen-sec-no">{i + 1}</span>
                  <label htmlFor={`matgen-sec-${s.id}`} className="sr-only">第 {i + 1} 节标题</label>
                  <input
                    id={`matgen-sec-${s.id}`}
                    className="matgen-sec-title"
                    value={s.title}
                    onChange={(e) => renameSection(s.id, e.target.value)}
                  />
                  <button className="btn-icon" onClick={() => removeSection(s.id)} aria-label={`删除第 ${i + 1} 节`}>×</button>
                </li>
              ))}
            </ul>
            {!sections.length && <p className="muted">大纲是空的：回到上一步重新规划。</p>}
            <div className="matgen-actions">
              <button className="btn-small" onClick={() => setStage('sources')} disabled={busy}>← 调整素材</button>
              <button
                className="btn-primary matgen-go"
                disabled={busy || !sections.length}
                onClick={() => { setStage('generate'); void generateAll(); }}
              >
                开始生成（{sections.filter((s) => s.phase !== 'done').length} 节待生成）
              </button>
            </div>
          </div>
        )}

        {/* ---------- ③ 生成 ---------- */}
        {stage === 'generate' && (
          <div className="matgen-body">
            {restored && (
              <div className="matgen-restored muted">
                已恢复上次任务（{doneCount}/{sections.length} 节完成）。素材原文不随任务保存：重新导入同名素材后才能继续生成或重试。
                <button className="btn-small" onClick={() => setStage('sources')}>去导入</button>
              </div>
            )}
            <div className="matgen-progress" role="progressbar" aria-valuenow={doneCount} aria-valuemax={sections.length}>
              <div className="matgen-progress-bar" style={{ width: `${sections.length ? (doneCount / sections.length) * 100 : 0}%` }} />
            </div>
            <div className="matgen-actions matgen-actions--gen">
              <button className="btn-small" onClick={stop} disabled={!busy}>停止</button>
              <button
                className="btn-small"
                onClick={() => void generateAll()}
                disabled={busy || !sections.some((s) => s.phase !== 'done') || !sources.length}
                title={sources.length ? undefined : '素材只在本次会话内：先去第一步重新导入'}
              >
                继续生成
              </button>
              <button
                className="btn-small"
                onClick={() => void reviewAll()}
                disabled={busy || !doneCount || doneCount !== sections.length}
                title="通读全文，修衔接/重复/矛盾/套话（需要所有节完成）"
              >
                整体审校
              </button>
              <button
                className="btn-primary matgen-go"
                disabled={!doneCount || busy}
                onClick={() => void save()}
              >
                保存为笔记（{doneCount}/{sections.length} 节）
              </button>
              <span className="muted">{status}</span>
            </div>
            <ul className="matgen-result">
              {sections.map((s, i) => (
                <li key={s.id} className={`matgen-sec-card phase-${s.phase}`}>
                  <div className="matgen-sec-card__head">
                    <span className="matgen-sec-no">{i + 1}</span>
                    <b className="matgen-sec-card__title">{s.title}</b>
                    <span className={`matgen-sec-card__state state-${s.phase}`}>
                      {s.phase === 'running' && <Loading label="" compact />}
                      {s.phase === 'done' && '✓ 已完成'}
                      {s.phase === 'error' && '✗ 失败'}
                      {s.phase === 'idle' && '— 待生成'}
                    </span>
                  </div>
                  {s.phase === 'error' && <div className="matgen-sec-err">{s.error}</div>}
                  {s.phase === 'running' && s.id === streamSec && s.body.trim() && (
                    <div className="matgen-sec-body matgen-sec-stream">{s.body}</div>
                  )}
                  {s.phase === 'done' && (
                    <div className="matgen-sec-body" dangerouslySetInnerHTML={{ __html: sanitizeRenderedHtml(md.render(s.body)) }} />
                  )}
                  {(s.phase === 'error' || s.phase === 'idle') && (
                    <button className="btn-small" onClick={() => void retrySection(s)} disabled={busy || !sources.length}>
                      {s.phase === 'error' ? '重试本节' : '生成本节'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </PanelOverlay>
  );
}
