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
import { useEffect, useRef, useState } from 'react';
import { escThenClose, useEsc } from './useEsc';
import { detectImportFormat, extOf, IMPORT_FORMAT_LABELS, IMPORT_FORMATS_HINT, type ImportFormat } from '../core/importFormat';
import { parseQbankFile } from '../core/qbankParse';
import { addBank, addBankBatch, loadBanks, type QuizQuestion } from '../core/qbank';
import { mergeQuestions, mergeSummary } from '../core/qbankMerge';
import { docxToMarkdown, pdfToMarkdown, type ConvertedImage } from '../core/convert';
import { apkgSummary, apkgToVaultFiles, readAnkiTsv, readApkg } from '../core/ankiImport';
import { datasetToVaultFiles, detectDataset } from '../core/datasetImport';
import { looksLikeKnowledgeTopics, parseKnowledgeTopics, saveKnowledgeAudio } from '../core/knowledgeAudio';
import {
  collectPackRefs,
  detectContentPack,
  packBundleUnits,
  packIndexSummary,
  packUnitTitle,
  packUnitToQuestions,
} from '../core/contentPack';
import {
  bookMarkdown,
  bookNotePath,
  groupBooks,
  looksLikePageLinks,
  looksLikePages,
  packPageLinks,
  packPages,
  unitBriefIndex,
  type ItemBrief,
  type PackPage,
} from '../core/contentPackNotes';
import type { VaultFile } from '../core/importToVault';
import { isImagePath } from '../core/imageRef';
import { toast } from '../core/feedback';
import { IconConvert, IconClose, IconRestore } from './icons';
import Loading from './Loading';
import PanelOverlay from './PanelOverlay';

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

/** 选中文件在**选中根目录内**的相对路径（去掉最外层文件夹名，与目录树导入同一口径） */
function relPathOf(f: File): string {
  return ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/^[^/]+\//, '');
}

export default function ImportView({ onImportBackup, onImportMd, onImportPack, onAttach, onClose }: Props) {
  useEsc(escThenClose(onClose));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<ReportItem[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /**
   * 内容包的图片是 8,574 张 / 约 1.9 GB 的素材，整批写进库要几分钟。
   * 默认不导图：先把题目和讲义页文字导进去（几秒到几十秒），确认没问题再勾上补一遍图。
   * 不默认导图还有一个原因——中途写爆配额或卡住，用户会以为「导入功能坏了」。
   */
  const [withMedia, setWithMedia] = useState(false);
  /**
   * 本机题库数。内容包导入的是**题库**，进的是「题库练习」，不会出现在「文件/笔记」树里——
   * 这两处对不上，就是「导入了却看不到文件」的主要来源。把数字摆在导入面板上，
   * 用户一眼能判断到底进没进去，不用猜。
   */
  const [bankCount, setBankCount] = useState<number | null>(null);
  const refreshBankCount = () => {
    void loadBanks().then((b) => setBankCount(b.length)).catch(() => setBankCount(null));
  };
  useEffect(refreshBankCount, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    const picked = files.filter(Boolean);
    if (busy || picked.length === 0) return;
    /**
     * 图片不是「要识别格式的文档」，是给内容包正文里的图片位当素材的：整包导入时一批就有
     * 八千多张，如果让它们也走一遍格式识别，报告里会多出八千行「无法识别」，真错误被埋在
     * 里面，用户看到的就是「导入失败」。所以先分池：文档走分派，图片只进索引。
     */
    const list = picked.filter((f) => !isImagePath(f.name));
    const imagePool = withMedia ? picked.filter((f) => isImagePath(f.name)) : [];
    if (list.length === 0) {
      toast(`这批文件里只有 ${imagePool.length} 张图片：图片是配图素材，只随内容包的题目一起落库`, 'info', 6000);
      return;
    }
    setBusy(true);
    setReport(null);
    const items: ReportItem[] = [];
    /** 汇总所有「落成笔记」的文件，最后**一次性**走 onImportMd（批量，单次报告） */
    const pending: Array<{ file: string; files: VaultFile[] }> = [];
    const seenPaths = new Set<string>();
    /**
     * 内容包里的图片：单元正文只写 `{"t":"image","v":"<ref>"}`，图本身是同一批文件里的
     * `media/files/<ref>.<ext>`。按「文件名去扩展名 == ref」索引即可命中，不必读 media/index.json。
     * 懒建：普通导入不该为它多遍历一遍文件名。
     */
    let packImages: Map<string, File> | null = null;
    const getPackImages = (): Map<string, File> => {
      if (!packImages) {
        packImages = new Map();
        for (const f of [...list, ...imagePool]) {
          const m = /(?:^|\/)media\/files\/([^/]+)$/.exec(relPathOf(f));
          if (m) packImages.set(m[1].replace(/\.[^.]+$/, ''), f);
        }
      }
      return packImages;
    };
    /** 同一个 ref 可能被几十道题引用：落一次库，后面直接复用路径 */
    const packAttached = new Map<string, string>();
    /** 讲义页落库：ref → vault 路径；图不在本批文件里时返回 null（跳过这张，不整页放弃） */
    const attachRef = async (ref: string): Promise<string | null> => {
      const cached = packAttached.get(ref);
      if (cached) return cached;
      const f = getPackImages().get(ref);
      if (!f) return null;
      try {
        const path = await onAttach(f.name, f);
        packAttached.set(ref, path);
        return path;
      } catch {
        return null;
      }
    };
    /**
     * 讲义页与页题映射要等**整批**处理完才能落笔记：同一批里 pages 可能排在 unit 前面，
     * 先写就只剩「图片在、题干看不到」。所以先缓存，循环结束后再统一生成。
     */
    const pageBuffer: PackPage[] = [];
    let linkMap: Record<string, string[]> = {};
    /** 题目 id → 题干摘要，来自本批选中的 unit 文件 */
    const briefIndex = new Map<string, ItemBrief>();
    const push = (file: string, kind: ImportFormat, ok: boolean, detail: string) =>
      items.push({ file, kind, ok, detail });

    /**
     * 一个单元 → 待写入的题库（不落盘）。合集要先把几十个单元都算出来，再用一次
     * addBankBatch 写盘：逐个 addBank 每次都读全库，327 个单元会退化成 O(n²)。
     */
    const buildUnit = async (
      pack: unknown,
      label: string,
    ): Promise<{ name: string; questions: QuizQuestion[]; imgNote: string } | null> => {
      // 顺手收一份「题目 id → 题干」，供同批的讲义页笔记引用（讲义页本身不含题干）
      for (const [qid, brief] of unitBriefIndex(pack)) briefIndex.set(qid, brief);
      // 图片先落库、再建题：顺序反了会留下一批「图在引用里、vault 里没有」的碎图题，
      // 而这种半截状态在界面上看不出来（就是个灰图标），事后无从归因。
      const refs = collectPackRefs(pack);
      const missing: string[] = [];
      let attached = 0;
      for (const ref of refs) {
        if (packAttached.has(ref)) continue;
        if (!withMedia) continue;
        const f = getPackImages().get(ref);
        if (!f) { missing.push(ref); continue; }
        try {
          packAttached.set(ref, await onAttach(f.name, f));
          attached += 1;
          if (attached % 20 === 0) setProgress(`${label} · 图片 ${attached}/${refs.length}`);
        } catch { missing.push(ref); }
      }
      const { questions, dropped } = packUnitToQuestions(pack, (r) => packAttached.get(r));
      if (!questions.length) {
        push(label, 'content-pack', false, `这个单元里没有能建成的题目（${refs.length ? `${refs.length} 张图已处理；` : ''}每题至少需要题干与答案）。`);
        return null;
      }
      const imgNote = !refs.length
        ? ''
        : !withMedia
          ? `；图未导（勾上「连图片一起导」再导一次可补 ${refs.length} 张）`
          : `；图 ${refs.length - missing.length}/${refs.length} 已落 _attachments/`
            + `${missing.length ? `（${missing.length} 张不在本批文件里）` : ''}`
            + `${dropped ? `，另有 ${dropped} 张在解析正文里，题库模型没有对应位置` : ''}`;
      // 题库名取「科目 · 分组 · 标题」的稳定值：同名再次导入走增量合并，
      // 题目 id 与已完成进度都保住（addBank 整库覆盖会把进度整体作废）
      return { name: packUnitTitle(pack), questions, imgNote };
    };

    /** 单个单元：算完直接写（一次读写，够快） */
    const importUnit = async (pack: unknown, label: string): Promise<void> => {
      const built = await buildUnit(pack, label);
      if (!built) return;
      const prev = (await loadBanks()).find((b) => b.name === built.name);
      if (prev) {
        const merged = mergeQuestions(prev.questions, built.questions);
        if (merged.added > 0 || merged.enriched > 0) await addBank(built.name, merged.questions);
        push(label, 'content-pack', true, `题库「${built.name}」：${mergeSummary(merged)}${built.imgNote}`);
      } else {
        await addBank(built.name, built.questions);
        push(label, 'content-pack', true, `题库「${built.name}」：${built.questions.length} 题${built.imgNote}`);
      }
    };

    let done = 0;
    for (const file of list) {
      done += 1;
      setProgress(`${done}/${list.length} · ${file.name}`);
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
          case 'content-pack': {
            const pack: unknown = JSON.parse(text ?? (await file.text()));
            const role = detectContentPack(pack);
            // 合集：一个文件装几十个单元。先全部算出来，再一次写盘（批量读写，不逐个抖库）。
            if (role === 'bundle') {
              const units = packBundleUnits(pack);
              const built: Array<{ name: string; questions: QuizQuestion[]; imgNote: string }> = [];
              for (const [i, u] of units.entries()) {
                setProgress(`${file.name} · 单元 ${i + 1}/${units.length}`);
                const one = await buildUnit(u, `${file.name} · ${packUnitTitle(u)}`);
                if (one) built.push(one);
              }
              if (built.length) {
                setProgress(`${file.name} · 写入 ${built.length} 个题库（${built.reduce((n, b) => n + b.questions.length, 0)} 题）…`);
                await addBankBatch(built.map(({ name, questions }) => ({ name, questions })));
                const total = built.reduce((n, b) => n + b.questions.length, 0);
                const imgRefs = units.reduce((n: number, u) => n + collectPackRefs(u).length, 0);
                push(file.name, fmt, true,
                  `写入 ${built.length} 个题库、共 ${total} 题`
                  + `${units.length - built.length ? `（${units.length - built.length} 个单元没建成，见上面逐条）` : ''}`
                  + `${imgRefs
                    ? (!withMedia
                      ? `；图未导（勾上「连图片一起导」再导一次可补 ${imgRefs} 张）`
                      : `；图 ${packAttached.size} 张已落 _attachments/`)
                    : ''}`);
              } else {
                push(file.name, fmt, false, '合集里没有能建成的题目（每单元至少需要题干与答案）。原始文件没有被改动。');
              }
              break;
            }
            if (role === 'index') {
              // 索引本身不含题目。只导入索引时说清「为什么一道题都没有」，并指路到单元文件，
              // 否则用户看到的是「导入成功 + 0 题」这种最容易被当成 bug 的结果。
              push(file.name, fmt, true, `内容包索引：${packIndexSummary(pack)}。索引里没有题目——把 unit/ 里的文件一起选进来（或整包选中 out 文件夹）才会导入。`);
              break;
            }
            if (role !== 'unit') {
              push(file.name, fmt, false, '像是内容包的 JSON，但既不是合集（units 里是单元对象）、索引（units 里是文件名）也不是单元（缺 unitId/items）。原始文件没有被改动。');
              break;
            }
            await importUnit(pack, file.name);
            break;
          }
          case 'content-pack-pages': {
            const raw: unknown = JSON.parse(text ?? (await file.text()));
            if (looksLikePages(raw)) {
              const pages = packPages(raw);
              if (!pages.length) {
                push(file.name, fmt, false, '没有可用的页：每页至少要有 paper 与 page 两个字段。原始文件没有被改动。');
                break;
              }
              pageBuffer.push(...pages);
              push(file.name, fmt, true, `讲义页 ${pages.length} 页，等整批处理完一起写成讲义笔记`);
              break;
            }
            if (looksLikePageLinks(raw)) {
              const links = packPageLinks(raw);
              // 映射本身不含图片与正文：单独导入没有意义，必须和讲义页文件一起用
              linkMap = { ...linkMap, ...links };
              push(file.name, fmt, true, `页题映射 ${Object.keys(links).length} 页；和讲义页文件一起选进来就能在每页下看到相关题`);
              break;
            }
            push(file.name, fmt, false, '像是讲义页数据，但既不是页列表（缺 paper/page）也不是页题映射（键不是「paper:页码」）。原始文件没有被改动。');
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
            // 空的页题映射不是坏文件：这份内容的讲义页确实没有题目关联（源数据只给了页级题干片段）。
            // 按「无法识别」报会让人以为文件坏了，去找一个根本不存在的问题。
            if (/page2item\.json$/i.test(file.name)) {
              push(file.name, fmt, true, '页题映射为空：这份内容的讲义页与题目在源数据里没有关联。讲义页本身可正常导入（按页看图、看页要点）。');
              break;
            }
            // 知识点索引用的是 topic/ 与 link/ 下的文件：题库模型只有章节字段，没有知识点表。
            // 按「无法识别」报等于让人去找一个不存在的坏文件，这里认下来并说清现状。
            if (/.json$/i.test(file.name)) {
              // 坏 JSON 不该把「无法识别的文件格式」变成一句 JS 报错原文
              let rawTopics: unknown = null;
              try { rawTopics = JSON.parse(await file.text()) as unknown; } catch { rawTopics = null; }
              if (looksLikeKnowledgeTopics(rawTopics)) {
                const topics = parseKnowledgeTopics(rawTopics);
                const saved = saveKnowledgeAudio(topics);
                const withAudio = topics.filter((t) => t.audio).length;
                push(
                  file.name,
                  fmt,
                  saved.ok,
                  saved.ok
                    ? `知识点录音 ${topics.length} 条（${withAudio} 条有录音），本机共 ${saved.total} 条；在「医学速查 → 听课」里听`
                    : '知识点没存上：本机存储已满或被禁用',
                );
                break;
              }
            }
            if (/(?:^|\/)(?:topic|link)\//.test(relPathOf(file))) {
              push(file.name, fmt, true, '知识点索引：暂不导入（题库按章节归类，知识点录音已单独入库）');
              break;
            }
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

    // 讲义页 → 一本讲义一篇笔记。放在整批循环之后：同一批里 pages 可能排在 unit 前面，
    // 提前写就只能拿到图片、拿不到「这一页对应哪几道题」。
    if (pageBuffer.length) {
      setProgress('写入讲义笔记…');
      const books = groupBooks(pageBuffer);
      let attached = 0;
      let missing = 0;
      let linked = 0;
      for (const book of books) {
        /** 本册已落库的图：ref → `_attachments/…`（同一 ref 在全库只落一次） */
        const paths = new Map<string, string>();
        for (const p of book.pages) {
          for (const ref of p.images) {
            if (paths.has(ref)) continue;
            const got = await attachRef(ref);
            if (got) { paths.set(ref, got); attached += 1; } else missing += 1;
          }
        }
        const md = bookMarkdown(book, {
          links: linkMap,
          index: briefIndex,
          mediaPath: (ref) => paths.get(ref) ?? null,
        });
        if (Object.keys(linkMap).length) linked += book.pages.filter((p) => linkMap[`${p.paper}:${p.page}`]).length;
        pending.push({ file: `讲义 ${book.label}`, files: [{ path: bookNotePath(book), content: md }] });
      }
      items.push({
        file: '（讲义页）',
        kind: 'content-pack-pages',
        ok: books.length > 0,
        detail: `讲义 ${books.length} 本、${pageBuffer.length} 页已加入待写入；`
          + (!withMedia && pageBuffer.some((p) => p.images.length)
            ? '图未导（勾上「连图片一起导」再导一次，讲义页才有图）'
            : `图 ${attached} 张落库${missing ? `，${missing} 张不在本批文件里` : ''}`)
          + `${linked ? `，${linked} 页带上了相关题` : ''}`,
      });
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
    refreshBankCount();
    const okN = items.filter((i) => i.ok).length;
    if (okN === items.length) toast(`导入完成：${items.length} 个文件全部处理成功`, 'ok', 4200);
    else toast(`导入完成：${okN}/${items.length} 个成功，逐条原因见面板`, 'info', 7000);
  };

  /**
   * 整个文件夹批量导入（webkitdirectory）：吃 .md + 图片（png/jpg/gif/webp/svg/bmp/avif），
   * 其余（pdf/附件）跳过。
   * 路径取 webkitRelativePath 并**去掉顶层文件夹名**，与目录树「导入 md 文件夹」同一口径，
   * 落到同一批路径规则上；一次 onImportMd 写完整批（走「只补不覆盖」）。
   *
   * 图片按同样的相对路径落到 `_attachments/` 下（`fig/x.png` → `_attachments/fig/x.png`）：
   * 这是从 Obsidian 搬库不断图的关键 —— 笔记里写的 `![[fig/x.png|300]]` 正是按
   * 「原路径 → 加 _attachments/ 前缀」找图（见 core/imageRef），目录结构保住就能直接命中，
   * 不需要改写任何正文。
   */
  const runFolder = async (files: File[]) => {
    if (busy) return;
    const notes = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
    if (!notes.length) {
      // 内容包整包：文件夹里没有 md，但有 .json —— 直接转交统一导入通道。
      // 让用户为三百多个单元文件去文件选择器里 Ctrl+A，是把「能导入」变成「知道怎么导入」的差别。
      // 不按 unit/topic/link 目录名筛选：用户经常直接选 out\unit 这一层，路径里就没有 unit/ 前缀了。
      const packFiles = files.filter((f) => /\.json$/i.test(f.name) && !/(^|\/)media\//.test(relPathOf(f)));
      if (packFiles.length) {
        // 图片要显式勾选才带：默认只导题与讲义文字，先让用户看到结果，再补图
        const imgs = withMedia ? files.filter((f) => isImagePath(f.name)) : [];
        await run([...packFiles, ...imgs]);
        return;
      }
      toast('这个文件夹里没有 Markdown 笔记（.md）', 'info', 6000); return;
    }
    const images = files.filter((f) => isImagePath(f.name));
    setBusy(true);
    setReport(null);
    const relPath = relPathOf; // 与统一通道里给内容包图片建索引时同一口径（都去掉最外层文件夹名）
    let attachOk = 0;
    let attachFailed = 0;
    if (images.length) {
      setProgress(`写入 ${images.length} 张图片…`);
      for (const f of images) {
        const path = relPath(f);
        if (!path) continue;
        // 单张失败不打断整批：报告里说清几张没写进去，笔记照旧导入
        try { await onAttach(path, f); attachOk++; } catch { attachFailed++; }
      }
    }
    setProgress(`读取 ${notes.length} 篇…`);
    const list: VaultFile[] = [];
    const seen = new Set<string>();
    let dupSkipped = 0;
    let mojibake = 0;
    for (const f of notes) {
      const path = relPath(f);
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
        file: `文件夹（${list.length} 篇 Markdown${attachOk ? ` + ${attachOk} 张图片` : ''}）`, kind: 'note-md',
        ok: r.failed === 0 && !attachFailed,
        detail: `批量写入：新增 ${r.ok} 篇${r.failed ? `，${r.failed} 篇写入失败` : ''}`
          + `${attachOk ? `；图片 ${attachOk} 张已落到 _attachments/` : ''}`
          + `${attachFailed ? `；⚠ ${attachFailed} 张图片写入失败` : ''}`
          + `${dupSkipped ? `；${dupSkipped} 篇同名路径已跳过` : ''}`
          + `${mojibake ? `；⚠ ${mojibake} 篇疑似非 UTF-8（内容可能是乱码）` : ''}`,
      }]);
      toast(
        `导入文件夹完成：新增 ${r.ok} 篇${attachOk ? `、${attachOk} 张图片` : ''}${r.failed || attachFailed ? `，${r.failed + attachFailed} 项失败` : ''}`,
        r.failed || attachFailed ? 'info' : 'ok', 6000,
      );
    } catch (err) {
      setReport([{ file: '文件夹导入', kind: 'note-md', ok: false, detail: (err as Error).message }]);
      toast(`导入文件夹失败：${(err as Error).message}`, 'err', 9000);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <PanelOverlay tone="quiz" onClose={onClose}>
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
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = '';
              void run(picked).catch((err: unknown) =>
                toast(`导入中断：${(err as Error)?.message ?? String(err)}`, 'err', 12000));
            }}
          />
          {/* 整个文件夹：吃 .md + 图片（图片落到 _attachments/ 下同相对路径），走 webkitdirectory */}
          <input
            ref={folderRef}
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            style={{ display: 'none' }}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = '';
              // 不接住异常的话，出错时页面只会「什么都不发生」——那看起来就像导入功能坏了
              void runFolder(picked).catch((err: unknown) =>
                toast(`导入中断：${(err as Error)?.message ?? String(err)}`, 'err', 12000));
            }}
          />
          <div className="quiz-actions import-actions">
            <button className="btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>选择文件（可多选）</button>
            <button className="btn-small" disabled={busy} onClick={() => folderRef.current?.click()}>导入整个文件夹（.md + 图片）</button>
            <label className="import-with-media">
              <input type="checkbox" checked={withMedia} disabled={busy} onChange={(e) => setWithMedia(e.target.checked)} />
              连图片一起导（8,574 张 / 约 1.9 GB，会慢几分钟）
            </label>
            {bankCount !== null && (
              <span className="muted import-bankcount">
                本机已有 {bankCount} 个题库（在「题库练习」里，不在「文件」里）
              </span>
            )}
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
    </PanelOverlay>
  );
}
