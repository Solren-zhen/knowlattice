/**
 * 统一导入：**一个入口，自动识别格式，批量处理**。
 *
 * 原来「导入」散成好几个按钮（导入题库 / 导入 Anki 牌组 / 导入数据集 / 导入知识包 /
 * 从备份恢复 / 导入 md 文件夹 / 格式转换），用户得先自己知道「我这个文件属于哪一类」
 * 才点得对。这里把分派收敛成一个面板：把文件（可多选、可拖入）丢进来，由
 * core/importFormat 判定格式，再走**既有**的各条导入通道——不新开写盘路径，
 * 因此拿到的联动（复习卡 / 检索 / 图谱 / 来源标注 / 只补不覆盖）与老入口完全一致。
 *
 * 批量：逐文件处理、单个失败不中断整批；每条结果都逐行报出来（「哪个文件、识别成什么、
 * 成了没有、为什么」），不静默丢弃——这是本项目的硬纪律。
 */
import { useRef, useState } from 'react';
import { escThenClose, useEsc } from './useEsc';
import { detectImportFormat, extOf, IMPORT_FORMAT_LABELS, IMPORT_FORMATS_HINT, type ImportFormat } from '../core/importFormat';
import { parseQbankFile } from '../core/qbankParse';
import { addBank, loadBanks } from '../core/qbank';
import { mergeQuestions, mergeSummary } from '../core/qbankMerge';
import { docxToMarkdown, pdfToMarkdown, type ConvertedImage } from '../core/convert';
import { apkgSummary, apkgToVaultFiles, readAnkiTsv, readApkg } from '../core/ankiImport';
import { datasetToVaultFiles, detectDataset } from '../core/datasetImport';
import type { VaultFile } from '../core/importToVault';
import { toast } from '../core/feedback';
import { IconConvert, IconClose, IconRestore } from './icons';
import Loading from './Loading';

interface Props {
  /** 笔记备份恢复（含题库 / 复习进度按「只补新键」合并） */
  onImportBackup: (text: string) => Promise<{ ok: number; failed: number }>;
  /** 批量写入笔记文件（md / Anki / 数据集 / 转换出的文档都归这条通道） */
  onImportMd: (files: VaultFile[]) => Promise<{ ok: number; failed: number }>;
  /** 知识包安装：返回逐条结果 */
  onImportPack: (text: string) => Promise<{ created: number; skipped: Array<{ path: string; title: string; reason: string }> }>;
  /** 落库附件（文档转换出的内嵌图），返回 vault 相对路径 */
  onAttach: (filename: string, blob: Blob) => Promise<string>;
  onClose: () => void;
}

interface ReportItem {
  file: string;
  kind: ImportFormat;
  ok: boolean;
  detail: string;
}

/** JSON / md / txt 这类文本文件要读内容才能判形状；二进制类型按扩展名即可 */
function needsText(name: string): boolean {
  const ext = extOf(name);
  return ext === 'json' || ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'tsv';
}

export default function ImportView({ onImportBackup, onImportMd, onImportPack, onAttach, onClose }: Props) {
  useEsc(escThenClose(onClose));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<ReportItem[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    const list = files.filter(Boolean);
    if (busy || list.length === 0) return;
    setBusy(true);
    setReport(null);
    const items: ReportItem[] = [];
    /** 汇总所有「落成笔记」的文件，最后**一次性**走 onImportMd（批量，单次报告） */
    const pending: Array<{ file: string; files: VaultFile[] }> = [];
    const seenPaths = new Set<string>();
    const push = (file: string, kind: ImportFormat, ok: boolean, detail: string) =>
      items.push({ file, kind, ok, detail });

    for (const file of list) {
      setProgress(file.name);
      let fmt: ImportFormat = 'unknown';
      /** 这次文件是否疑似非 UTF-8（给下面那条提示用） */
      let mojibake = false;
      /** 本轮这个文件新增的条目下标：同名文件在同批里出现时也要挂在**自己**那一条上 */
      const at = items.length;
      try {
        const text = needsText(file.name) ? await file.text() : undefined;
        // 编码提示：非 UTF-8（如 GBK）读出来会带替换字符 U+FFFD。这里只提示、**不自动转码**——
        // 猜编码猜错会把一份好文件改坏，而「导入成功但内容是乱码」是最难被发现的失败。
        mojibake = !!text && text.includes('\uFFFD');
        fmt = detectImportFormat(file.name, text);

        switch (fmt) {
          case 'note-md': {
            // md 就是笔记：路径即文件名（onImportMd 内部还会做「只补不覆盖」与冲突另存）
            const files2: VaultFile[] = [{ path: file.name, content: text ?? (await file.text()) }];
            pending.push({ file: file.name, files: files2 });
            push(file.name, fmt, true, 'Markdown 笔记，已加入待写入');
            break;
          }
          case 'vault-backup': {
            const r = await onImportBackup(text ?? (await file.text()));
            push(file.name, fmt, true, `备份恢复：新增/合并 ${r.ok} 篇${r.failed ? `，${r.failed} 篇写入失败` : ''}（题库与复习进度已按「只补新键」合并）`);
            break;
          }
          case 'knowledge-pack': {
            const r = await onImportPack(text ?? (await file.text()));
            // r.skipped 里逐条的 path/title/reason 是用户核对「哪几篇没进来」的唯一线索；
            // 只报一个数字等于把它扔掉（目录树的同一个入口会列前 3 条）。
            const packSkip = r.skipped.length
              ? `，跳过 ${r.skipped.length} 篇（${r.skipped.slice(0, 3).map((s) => `${s.title || s.path}：${s.reason}`).join('、')}${r.skipped.length > 3 ? ' 等' : ''}）`
              : '';
            push(file.name, fmt, true, `知识包：新增 ${r.created} 篇${packSkip}`);
            break;
          }
          case 'anki-apkg':
          case 'anki-tsv': {
            const content = fmt === 'anki-tsv'
              ? readAnkiTsv(text ?? (await file.text()))
              : await readApkg(new Uint8Array(await file.arrayBuffer()));
            if (content.notes.length === 0) {
              push(file.name, fmt, false, apkgSummary(content));
              break;
            }
            const shape = content.modelNames.filter(Boolean).join('、') || '未知模型';
            const sourceNote = `Anki 导入（${shape}，来自 ${file.name}）`;
            const res = apkgToVaultFiles(content, { sourceNote });
            pending.push({ file: file.name, files: res.files });
            // 底层刻意把 skipped / renamed 透出来（core/ankiImport 的注释写明「一条都不报才是真的糟糕」），
            // 所以这里必须报：只说「共 50 条笔记…已加入待写入」而实际只落盘 10 篇，是最糟的失败形态。
            const ankiSkip = res.skipped.length
              ? `；未导入 ${res.skipped.length} 篇（${res.skipped.slice(0, 3).map((s) => `${s.title}：${s.reason}`).join('、')}${res.skipped.length > 3 ? ' 等' : ''}）`
              : '';
            // `renamed` 在共享类型里是可选的（core/importToVault 的注释解释了为什么），所以要兜一下
            const renamedN = res.renamed?.length ?? 0;
            const ankiRenamed = renamedN ? `；${renamedN} 篇标题含非法字符已改名` : '';
            push(file.name, fmt, true, `${apkgSummary(content)}${ankiSkip}${ankiRenamed}，已加入待写入`);
            break;
          }
          case 'dataset-json': {
            const raw: unknown = JSON.parse(text ?? (await file.text()));
            const det = detectDataset(raw);
            if (det.kind === 'unknown') {
              push(file.name, fmt, false, `未能识别数据集类型（${det.evidence.join('；')}）。原始文件没有被改动。`);
              break;
            }
            const sourceNote = `数据集导入（来自 ${file.name}）`;
            const res = datasetToVaultFiles(raw, { sourceNote });
            pending.push({ file: file.name, files: res.files });
            // 跳过的逐条原因一起报（否则用户只知道「少了 3 篇」，不知道是重名、空正文还是标题非法）
            const dsSkip = res.skipped.length
              ? `（${res.skipped.slice(0, 3).map((s) => `${s.title}：${s.reason}`).join('、')}${res.skipped.length > 3 ? ' 等' : ''}）`
              : '';
            push(file.name, fmt, true, `识别为数据集，可导入 ${res.files.length} 篇${res.skipped.length ? `，跳过 ${res.skipped.length} 篇${dsSkip}` : ''}`);
            break;
          }
          case 'qbank-json':
          case 'qbank-sheet': {
            const parsed = await parseQbankFile(file);
            if (parsed.kind === 'raw') {
              push(file.name, fmt, false, '没识别出题目，请核对文件格式（需含题干/答案）');
              break;
            }
            // 同名题库走**增量合并**（与「题库练习」面板同一口径）：addBank 是整库覆盖，
            // 直接调它会把用户已有题目的 id 全部重发 —— 逐题统计 / 错题本 / FSRS 复习 / 组题
            // 都以「题库名 + 题目 id」为键，id 一换历史进度就整体作废。所以先合、再写。
            const prev = (await loadBanks()).find((b) => b.name === parsed.name);
            if (prev) {
              const merged = mergeQuestions(prev.questions, parsed.questions);
              // 毫无变化（题全在、也没补到缺字段）就不重写，免得产生一次整库写盘
              if (merged.added > 0 || merged.enriched > 0) await addBank(parsed.name, merged.questions);
              push(file.name, fmt, true, `题库「${parsed.name}」：${mergeSummary(merged)}${parsed.note ? `（${parsed.note}）` : ''}`);
            } else {
              await addBank(parsed.name, parsed.questions);
              push(file.name, fmt, true, `题库「${parsed.name}」：${parsed.questions.length} 题${parsed.note ? `（${parsed.note}）` : ''}`);
            }
            break;
          }
          case 'document': {
            const isPdf = extOf(file.name) === 'pdf';
            const r = isPdf
              ? await pdfToMarkdown(file, (done, total) => setProgress(`${file.name} · 第 ${done}/${total} 页`))
              : await docxToMarkdown(file);
            // 图片先落库、再写笔记：顺序反了会留下「笔记在、图不在」的碎图状态
            let attached = 0;
            const failedImgs: string[] = [];
            for (const img of (r.images ?? []) as ConvertedImage[]) {
              try { await onAttach(img.filename, img.blob); attached += 1; }
              catch { failedImgs.push(img.filename); }
            }
            const path = `${(r.title || file.name).replace(/\.(docx?|pdf)$/i, '')}.md`;
            pending.push({ file: file.name, files: [{ path, content: r.markdown }] });
            const bits = [`已转换${attached ? `（含 ${attached} 张图片）` : ''}`];
            if (failedImgs.length) bits.push(`${failedImgs.length} 张图片写入失败`);
            if (r.warning) bits.push(r.warning);
            push(file.name, fmt, true, bits.join('；'));
            break;
          }
          default:
            push(file.name, fmt, false, `无法识别的文件格式（支持 ${IMPORT_FORMATS_HINT}）`);
        }
      } catch (err) {
        push(file.name, fmt, false, (err as Error).message);
      }
      // 编码提示挂在**本轮新增的那一条**上（不改 ok：文件确实写进去了，只是内容可能不对）
      if (mojibake && items.length > at) {
        items[at] = { ...items[at], detail: `${items[at].detail}；⚠ 出现替换字符「\uFFFD」：这份文件可能不是 UTF-8（如 GBK 导出），已按原样写入，内容可能是乱码，建议另存为 UTF-8 后重新导入` };
      }
    }

    // 批量写入所有「落成笔记」的文件（同一批里去重路径，避免自造同名冲突）
    if (pending.length) {
      setProgress('批量写入笔记…');
      const all: VaultFile[] = [];
      let dupSkipped = 0;
      for (const p of pending) {
        for (const f of p.files) {
          // 同名路径只写第一篇（磁盘上同名就是互相覆盖），但**要报出来**：
          // 静默少写一篇，用户拿到的只有「新增 N 篇」，永远查不出少了什么
          if (seenPaths.has(f.path)) { dupSkipped++; continue; }
          seenPaths.add(f.path);
          all.push(f);
        }
      }
      try {
        const r = await onImportMd(all);
        items.push({
          file: `（共 ${pending.length} 个来源）`, kind: 'note-md', ok: r.failed === 0,
          detail: `批量写入：新增 ${r.ok} 篇${r.failed ? `，${r.failed} 篇写入失败` : ''}${dupSkipped ? `；另有 ${dupSkipped} 篇同名路径只写入第一篇` : ''}`,
        });
      } catch (err) {
        items.push({ file: '批量写入', kind: 'note-md', ok: false, detail: (err as Error).message });
      }
    }

    setReport(items);
    setBusy(false);
    setProgress('');
    const okN = items.filter((i) => i.ok).length;
    if (okN === items.length) toast(`导入完成：${items.length} 个文件全部处理成功`, 'ok', 4200);
    else toast(`导入完成：${okN}/${items.length} 个成功，逐条原因见面板`, 'info', 7000);
  };

  /**
   * 整个文件夹批量导入（webkitdirectory）：只吃 .md——文件夹里混着的图片、pdf、附件跳过。
   * 路径取 webkitRelativePath 并**去掉顶层文件夹名**，与目录树「导入 md 文件夹」同一口径，
   * 落到同一批路径规则上；一次 onImportMd 写完整批（走「只补不覆盖」）。
   */
  const runFolder = async (files: File[]) => {
    if (busy) return;
    const notes = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
    if (!notes.length) { toast('这个文件夹里没有 Markdown 笔记（.md）', 'info', 6000); return; }
    setBusy(true);
    setReport(null);
    setProgress(`读取 ${notes.length} 篇…`);
    const list: VaultFile[] = [];
    const seen = new Set<string>();
    let dupSkipped = 0;
    let mojibake = 0;
    for (const f of notes) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const path = rel.replace(/^[^/]+\//, '');
      if (!path) continue;
      // 同名路径只留第一篇，但**要报出来**：静默丢掉第二篇，用户以后无从追查「我明明导了两个文件夹」
      if (seen.has(path)) { dupSkipped++; continue; }
      seen.add(path);
      const content = await f.text();
      if (content.includes('\uFFFD')) mojibake++;
      list.push({ path, content });
    }
    try {
      const r = await onImportMd(list);
      setReport([{
        file: `文件夹（${list.length} 篇 Markdown）`, kind: 'note-md', ok: r.failed === 0,
        detail: `批量写入：新增 ${r.ok} 篇${r.failed ? `，${r.failed} 篇写入失败` : ''}${dupSkipped ? `；${dupSkipped} 篇同名路径已跳过` : ''}${mojibake ? `；⚠ ${mojibake} 篇疑似非 UTF-8（内容可能是乱码）` : ''}`,
      }]);
      toast(`导入文件夹完成：新增 ${r.ok} 篇${r.failed ? `，${r.failed} 篇失败` : ''}`, r.failed ? 'info' : 'ok', 6000);
    } catch (err) {
      setReport([{ file: '文件夹导入', kind: 'note-md', ok: false, detail: (err as Error).message }]);
      toast(`导入文件夹失败：${(err as Error).message}`, 'err', 9000);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div className="panel-backdrop quiz-overlay" onClick={onClose}>
      <div className="quiz-panel convert-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">导入 · 自动识别格式</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="convert-input">
          <div
            className={`convert-drop${dragOver ? ' over' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="选择或拖入要导入的文件"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void run([...(e.dataTransfer.files ?? [])]); }}
          >
            <IconConvert size={30} />
            {busy ? (
              <Loading label={progress || '处理中…'} compact />
            ) : (
              <>
                <b>点击选择，或把文件拖到这里（可多选）</b>
                <span className="muted">笔记备份 / 知识包 / 题库 / 数据集 / Anki 牌组 / Markdown / PDF / Word / Excel —— 自动识别，逐条回报</span>
                <span className="muted">全程本地处理，不上传任何数据</span>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ''; }}
          />
          {/* 整个文件夹：只吃 .md，走 webkitdirectory（桌面与 Chromium 系浏览器都支持） */}
          <input
            ref={folderRef}
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            style={{ display: 'none' }}
            onChange={(e) => { void runFolder([...(e.target.files ?? [])]); e.target.value = ''; }}
          />
          <div className="quiz-actions import-actions">
            <button className="btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>选择文件（可多选）</button>
            <button className="btn-small" disabled={busy} onClick={() => folderRef.current?.click()}>导入整个文件夹（.md）</button>
          </div>
        </div>

        {report && (
          <div className="quiz-import-report" role="status" aria-label="导入结果">
            <div className="quiz-import-report-head">
              <b>导入结果</b>
              <span className="muted">{report.filter((r) => r.ok).length}/{report.length} 个成功</span>
              <button className="btn-small" onClick={() => setReport(null)}>收起</button>
            </div>
            <ul>
              {report.map((r, i) => (
                <li key={`${r.file}-${i}`} className={r.ok ? 'ok' : 'err'}>
                  <span className="quiz-import-report-file" title={r.file}>{r.file}</span>
                  <span className="muted">
                    <b> {IMPORT_FORMAT_LABELS[r.kind]}</b> · {r.detail}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted"><IconRestore /> 识别不了的格式不会导入，也不会改动原文件。</p>
          </div>
        )}
      </div>
    </div>
  );
}
