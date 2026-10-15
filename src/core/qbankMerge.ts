/**
 * 题库「增量导入」（O3）：把新拿到的题目合进已有题库 —— **只补新题、不重复、不覆盖**。
 *
 * 为什么需要这个模块：
 *   既有的入库函数 `addBank`（core/qbank.ts:133-147）是**同名整库覆盖**：
 *   同名题库再导入一次，旧题目数组会被整个换掉，只按「题干 + 选项」把选项批注接回去。
 *   于是「用户自己整理的题」遇上「别人的同名文件 / 题源更新后的新版本」时，
 *   整库被替换，且旧题的 id 全部作废 —— 而逐题统计、错题加权、FSRS 复习、组题、
 *   Anki 导出都以**题目 id** 为键，id 一换，用户的历史进度就整体错位。
 *   而「同一份题源更新了一版，再导一次」是极常见的动作，必须只补新题。
 *
 * 本模块是**纯函数**：不碰 DOM、不碰 localStorage / IndexedDB、不引入新依赖，因此可单测。
 * 写库仍然只有一条通道 —— 调用方把合并结果交回既有的 `addBank`（见 views/QuizView.tsx），
 * 本模块自己绝不写任何存储（也不该有第二条写库路径，否则两边迟早分叉）。
 */
import { chaptersOf, correctIndices, type QuizQuestion } from './qbank';

/**
 * 指纹归一：NFKC（全角→半角、"Ａ"/"１" 这类兼容字符统一）+ 去控制字符 + 空白折叠 + 去首尾空白。
 *
 * 为什么要折叠空白：同一份题源在不同工具里过一遍，中文全角空格（U+3000，NFKC 会变成普通空格）、
 * 行尾空格、`题干 ？` 这种多余空格都会出现；不归一就会出现「同一道题被判成两道」的假重复。
 * 为什么不一起小写化：「pH / Hb / PaCO2」在医学题库里大小写是有意义的，
 * 归一过头会把内容确实不同的题判成同一道 —— 那是静默丢题，比多一条重复难查得多。
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .normalize('NFKC')
    // 控制字符一律折成空格：它们既不可见，又会在题库导出/粘贴过程中被悄悄塞进来。
    // 用 Unicode 属性 \p{Cc}（控制）/ \p{Cf}（BOM、零宽连接符这类格式字符）而不是写字面的
    // 控制字符区间：转义表意清楚，也不会让静态检查把源码当可疑内容（no-control-regex）。
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 内容指纹：**与 id 无关**。
 *
 * 为什么不能用 id 去重：题目 id 是解析时现造的，里面带 `Date.now()` 的时间戳
 * （core/qbank.ts:472 `q-${Date.now().toString(36)}-${i}`，小问在 qbank.ts:462）——
 * 同一个文件导两次，每道题的 id 都不同。拿 id 当键，「重复导入」永远检测不出来。
 *
 * 指纹 = 题型 + 共用题干 + 题干 + 选项 + 正确答案 + 章节（全部先归一，见上）。
 *   - 正确答案取 `correctIndices`（core/qbank.ts:299）：多选（X 型）与单选因此同一口径，
 *     不必在这里重写一套判分解析；
 *   - 章节取 `chaptersOf`（core/qbank.ts:323）：`chapter: '甲'` 与 `chapters: ['甲']` 得到同一结果，
 *     「单章节 / 多章节」两种写法不会变成两道题；
 *   - 共用题干（A3/A4）也算题干的一部分：病例题的小问题干常常短到不足以区分
 *     （「下列哪项正确」），只比小问题干会把两个不同病例的题误判成同一道。
 *     误判 = 静默少一道题，比多出一条重复难查得多，所以这里宁可更严格。
 *   - 用 `JSON.stringify` 拼而不是自己拿 `\u0000` 拼：题目文本里真会出现各种字符，
 *     数组序列化自带转义，组成确定、没有分隔符被撞坏的歧义。
 *   - 开头 `'v1'` 是版本标记：以后改指纹规则时显式升版本，老指纹不会与新指纹混在一起。
 */
export function questionFingerprint(q: QuizQuestion): string {
  return JSON.stringify([
    'v1',
    q.type,
    normalizeForFingerprint(q.groupStem ?? ''),
    normalizeForFingerprint(q.stem),
    q.options.map((o) => normalizeForFingerprint(o)),
    correctIndices(q),
    chaptersOf(q).map((c) => normalizeForFingerprint(c)),
  ]);
}

/**
 * 核心键：与指纹相同，但**不含章节**。
 *
 * 用途只有一个：识别「内容一字不差、只是章节信息多了/变了」的那种题。
 * 章节是题库版本之间最容易变的一项（重新归类、补全「学科·章节」前缀），
 * 若只按全指纹比对，题源更新章节后整库会凭空翻倍 —— 那正是用户抱怨的「重复」。
 */
function coreKey(q: QuizQuestion): string {
  return JSON.stringify([
    'v1',
    q.type,
    normalizeForFingerprint(q.groupStem ?? ''),
    normalizeForFingerprint(q.stem),
    q.options.map((o) => normalizeForFingerprint(o)),
    correctIndices(q),
  ]);
}

/**
 * 允许「只补缺」的字段白名单：靠内容呈现、**不参与判分、也不参与逐题统计**的那些。
 *
 * 为什么 `answer` / `answers` / `options` / `stem` / `type` / `answerText` 不在这里：
 * 它们决定「这道题算对还是算错」。用户已经答过这道题（历史就存在以 id 为键的统计里），
 * 换了答案，过去的对错记录就变成一把错尺子 —— 那是静默改写用户数据，不做。
 * 题干/选项同理：改了之后错题本里记着的「我选的是 B. 原来的文本」会对不上。
 * 章节也不覆盖（只补缺）：章节决定组题筛选与掌握度归属，用户可能按自己的复习计划归过类。
 */
const ENRICHABLE_FIELDS = [
  'explanation',
  'explanations',
  'chapter',
  'chapters',
  'note',
  'image',
  'optionImages',
  'groupStem',
  'groupNo',
  'groupTotal',
  'groupId',
] as const;

/** 值算不算「没有内容」（undefined / null / 空串 / 空数组 / 0 都算） */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return v === 0;
  return false;
}

/**
 * 只补缺、不覆盖：把 `src` 里有内容、而 `prev` 里是空的字段填进去。
 * `prev` 已有内容的字段一律原样留着（用户的数据永远优先）。
 * 返回新对象（纯函数，不改入参）；`changed` 表示真的补了东西，调用方据此判断要不要写库。
 */
function fillMissing(prev: QuizQuestion, src: QuizQuestion): { q: QuizQuestion; changed: boolean } {
  const p = prev as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...p };
  let changed = false;
  for (const key of ENRICHABLE_FIELDS) {
    if (!isEmptyValue(p[key])) continue; // 用户已有内容：不动
    if (isEmptyValue(s[key])) continue; // 新题也没给：不动
    next[key] = s[key];
    changed = true;
  }
  return changed ? { q: next as unknown as QuizQuestion, changed: true } : { q: prev, changed: false };
}

/** 合并结果（供报告区与测试读取）。 */
export interface MergeOutcome {
  /**
   * 合并后的完整题目数组，顺序**确定**：
   * 先按 existing 的原顺序原样保留（界面顺序不抖、用户熟悉的题还在原来的位置），
   * 再把新题按 incoming 的原顺序依次追加；同一条题（指纹相同）以**先出现的那一份**为准。
   */
  questions: QuizQuestion[];
  /** 本次真正新增了几题（报告区「新增 N 题」） */
  added: number;
  /** 因已存在（指纹相同）而跳过、未入库的条数（报告区「已存在 M 题（跳过）」） */
  duplicated: number;
  /** 已存在但这次带来了更全内容、被**只补缺**补全的题数（不是新题，也可能需要写库） */
  enriched: number;
  /**
   * 题干 / 选项 / 答案都相同、但章节与已有题不同的题数。
   * 这类题**按新题入库**（宁可多一条可核对的重复，也不静默丢掉一道题），
   * 但报告里必须点名，用户才能自己判断是不是同一题被重新归类。
   */
  chapterMismatch: number;
}

/**
 * 把 `incoming` 合进 `existing`：已存在的（指纹相同）**一律不重复添加**，新题原样追加。
 *
 * 硬性约束（必须有测试钉住）：**existing 里题目的 id 一个都不动**。
 * 逐题统计（core/qbankStats 的 QStat）、错题本、复习排程、组题（core/qbankCompose）、
 * 软门控、Anki 导出全部以「题库名 + 题目 id」为键；合并时给旧题重新分配 id，
 * 等于把用户的历史答题记录、待复习时间、错题加权整体作废。所以：
 *   - existing 的对象**原样留在返回数组里**（连引用都不换，除非只是补了缺字段）；
 *   - 只有**新进来**的题带自己的新 id（id 由解析层 normalizeQuestions 分配）；
 *   - 只在「新题没带 id」或「新题 id 与已有题撞号」这种手造数据的情况下，
 *     才补一个确定的兜底 id —— id 是逐题统计的键，撞号等于两道题共用一份答题记录。
 *
 * 指纹相同但内容有细微差异（例如解析更全）时怎么办 —— **只补缺、不覆盖**：
 *   existing 里是空的字段（解析 / 章节 / 笔记关联 / 题干图 / 选项图 / 共用题干）用新数据补上，
 *   existing 已有内容的字段一律保留用户那一份。补全不算新增题，计入 `enriched`。
 *   绝不静默替换用户已有的内容。
 *
 * 返回题目数组而不是整个 QuizBank：题库名与 importedAt 不属于「题目合并」的职责，
 * 调用方把结果交回既有的 addBank 写库即可（不新开第二条写库通道）。
 */
export function mergeQuestions(existing: QuizQuestion[], incoming: QuizQuestion[]): MergeOutcome {
  const out = existing.slice();
  // 指纹 / 核心键 → out 里的下标（同一内容只记**首个**出现者：tie-break 明确，顺序才确定）
  const byFingerprint = new Map<string, number>();
  const byCore = new Map<string, number>();
  const usedIds = new Set<string>();
  existing.forEach((q, i) => {
    const fp = questionFingerprint(q);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, i);
    const core = coreKey(q);
    if (!byCore.has(core)) byCore.set(core, i);
    usedIds.add(q.id);
  });

  let added = 0;
  let duplicated = 0;
  let enriched = 0;
  let chapterMismatch = 0;

  for (const q of incoming) {
    const fp = questionFingerprint(q);
    const hit = byFingerprint.get(fp);
    if (hit !== undefined) {
      // 同一道题（连章节都一样）：不重复添加。顺手只补缺（多数是解析/笔记后补的版本）
      const filled = fillMissing(out[hit], q);
      if (filled.changed) {
        out[hit] = filled.q;
        byFingerprint.set(questionFingerprint(filled.q), hit);
        enriched += 1;
      }
      duplicated += 1;
      continue;
    }

    const at = byCore.get(coreKey(q));
    const prev = at === undefined ? undefined : out[at];
    if (at !== undefined && prev && !chaptersOf(prev).length && chaptersOf(q).length) {
      // 内容一字不差，只有已有题**缺**章节：算同一道题，补上章节，不当新题入库。
      // （若不这样，「题源 v2 补了章节」这种更新会让整库凭空翻倍。）
      out[at] = fillMissing(prev, q).q;
      // 补完章节指纹就变了，索引要跟着更新：否则同一批里的第二份还会被当成新题
      byFingerprint.set(questionFingerprint(out[at]), at);
      enriched += 1;
      continue;
    }
    if (prev) chapterMismatch += 1; // 章节不同：按新题入库，报告里点名

    // 新题：id 由解析层分配，这里只做撞号兜底
    let id = q.id;
    let n = out.length;
    while (!id || usedIds.has(id)) id = `${q.id || 'q'}-m${n++}`;
    usedIds.add(id);
    out.push(id === q.id ? q : { ...q, id });
    const appended = out.length - 1;
    byFingerprint.set(fp, appended);
    byCore.set(coreKey(q), appended);
    added += 1;
  }

  return { questions: out, added, duplicated, enriched, chapterMismatch };
}

/**
 * 合并结果 → 一句话报告（贴进导入报告区 / toast）。
 * 只有真的发生了才多说一句，避免「补全 0 题」这种噪音。
 */
export function mergeSummary(res: MergeOutcome): string {
  if (!res.added && !res.duplicated && !res.enriched && !res.chapterMismatch) {
    return '增量导入：这次没有可合并的题目';
  }
  let text = `增量导入：新增 ${res.added} 题，已存在 ${res.duplicated} 题（跳过）`;
  if (res.enriched) text += `，${res.enriched} 题补全了缺失的解析/章节等字段`;
  if (res.chapterMismatch) {
    text += `，另有 ${res.chapterMismatch} 题题干相同但章节不同（已按新题入库，请核对）`;
  }
  return text;
}
