/**
 * 题库练习（三期）：JSON 题库导入 → 随机组卷 → 答错自动进错题本。
 * IndexedDB 存储（与笔记共用浏览器本地优先策略），首次访问迁移旧 localStorage 题库。
 *
 * 题库格式（顶层数组或 { name, questions }）：
 * [
 *   {
 *     "stem": "氧解离曲线右移的意义是？",          // 必填（兼容 question / 题干）
 *     "options": ["容易放氧", "容易结合氧"],       // ≥2 项即选择题（兼容 选项）
 *     "answer": 0,                               // 下标 / "A" / 选项原文（兼容 答案）
 *     "explanation": "……",                       // 选填（兼容 解析）
 *     "image": "_attachments/img-abc123.png",      // 选填：题干图片（vault 相对路径，兼容 图片）
 *     "answers": [0, 2],                          // 选填：多选答案（X 型题）。也接受 "AC"；给了它就按全对才算对
 *     "explanations": [{ "source": "小亮老师版", "text": "……" }],  // 选填：一题多套解析（兼容 jiexiArr）
 *     "chapter": "生理学",                        // 选填（兼容 章节）
 *     "chapters": ["生理学", "心血管"],            // 选填：一题多章节（本题同属这两章；chapter 仍是主章节）
 *     "note": "氧解离曲线",                       // 选填：关联笔记名，错题直达（兼容 笔记）
 *     "optionNotes": ["右移才放氧", "", "", ""]    // 选填：逐选项批注，下标对齐 options（兼容 选项批注）
 *   }
 * ]
 * options 缺失时为简答题：显示答案后自我判定。
 * optionNotes 由应用在作答后写入，随题库一起存进备份，不必手写。
 */

import { getAllBanks, migrateLegacyBanks as migrateBanksToDb, putBank, putBanks, removeBankAndStats } from '../storage/qbank';
import { dropBankStats, initializeStats } from './qbankStats';

export interface QuizQuestion {
  id: string;
  /** choice = 选择题；recall = 简答（显示答案后自判） */
  type: 'choice' | 'recall';
  stem: string;
  /**
   * 题干图片：vault 相对路径（如 `_attachments/img-xxxx.png`），空 = 无图。
   * 只支持**一张题干图**，不支持给每个选项单独配图——选项在数据里是纯字符串数组
   * （`options: string[]`），改成对象会波及导入/导出/批注/统计四处，收益不抵风险。
   */
  image?: string;
  options: string[];
  /** choice：正确项下标（多选时记第一个正确项，全集见 answers） */
  answer: number;
  /**
   * 多选（X 型题）的正确项下标集合：存在即按「全对才算对」判分。
   *
   * 为什么不把 answer 直接改成数组：answer 是既有题库、整包备份、统计与 Anki 导出
   * 都在读的字段，改成数组要一次性迁移全部历史数据与既有单测；而 X 型题在真实考卷里
   * 占比并不高。所以做成**可选增量**：单选语义完全不变，answers 只在多选时出现。
   * 判分统一走本模块的 correctIndices() / isCorrectPick()，调用方不必自己判断。
   */
  answers?: number[];
  /**
   * 一题多套解析（多来源）：同一道题可以有多个老师/教材的讲法，复习时对照着看。
   * 单条解析仍走 `explanation`（既有数据、既有渲染不动）；两者都有时以本字段为准。
   */
  explanations?: Array<{ source: string; text: string }>;
  /** 正确答案文本（choice 自动取选项原文；recall 为答案原文） */
  answerText: string;
  explanation?: string;
  chapter?: string;
  /**
   * 一题可归多个章节/知识点（同业题库的 `zhangjieId[]` 就是这层）。
   * `chapter` 仍是主章节、语义完全不变；本字段是**可选增量**，只在真的给了多章节时才出现。
   */
  chapters?: string[];
  /** 关联笔记名（走 resolveLink 解析，错题本/打开笔记直达） */
  note?: string;
  /** 逐选项批注：下标与 options 对齐，空串表示该选项没写。只在作答后可见可写 */
  optionNotes?: string[];
  /**
   * 逐选项图片：下标与 options 对齐，null = 该选项没有图。
   *
   * 为什么另开一个平行数组、而不是把 options 改成对象数组：options 是既有题库、整包备份、
   * 批注对齐、统计与 Anki 导出都在读的字段，改成对象要一次性迁移全部历史数据与既有单测。
   * 只在真的有图时才带这个键（与 answers / explanations 同一套增量做法）。
   */
  optionImages?: (string | null)[];
  /**
   * 共用题干（A3/A4 病例题）：同一段病例下的若干小问共享这段文字。
   * 每个小问仍是**独立的一道题**（自带 id、独立统计、独立错题记录），只是额外带上
   * 病例原文与自己在组内的序号 —— 这样统计 / 错题本 / FSRS / 导出全都不用改。
   */
  groupStem?: string;
  /** 组内第几问（1 起）；配合 groupTotal 显示「共用题干 · 第 2/3 问」 */
  groupNo?: number;
  /** 该组共几问 */
  groupTotal?: number;
  /** 同组标识：组卷时用它把同组小问排到一起（见 groupTogether） */
  groupId?: string;
}

export interface QuizBank {
  name: string;
  importedAt: number;
  questions: QuizQuestion[];
}

const LEGACY_KEY = 'knowlattice-qbanks';

async function migrateLegacyBanks(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  let banks: QuizBank[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((bank) =>
      Boolean(bank && typeof bank.name === 'string' && Array.isArray(bank.questions))
    )) return;
    banks = parsed as QuizBank[];
  } catch {
    return;
  }
  await migrateBanksToDb(banks);
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // The migrated IndexedDB copy remains authoritative if browser storage is unavailable.
  }
}

export async function loadBanks(): Promise<QuizBank[]> {
  await migrateLegacyBanks();
  return (await getAllBanks()) as QuizBank[];
}

/** 同名题库覆盖导入；返回更新后的题库列表。
 *  重新导入同名题库时按「题干 + 选项」把旧题的选项批注接回新题——批注是用户自己写的，
 *  不能因为拿到一份修订版题库就静默丢掉。 */
export async function addBank(name: string, questions: QuizQuestion[]): Promise<QuizBank[]> {
  const all = await loadBanks();
  const prev = all.find((b) => b.name === name);
  const banks = all.filter((b) => b.name !== name);
  const carried = prev ? noteIndex(prev.questions) : null;
  const merged = carried
    ? questions.map((q) => {
        const notes = q.optionNotes ?? carried.get(questionKey(q));
        return notes ? { ...q, optionNotes: notes } : q;
      })
    : questions;
  banks.unshift({ name, importedAt: Date.now(), questions: merged });
  await putBank(banks[0]);
  return banks;
}

/** 题目内容键：题干 + 选项。同名题库重导时用它把旧批注接回新题。 */
function questionKey(q: QuizQuestion): string {
  return `${q.stem}\u0000${q.options.join('\u0000')}`;
}

/** 内容键 → 非空选项批注 */
function noteIndex(questions: QuizQuestion[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const q of questions) {
    if (q.optionNotes?.some(Boolean)) m.set(questionKey(q), q.optionNotes);
  }
  return m;
}

/** 写某题某个选项的批注（去掉首尾空白后为空即删除该批注）。返回更新后的题库列表。
 *  题库名 / 题号 / 选项下标任一不成立时原样返回，调用方无需先校验。 */
export async function setOptionNote(
  bankName: string,
  questionId: string,
  optionIndex: number,
  text: string
): Promise<QuizBank[]> {
  const banks = await loadBanks();
  const q = banks.find((b) => b.name === bankName)?.questions.find((x) => x.id === questionId);
  const bank = banks.find((b) => b.name === bankName);
  if (!q || !bank || q.type !== 'choice' || optionIndex < 0 || optionIndex >= q.options.length) return banks;
  const notes = q.options.map((_, i) => q.optionNotes?.[i] ?? '');
  notes[optionIndex] = text.trim();
  q.optionNotes = notes.some(Boolean) ? notes : undefined;
  await putBank(bank);
  return banks;
}

export async function removeBank(name: string): Promise<QuizBank[]> {
  const banks = (await loadBanks()).filter((b) => b.name !== name);
  await initializeStats();
  await removeBankAndStats(name);
  await dropBankStats(name, false);
  return banks;
}

/** 导出全部题库（随备份文件保存） */
export async function exportQbanks(): Promise<QuizBank[]> {
  return loadBanks();
}

/** 从备份恢复题库（同名覆盖、其余保留）；返回恢复的题库数 */
export async function importQbanks(state: unknown): Promise<number> {
  if (!Array.isArray(state)) return 0;
  await loadBanks();
  const imported = new Map<string, QuizBank>();
  for (const raw of state) {
    const b = raw as Partial<QuizBank>;
    if (!b || typeof b.name !== 'string' || !Array.isArray(b.questions)) continue;
    imported.set(b.name, {
      name: b.name,
      importedAt: typeof b.importedAt === 'number' ? b.importedAt : Date.now(),
      questions: b.questions as QuizQuestion[],
    });
  }
  await putBanks([...imported.values()]);
  return imported.size;
}

// ---------- 导入解析（宽松：兼容中英文字段名） ----------

function firstOf<T>(o: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k] as T;
  }
  return undefined;
}

/** 多章节字段的候选键（同业题库各有写法）。数组与分隔字符串两种值都收。 */
const CHAPTER_LIST_KEYS = ['chapters', 'chapterList', '章节s', '多章节', '知识点'];

/**
 * 单个字段值 → 章节列表：数组（`["生理学","心血管"]`）与分隔字符串（`"生理学、心血管"`）都吃，
 * 去空白、去重、保序。解析不出内容返回 `[]`——调用方据此决定**不带** `chapters` 这个键，
 * 让既有对象的形状一字不变。
 */
function uniqChapters(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (x: unknown) => {
    const s = String(x ?? '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(raw)) for (const x of raw) push(x);
  else if (typeof raw === 'string') for (const part of raw.split(/[,，、;]/)) push(part);
  return out;
}

/** 逐条导入时的多章节：第一个解析出内容的候选键为准；都没有则 `[]`。 */
function chaptersFrom(src: Record<string, unknown>): string[] {
  for (const k of CHAPTER_LIST_KEYS) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    const out = uniqChapters(v);
    if (out.length) return out;
  }
  return [];
}

/** "B" / "b" / 0 / "容易放氧" → 正确项下标 */
function answerIndex(raw: unknown, options: string[]): number {
  if (typeof raw === 'number' && raw >= 0 && raw < options.length) return raw;
  const s = String(raw ?? '').trim();
  // 字母答案常带标点/空格：B / B. / B、 / B.
  const letter = /^([A-Za-z])\s*[.、．)）:：]?\s*$/.exec(s);
  if (letter) return letter[1].toUpperCase().charCodeAt(0) - 65;
  const byText = options.findIndex((o) => o.trim() === s.replace(/^[A-Za-z][.、]\s*/, ''));
  return byText;
}

/** 选项批注归一：截到选项数、补齐缺位、去掉空白项；全空时返回 undefined（不留空数组）。 */
function alignNotes(raw: unknown, count: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const notes = Array.from({ length: count }, (_, i) => String(raw[i] ?? '').trim());
  return notes.some(Boolean) ? notes : undefined;
}

/**
 * 多选答案 → 正确项下标集合（去重升序、越界丢弃）。
 * 识别 `"ABC"` / `"A、C"` / `"A B"` / `["A","C"]` / `[0,2]` / 选项原文。
 */
export function answerIndices(raw: unknown, options: string[]): number[] {
  const out = new Set<number>();
  const push = (v: unknown) => {
    const i = answerIndex(v, options);
    if (i >= 0 && i < options.length) out.add(i);
  };
  if (Array.isArray(raw)) {
    for (const v of raw) push(v);
  } else if (typeof raw === 'number') {
    push(raw);
  } else {
    const s = String(raw ?? '').trim();
    // 连续字母串（ABC / A、C / A;B）拆成单个字母逐个解析；
    // 单个字母（"B."）与选项原文仍交给 answerIndex——它们各有既定写法，拆开反而会错。
    const compact = s.replace(/[\s、,，;；/|.．)）:：]/g, '');
    if (compact.length > 1 && /^[A-Za-z]+$/.test(compact)) for (const ch of compact) push(ch);
    else push(s);
  }
  return [...out].sort((a, b) => a - b);
}

/** 正确项下标集合：多选看 answers，其余看 answer（-1 = 无正确项） */
export function correctIndices(q: QuizQuestion): number[] {
  if (q.answers && q.answers.length) return [...q.answers].sort((a, b) => a - b);
  return q.answer >= 0 ? [q.answer] : [];
}

/** 是否多选题（X 型）：answers 里有两个以上正确项。界面据此切换「点一下即判定」/「选完再交卷」 */
export function isMultiSelect(q: QuizQuestion): boolean {
  return Boolean(q.answers && q.answers.length > 1);
}

/**
 * 作答判定：**全对才算对**。
 * 少选、多选、错选一律算错 —— 与机考 X 型题的判分一致（不给部分分），
 * 也避免"少选就算对"把统计里的正确率抬高。
 */
export function isCorrectPick(q: QuizQuestion, picked: number[]): boolean {
  const right = correctIndices(q);
  if (!right.length) return false;
  const mine = [...new Set(picked)].sort((a, b) => a - b);
  return mine.length === right.length && mine.every((v, k) => v === right[k]);
}

/** 这道题的章节列表：有多章节就用它（已去重去空），否则退回 `[chapter]`；都没有则 `[]`。
 *  这条是"单值口径兼容"的关键：没有 chapters 时返回的数组内容与旧行为逐字相同。 */
export function chaptersOf(q: QuizQuestion): string[] {
  const multi = uniqChapters(q.chapters);
  if (multi.length) return multi;
  return q.chapter ? [q.chapter] : [];
}

/** 这份 JSON 是不是「整库备份」（笔记数据）？
 *  用户极容易把备份文件当成题库文件导入（文件名叫「…题库.json」而入口叫「题库练习」），
 *  所以报错不能只说「格式不对」，必须直接告诉他该走哪个入口。 */
function looksLikeVaultBackup(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return Array.isArray(o.files) && ('exportedAt' in o || typeof o.version === 'number');
}

/** 任意结构 → QuizQuestion[]；格式非法时抛错（信息面向使用者） */
export function normalizeQuestions(raw: unknown): QuizQuestion[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).questions)
      ? (raw as { questions: unknown[] }).questions
      : null;
  if (!list) {
    if (looksLikeVaultBackup(raw)) {
      throw new Error(
        '这是一份「笔记备份」，不是题库文件。要导入它，请用笔记树右上角 ⋯ →「从备份 .json 恢复」；' +
          '这里只吃题库格式，形如 {"name":"…","questions":[…]}（题库文件见 knowlattice-题库/ 目录）。'
      );
    }
    throw new Error('题库格式：JSON 数组，或含 questions 数组的对象');
  }
  const out: QuizQuestion[] = [];

  /**
   * 由一个条目对象构造题目；构造不出来返回 null（调用方据此跳过）。
   * 抽成局部函数的目的：A3/A4 的**小问**与普通题必须走完全相同的解析规则。
   * 两套逻辑一定会漂移（"普通题认得、小问不认得"这类不一致最难查）。
   * id 由调用方传入：小问要带组内序号，不能让每个条目自己按数组下标推——展开后会撞号，
   * 而 id 是逐题统计的键，撞了等于两个小问共用一份答题记录。
   */
  const buildOne = (
    src: Record<string, unknown>,
    id: string,
    group?: { stem: string; no: number; total: number; groupId: string }
  ): QuizQuestion | null => {
    const stem = firstOf<string>(src, ['stem', 'question', '题干', '题目']);
    if (!stem || !String(stem).trim()) return null; // 无题干的条目跳过
    const image = firstOf<string>(src, ['image', 'img', '图片', '图片路径', '题图']);
    const { texts: options, images: optImages } = optionsFrom(firstOf<unknown>(src, ['options', 'choices', '选项']));
    const rawAnswer = firstOf<unknown>(src, ['answer', 'correct', '答案', '正确答案']);
    const rawAnswers = firstOf<unknown>(src, ['answers', 'correctAnswers', '多选答案']);
    const explanation = firstOf<string>(src, ['explanation', '解析', '解释']);
    const chapter = firstOf<string>(src, ['chapter', '章节', '科目']);
    // 一题多章节（可选增量）：只在真的解析出 ≥2 个章节时才带上这个键，形状与既有题一致
    const chapters = chaptersFrom(src);
    const note = firstOf<string>(src, ['note', '笔记', '相关笔记']);
    const rawNotes = firstOf<string[]>(src, ['optionNotes', '选项批注']);
    const explanations = explanationsFrom(src);
    // 选项图片：显式的 optionImages 数组优先，缺位回落到「选项写成 { text, image }」里的那张
    const rawImgs = firstOf<unknown>(src, ['optionImages', '选项图片', 'optionImgs']);
    const optionImages = options.map((_, k) => {
      const explicit = Array.isArray(rawImgs) ? rawImgs[k] : undefined;
      if (explicit && String(explicit).trim()) return String(explicit).trim();
      return optImages[k] ?? null;
    });
    const base = {
      id,
      stem: String(stem).trim(),
      explanation: explanation ? String(explanation) : undefined,
      // 一题多套解析：只在真的解析出内容时才带上，不留空数组
      explanations: explanations.length ? explanations : undefined,
      // 单值 chapter 的语义完全不变；只有"给了多章节却没给单值 chapter"时才用首个补齐——
      // 否则多章节的题会因为 chapter 为空而整章消失在掌握度热力图与错题归位里。
      chapter: chapter ? String(chapter) : (chapters[0] ?? undefined),
      ...(chapters.length >= 2 ? { chapters } : {}),
      note: note ? String(note).trim() : undefined,
      image: image && String(image).trim() ? String(image).trim() : undefined,
      // 共用题干题组：普通题**不带这些键**，既有对象的形状与既有单测完全不变
      ...(group
        ? { groupStem: group.stem, groupNo: group.no, groupTotal: group.total, groupId: group.groupId }
        : {}),
    };
    // 答案解析：answers 字段优先（Excel 与多选题库用它），否则退回 answer。
    // 单值、数组、连续字母串（"ABC"）都走 answerIndices，多选自然得到多个下标。
    // 空数组/空串要当作"没给"：`??` 只挡 null/undefined，而导出器常把没有多选答案的题
    // 写成 `answers: []`，那会把同一题里有效的 answer 顶掉（多选题库与单选混编时最常见）。
    const answersGiven =
      rawAnswers !== undefined &&
      !(Array.isArray(rawAnswers) && rawAnswers.length === 0) &&
      !(typeof rawAnswers === 'string' && !rawAnswers.trim());
    const picked = options.length >= 2 ? answerIndices(answersGiven ? rawAnswers : rawAnswer, options) : [];
    if (picked.length >= 1) {
      const notes = alignNotes(rawNotes, options.length);
      const multi = picked.length > 1;
      return {
        ...base,
        type: 'choice',
        options,
        answer: picked[0],
        // 单选用 answer 就够了；多选才补 answers（见 QuizQuestion.answers 的注释）
        ...(multi ? { answers: picked } : {}),
        // 单选保持旧语义：answerText 就是选项原文（既有题库、单测、Anki 导出都按这个读）
        answerText: multi
          ? picked.map((k) => `${String.fromCharCode(65 + k)}. ${options[k]}`).join('；')
          : options[picked[0]],
        ...(notes ? { optionNotes: notes } : {}),
        // 只有真的挂了图才带这个键（全 null 时不留空数组）
        ...(optionImages.some(Boolean) ? { optionImages } : {}),
      };
    }
    if (rawAnswer !== undefined && String(rawAnswer).trim()) {
      // 无有效选项 → 简答
      return { ...base, type: 'recall', options: [], answer: -1, answerText: String(rawAnswer).trim() };
    }
    return null;
  };

  list.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) return;
    const o = item as Record<string, unknown>;
    const caseStem = firstOf<string>(o, ['stem', 'question', '题干', '题目']);
    const subs = subQuestionsOf(o);
    // A3/A4 共用题干：一段病例 + 若干小问。**每个小问仍是一道独立的题**（自带 id），
    // 所以逐题统计、错题本、FSRS 排程、Anki 导出全都照旧，
    // 只是额外带上病例原文与自己在组内的序号（见 QuizQuestion.groupStem 的注释）。
    if (subs.length >= 1) {
      const caseText = caseStem && String(caseStem).trim() ? String(caseStem).trim() : '';
      const groupId = `g-${Date.now().toString(36)}-${i}`;
      const chapter0 = firstOf<string>(o, ['chapter', '章节', '科目']);
      const before = out.length;
      subs.forEach((sub, k) => {
        const q = buildOne(
          {
            ...sub,
            // 小问没写题干时用「第 n 问」兜底：否则会被当成"无题干条目"整条丢掉，
            // 用户看到的是"导入了 3 问只出现 2 问"这种最难归因的静默丢数据。
            stem: firstOf<string>(sub, ['stem', 'question', '题干', '题目']) || `第 ${k + 1} 问`,
            chapter: firstOf<string>(sub, ['chapter', '章节', '科目']) ?? chapter0,
          },
          `q-${Date.now().toString(36)}-${i}-${k}`,
          // 外层没有题干文字就不算"共用题干"：各小问按独立题处理，不塞一个空的病例框
          caseText ? { stem: caseText, no: k + 1, total: subs.length, groupId } : undefined
        );
        if (q) out.push(q);
      });
      // 只有当小问**真的**展开成题时才结束这条；否则外层那一道题会被白白吞掉——
      // `children` / `sub` 是相当常见的字段名，别人用它装别的东西时不能把整道题丢掉。
      if (out.length > before) return;
    }
    const q = buildOne(o, `q-${Date.now().toString(36)}-${i}`);
    if (q) out.push(q);
  });
  if (out.length === 0) throw new Error('未解析出有效题目（每题至少需要题干和答案）');
  return out;
}

/** 解析「题库 JSON 文本」→ 题库名 + 题目；所有失败都抛面向使用者的中文说明。
 *  放在 core 而不是视图里：这条错误信息是用户唯一能看到的线索，必须能被测到。 */
export function parseQbankJson(text: string, fallbackName: string): { name: string; questions: QuizQuestion[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('这个文件不是有效的 JSON（可能没下载完整，或选错了文件）。题库文件形如 {"name":"…","questions":[…]}。');
  }
  const questions = normalizeQuestions(raw);
  const named =
    !Array.isArray(raw) && typeof raw === 'object' && raw !== null
      ? (raw as { name?: unknown }).name
      : undefined;
  const name = typeof named === 'string' && named.trim() ? named.trim() : fallbackName;
  return { name, questions };
}

/** 从纯文本（Word 抽取 / 粘贴）启发式解析题目。
 *  支持常见排版：`1. 题干` → 选项 `A. x`（可同一行 `A.x B.y C.z`）→ `答案：A` → `解析：…`。
 *  无法识别的行会被跳过；返回 0 道时由调用方决定回退（把原文交给用户整理）。 */
export function parseQuestionsFromText(text: string): QuizQuestion[] {
  const lines = text.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const raws: Array<{ stem: string; options: string[]; answer?: string; explanation?: string; chapter?: string; note?: string }> = [];
  let cur: (typeof raws)[number] | null = null;
  const push = () => { if (cur && cur.stem) raws.push(cur); cur = null; };
  const isNew = (line: string) => /^\s*\d+\s*[.、．)）]/.test(line);
  const OPT_RE = /^([A-Ha-h])\s*[.、．)）:]?\s*(\S.*)$/;

  /** 一行内联选项后常见的答案/解析标记（`答案：B`、`解析：…`），选项文本到此截断 */
  const META_MARK = /(?:答案|正确答案|标准答案|解析|解释|分析|章节|科目|笔记)\s*[:：]/;

  /** 从一行里抽出 ≥2 个的内联选项（`A.x B.y C.z`），返回题干 + 选项数组 + 选项结束位置；<2 个回 null。
   *  选项文本在答案/解析标记处截断；同行 `答案：B` 会一并带出。 */
  const splitInline = (
    line: string
  ): { stem: string; options: string[]; end: number; answer?: string } | null => {
    const re = /\b([A-Ha-h])\s*[.、．)）:]\s*([^\n]*?)(?=\s+[A-Ha-h]\s*[.、．)）:]\s*|\s*$)/g;
    const parts: Array<{ letter: string; text: string; idx: number; end: number }> = [];
    let answer: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const letter = m[1].toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      if (idx < 0 || idx > 7) continue;
      // 最后一个选项的匹配会把 `答案：B / 解析：…` 一并吞入，先剥离再截断
      if (!answer) {
        const meta = /(?:答案|正确答案|标准答案)\s*[:：]?\s*(\S.*)$/.exec(m[2]);
        if (meta) answer = meta[1].split(/\s+(?:解析|解释|分析)\s*[:：]/)[0].trim();
      }
      const text = m[2].split(META_MARK)[0].trim();
      parts.push({ letter, text, idx: m.index, end: m.index + m[0].length });
    }
    if (parts.length < 2) return null;
    const options: string[] = [];
    for (const p of parts) options[p.letter.charCodeAt(0) - 65] = p.text;
    return { stem: line.slice(0, parts[0].idx).trim(), options, end: parts[parts.length - 1].end, ...(answer ? { answer } : {}) };
  };

  for (const line of lines) {
    // 答案 / 解析 / 章节 / 笔记行
    if (cur) {
      const am = /^(答案|正确答案|标准答案)\s*[:：]\s*(\S.*)$/.exec(line);
      if (am) { cur.answer = am[2].trim(); continue; }
      const em = /^(解析|解释|分析)\s*[:：]\s*(\S.*)$/.exec(line);
      if (em) { cur.explanation = em[2].trim(); continue; }
      const cm = /^(章节|科目)\s*[:：]\s*(\S.*)$/.exec(line);
      if (cm) { cur.chapter = cm[2].trim(); continue; }
      const nm = /^(笔记|关联笔记)\s*[:：]\s*(\S.*)$/.exec(line);
      if (nm) { cur.note = nm[2].trim(); continue; }
    }
    const inline = splitInline(line);
    if (inline) {
      push(); // 内联选项通常就是一道完整题
      cur = { stem: inline.stem.replace(/^\s*\d+\s*[.、．)）]\s*/, ''), options: inline.options };
      // 同行的 `答案：B / 解析：…` 归队（如 `1. 题干 A.x B.y 答案：B`）
      if (inline.answer) cur.answer = inline.answer;
      const tail = line.slice(inline.end);
      const im = /^(?:\s*)(答案|正确答案|标准答案)\s*[:：]?\s*(\S.*)$/.exec(tail);
      if (im) cur.answer = im[2].trim();
      continue;
    }
    if (isNew(line)) {
      push();
      cur = { stem: line.replace(/^\s*\d+\s*[.、．)）]\s*/, ''), options: [] };
      continue;
    }
    const om = OPT_RE.exec(line);
    if (cur && om) {
      const idx = om[1].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < 8) { cur.options[idx] = om[2].trim(); continue; }
    }
    // 其余行并入题干（续行说明）
    if (cur) { if (!cur.stem) cur.stem = line; else if (!cur.answer) cur.stem += ' ' + line; }
  }
  push();

  const out: QuizQuestion[] = [];
  for (const r of raws) {
    const opts = r.options.filter(Boolean);
    const ansRaw = r.answer?.trim();
    // 多选与单选走同一个解析器：多字母串（"ABC" / "A、C"）会得到多个下标
    const picked = opts.length >= 2 && ansRaw ? answerIndices(ansRaw, opts) : [];
    let type: QuizQuestion['type'] = 'recall';
    let answer = -1;
    let answerText = ansRaw || '';
    if (picked.length === 1) {
      type = 'choice';
      answer = picked[0];
      answerText = opts[picked[0]];
    } else if (picked.length > 1) {
      type = 'choice';
      answer = picked[0]; // 多选也把第一个正确项记在 answer 上，全集进 answers
      answerText = picked.map((k) => `${String.fromCharCode(65 + k)}. ${opts[k]}`).join('；');
    }
    if (!answerText) continue; // 无答案跳过
    out.push({
      id: `q-${Date.now().toString(36)}-${out.length}`,
      stem: r.stem.trim(),
      type,
      options: type === 'choice' ? opts : [],
      answer,
      ...(picked.length > 1 ? { answers: picked } : {}),
      answerText,
      explanation: r.explanation,
      chapter: r.chapter,
      note: r.note,
    });
  }
  return out;
}

/** 收集一行（SheetJS 对象行）里的选项列。
 *  兼容：`options` 数组列；或 A/B/C/D、选项1..4、option1..4 等列，按常见顺序取值。 */
function columnOptions(r: Record<string, unknown>): string[] {
  const arr = r['options'];
  if (Array.isArray(arr)) return arr.map(String);
  const keys = ['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd', '选项A', '选项B', '选项C', '选项D', '选项1', '选项2', '选项3', '选项4', 'option1', 'option2', 'option3', 'option4', '1', '2', '3', '4'];
  const out: string[] = [];
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out.push(String(v).trim());
  }
  return out;
}

/** Excel/CSV（SheetJS sheet_to_json 的结果：对象行数组）→ 题目。
 *  表头可用中文/英文：题干/题目/stem、答案/correct、解析、章节、笔记，选项列见 columnOptions。 */
export function rowsToQuestions(rows: Array<Record<string, unknown>>): QuizQuestion[] {
  const mapped = rows.map((r) => ({
    stem: firstOf<string>(r, ['stem', 'question', '题干', '题目']),
    image: firstOf<string>(r, ['image', 'img', '图片', '图片路径', '题图']),
    options: columnOptions(r),
    answer: firstOf<unknown>(r, ['answer', 'correct', '答案', '正确答案']),
    answers: firstOf<unknown>(r, ['answers', 'correctAnswers', '多选答案']),
    // 多章节与多套解析也要能从表格进来：否则"Excel 进来的题"与"JSON 进来的题"会分叉
    // （同一个功能在不同入口表现不同，是最难解释给用户听的一类不一致）。
    chapters: firstOf<unknown>(r, ['chapters', 'chapterList', '多章节', '知识点']),
    explanation: firstOf<string>(r, ['explanation', '解析', '解释']),
    explanations: firstOf<unknown>(r, ['explanations', 'jiexiArr', '解析集', '多解']),
    chapter: firstOf<string>(r, ['chapter', '章节', '科目']),
    note: firstOf<string>(r, ['note', '笔记', '相关笔记']),
  }));
  return normalizeQuestions(mapped); // 无有效题会抛错
}

/**
 * 从题库随机抽 n 题（Fisher-Yates）。
 * 抽出后再走一次 groupTogether：带 groupId 的题（A3/A4 共用题干）会被排到一起、
 * 按组内序号升序 —— 同一个病例的几问散落在卷子里，会让人反复读同一段病例。
 */
export function pickQuestions(bank: QuizBank, n?: number): QuizQuestion[] {
  const qs = [...bank.questions];
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  return groupTogether(n && n < qs.length ? qs.slice(0, n) : qs);
}

/**
 * 把同组小问聚到一起、并按组内序号升序（纯函数，可单测）。
 * 组与组之间、以及未分组的题之间，都保持原本的相对顺序（稳定）。
 * **不带 groupId 的输入原样返回同一个数组引用** —— 既有题库在这条路径上零代价、零变化。
 */
export function groupTogether(qs: QuizQuestion[]): QuizQuestion[] {
  if (!qs.some((q) => q.groupId)) return qs;
  const out: QuizQuestion[] = [];
  const done = new Set<string>();
  for (const q of qs) {
    if (!q.groupId) {
      out.push(q);
      continue;
    }
    if (done.has(q.groupId)) continue; // 该组已经整组放过了
    done.add(q.groupId);
    out.push(
      ...qs
        .filter((x) => x.groupId === q.groupId)
        .sort((a, b) => (a.groupNo ?? 0) - (b.groupNo ?? 0))
    );
  }
  return out;
}

/** 把「结构化解析」的任意写法收敛成纯文本：字符串 / `[{type,content}]` / `{content}` / `{analysis}` */
function analysisTextOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    return v
      .map(analysisTextOf)
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content.trim();
    if (o.analysis !== undefined) return analysisTextOf(o.analysis);
    if (o.text !== undefined) return analysisTextOf(o.text);
  }
  return '';
}

/**
 * 从原始条目里取出「来源 → 解析文本」列表；解析不出就返回空数组。
 *
 * 依据：同业的备考 App 里题目是**一题多解析**的——窦起心搏的 `jiexiArr` 就是
 * `{ 老师名: { analysis: [{type,content}], jiangyi, daotu, jypage } }`，
 * 同一道题在不同老师手下讲法不同，学生本来就要对照着看。
 * 本项目此前只有一个 `explanation` 字段，换一份解析只能覆盖上一份。
 *
 * 兼容三种写法：
 *   - `explanations: [{ source: '小亮老师版', text: '…' }]`（推荐）
 *   - `explanations: { '小亮老师版': '…' }`（键值映射）
 *   - `jiexiArr: { '小亮老师版': { analysis: [{type,content}] } }`（同业题库直投）
 */
export function explanationsFrom(o: Record<string, unknown>): Array<{ source: string; text: string }> {
  const raw = firstOf<unknown>(o, ['explanations', 'jiexiArr', '解析集', '多解']);
  const out: Array<{ source: string; text: string }> = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (v && typeof v === 'object') {
        const e = v as Record<string, unknown>;
        const source =
          typeof e.source === 'string' ? e.source.trim() : typeof e.name === 'string' ? e.name.trim() : '';
        const text = analysisTextOf(e.text ?? e.analysis ?? e);
        if (text) out.push({ source, text });
      } else {
        const text = analysisTextOf(v);
        if (text) out.push({ source: '', text });
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [source, v] of Object.entries(raw as Record<string, unknown>)) {
      const text = analysisTextOf(v);
      if (text) out.push({ source: source.trim(), text });
    }
  }
  return out;
}

/**
 * 这道题的全部解析（按来源）。
 * 只有单条 `explanation` 时也返回它 —— 调用方不必分两路渲染（一条解析就是"无来源"的那一条）。
 */
export function explanationsOf(q: QuizQuestion): Array<{ source: string; text: string }> {
  if (q.explanations && q.explanations.length) return q.explanations;
  return q.explanation ? [{ source: '', text: q.explanation }] : [];
}

/**
 * 选项归一：既吃字符串数组，也吃 `[{ text, image }]` 对象数组（对象写法可以给单个选项挂图）。
 * 返回的 `images` 与 `texts` 下标对齐，缺图处为 null。
 *
 * 兼容说明：字符串数组的行为与旧的 `rawOptions.map(String)` **逐字一致**；
 * 旧代码遇到对象会得到 "[object Object]" 这种垃圾文本，所以这里改成解析对象不是回归。
 */
function optionsFrom(raw: unknown): { texts: string[]; images: (string | null)[] } {
  const texts: string[] = [];
  const images: (string | null)[] = [];
  if (!Array.isArray(raw)) return { texts, images };
  for (const v of raw) {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const text = firstOf<string>(o, ['text', 'content', 'label', '选项']);
      const img = firstOf<string>(o, ['image', 'img', '图片']);
      texts.push(String(text ?? '').trim());
      images.push(img && String(img).trim() ? String(img).trim() : null);
    } else {
      texts.push(String(v));
      images.push(null);
    }
  }
  return { texts, images };
}

/**
 * 共用题干的子题数组（A3/A4 病例题）。
 * 只有 ≥2 条才算题组——单条子题没有"共用"可言，按普通题处理更好读。
 */
function subQuestionsOf(o: Record<string, unknown>): Record<string, unknown>[] {
  const raw = firstOf<unknown>(o, ['sub', 'subs', 'subQuestions', 'children', '小问', '子题']);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object');
}
