/**
 * P3 · 学习报告面板：把 core/studyReport 生成的报告渲染出来，并提供「复制 Markdown」「下载 .md」。
 *
 * 设计约束（都很刻意）：
 *  - **props 驱动、自包含**：这里不 import vault / store / localStorage，也不自己调 buildStudyReport。
 *    报告数据由调用方（Workspace）算好传进来 —— 面板只是展示层，这样报告也能在导出/备份路径里复用。
 *  - 时间范围只作为**档位**（rangeOfPreset 的字面量）与回调进面板：为什么不在面板里自己重算 ——
 *    重算要 loadBanks（IndexedDB）/ buildCards（全库切卡）/ 读各类 localStorage，那是 Workspace 的数据线；
 *    把它们搬进展示层等于把上面那条「自包含」自己破掉，面板也就不能再被导出路径复用。
 *    所以面板只发「用户选了哪个档」这个事件，由调用方在事件里重算（不能放 render，见 Workspace 那段注释）。
 *  - **不新增 CSS**：只使用 src/index.css 里已有的通用类（panel / panel__head / panel__body /
 *    mistake-panel / mistake-list / mistake-empty / btn-small / btn-icon / muted）。
 *    另一个代理正在改 index.css，新增类名会与它冲突，也会让样式散落到两个文件。
 *  - **不引入 markdown 渲染器**：markdown 字段是给导出/复制用的；面板按行渲染正文，
 *    只为 `**强调**` 做一次行内加粗，避免为了一块预览把 markdown-it 拖进这个面板。
 */

import { useState, type ReactNode } from 'react';
import { fmtDay, type StudyReport, type StudyReportRangePreset } from '../core/studyReport';
import { useEsc } from './useEsc';
import DialogSurface from './DialogSurface';
import { IconClose } from './icons';

/** 三个互斥档位。**文案留在面板**：core 只给字面量与边界计算，界面用词不该塞进纯函数模块 */
const RANGE_PRESETS: Array<{ id: StudyReportRangePreset; label: string }> = [
  { id: 'all', label: '全部（累计）' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
];

export interface StudyReportPanelProps {
  /** 报告数据：由调用方 `buildStudyReport(input)` 得到（见 core/studyReport.ts 的 StudyReportInput） */
  report: StudyReport;
  /** 关闭面板（Esc / 右上角关闭按钮 / 点遮罩）。不传则不注册 Esc、也不显示关闭按钮 */
  onClose?: () => void;
  /**
   * 「复制 Markdown」的副作用交给调用方（例如 core/feedback 的 toast 提示）。
   * 不传时面板内部退化为 navigator.clipboard.writeText，并自己显示「已复制 / 复制失败」。
   * 之所以留这个口子：通知方式属于宿主（Workspace 已有统一的 toast 纪律），面板不该另搞一套。
   */
  onCopy?: (markdown: string) => void | Promise<void>;
  /** 下载文件名；默认「<标题>-<本地日期>.md」 */
  fileName?: string;
  /** 当前档位；不传视为 'all'（累计口径，与加时间范围之前逐字一致的默认档） */
  range?: StudyReportRangePreset;
  /**
   * 切换档位。重算由调用方做（见文件头）。**不传就不渲染范围选择**——
   * 与 onClose / onCopy 同一套「留口子」写法：只导出报告内容的路径不需要这排按钮。
   */
  onRangeChange?: (preset: StudyReportRangePreset) => void | Promise<void>;
  /** 调用方正在重算：按钮 disabled，免得连点堆起多次全库聚合 */
  busy?: boolean;
}

/** 一行正文的形态：`- ` 是列表项，`  - ` 是列表项下的补充明细，其余是普通句子 */
type BodyLine = { kind: 'item' | 'nested' | 'text'; text: string };

function parseLines(body: string): BodyLine[] {
  return body.split('\n').map((raw) => {
    if (raw.startsWith('  - ')) return { kind: 'nested' as const, text: raw.slice(4) };
    if (raw.startsWith('- ')) return { kind: 'item' as const, text: raw.slice(2) };
    return { kind: 'text' as const, text: raw };
  });
}

/** 行内轻量渲染：只认 `**强调**`，其余原样显示（完整 Markdown 由导出/复制那条路径负责） */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <span key={i}>{part}</span>
    );
}

function SectionBody({ body }: { body: string }) {
  const lines = parseLines(body);
  const nodes: ReactNode[] = [];
  let list: ReactNode[] = [];
  /** 把连续的行内列表项收进一个 <ul>：零散的 li 会让屏幕阅读器读出错误的结构 */
  const flush = () => {
    if (!list.length) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`} style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
        {list}
      </ul>
    );
    list = [];
  };
  lines.forEach((line, i) => {
    if (line.kind === 'text') {
      if (!line.text.trim()) return; // 空行只是 Markdown 里的段落间隔，面板里不需要占位
      flush();
      nodes.push(
        <p key={`p-${i}`} className="muted" style={{ margin: '4px 0 8px' }}>{inline(line.text)}</p>
      );
      return;
    }
    list.push(
      <li key={`li-${i}`} style={line.kind === 'nested' ? { marginLeft: 14 } : undefined}>{inline(line.text)}</li>
    );
  });
  flush();
  return <>{nodes}</>;
}

export default function StudyReportPanel({
  report, onClose, onCopy, fileName, range, onRangeChange, busy,
}: StudyReportPanelProps) {
  const [notice, setNotice] = useState('');
  // Esc 走全局栈（与统计面板同一套）；没有 onClose 时不注册，免得把 Esc 白占一层
  useEsc(() => onClose?.(), Boolean(onClose));
  // 不传 range 视为「全部（累计）」：高亮的按钮必须与**当前这份报告的实际情况**一致，
  // 而默认档正是「不传 range」的累计口径（见 core/studyReport.rangeOfPreset）
  const selected = range ?? 'all';

  const copy = async () => {
    try {
      if (onCopy) await onCopy(report.markdown);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(report.markdown);
      else throw new Error('clipboard unavailable');
      // 提供 onCopy 时提示交给调用方，面板不重复打扰
      setNotice(onCopy ? '' : '已复制 Markdown');
    } catch {
      setNotice('复制失败，请手动全选复制');
    }
  };

  const download = () => {
    // 与 ConvertView 的导出同一写法：Blob + createObjectURL + <a download>，click 之后立刻回收 URL
    const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName ?? `${report.title}-${fmtDay(Date.now())}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel-backdrop mistake-overlay" onClick={onClose}>
      <DialogSurface className="panel mistake-panel" label={report.title} onClick={(e) => e.stopPropagation()}>
        <div className="panel__head mistake-header">
          <span className="panel__title mistake-title">{report.title}</span>
          <div className="panel__actions">
            <button type="button" className="btn-small" onClick={() => void copy()}>复制 Markdown</button>
            <button type="button" className="btn-small" onClick={download}>下载 .md</button>
            {onClose && (
              <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
            )}
          </div>
        </div>

        <div className="panel__body mistake-list">
          {notice && <p className="muted" role="status">{notice}</p>}

          {/* 时间范围选择：放在正文最上方，因为「这份报告看的是哪段时间」是读下面所有数字的前提，
              塞到小节之间会让人先读到数字、后才发现口径不同。按钮复用既有 .chip / .chip.on
              （与错题本的过滤行同一套，见 MistakeBook 的 mistake-filter-row），不新增 CSS。 */}
          {onRangeChange && (
            <div
              role="group"
              aria-label="报告时间范围"
              style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 var(--sp-3) var(--sp-2)' }}
            >
              <span className="muted">时间范围</span>
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip${selected === p.id ? ' on' : ''}`}
                  aria-pressed={selected === p.id}
                  disabled={busy}
                  onClick={() => void onRangeChange(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {/* 口径提示必须在界面上出现：切到 7/30 天后「复习卡」「错题分布」里的数字会变小，
              不写清范围只作用于带时间戳的字段，用户会以为题目练习那几行也被过滤了（实际没有）。 */}
          {onRangeChange && selected !== 'all' && (
            <p className="muted" style={{ margin: '0 var(--sp-3) var(--sp-2)' }}>
              该范围只作用于复习卡与错题的时间戳统计（最近一次复习时间 / 最近一次失败时间），题目练习仍是累计值。
            </p>
          )}

          {!report.sufficient && (
            <div className="mistake-empty">
              <h2>还没有足够数据生成报告</h2>
              <p className="muted">
                先去题库练一轮、或复习几张卡片，这里就会汇总做题量、正确率、薄弱章节与到期卡。
                下面的报告里也逐条写明了「哪些数字因为样本不足而不下结论」，可以导出留档。
              </p>
            </div>
          )}

          {report.sufficient && report.highlights.length > 0 && (
            <div
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 var(--sp-3) var(--sp-3)' }}
              aria-label="报告要点"
            >
              {report.highlights.map((h) => (
                // 复用既有 .chip 的胶囊样式；它是纯展示（不可点），所以把 cursor 改回默认，
                // 否则鼠标变成手型会让人以为「点一下能跳转」
                <span key={h} className="chip" style={{ cursor: 'default' }}>{h}</span>
              ))}
            </div>
          )}

          {report.sections.map((s) => (
            <section key={s.heading} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '8px 0 4px' }}>{s.heading}</h4>
              <SectionBody body={s.body} />
            </section>
          ))}
        </div>
      </DialogSurface>
    </div>
  );
}
