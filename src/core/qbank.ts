/**
 * 题库练习（三期）：JSON 题库导入 → 随机组卷 → 答错自动进错题本。
 * localStorage 轻量存储（与错题本同策略），不引后端。
 *
 * 题库格式（顶层数组或 { name, questions }）：
 * [
 *   {
 *     "stem": "氧解离曲线右移的意义是？",          // 必填（兼容 question / 题干）
 *     "options": ["容易放氧", "容易结合氧"],       // ≥2 项即选择题（兼容 选项）
 *     "answer": 0,                               // 下标 / "A" / 选项原文（兼容 答案）
 *     "explanation": "……",                       // 选填（兼容 解析）
 *     "chapter": "生理学",                        // 选填（兼容 章节）
 *     "note": "氧解离曲线"                        // 选填：关联笔记名，错题直达（兼容 笔记）
 *   }
 * ]
 * options 缺失时为简答题：显示答案后自我判定。
 */

export interface QuizQuestion {
  id: string;
  /** choice = 选择题；recall = 简答（显示答案后自判） */
  type: 'choice' | 'recall';
  stem: string;
  options: string[];
  /** choice：正确项下标 */
  answer: number;
  /** 正确答案文本（choice 自动取选项原文；recall 为答案原文） */
  answerText: string;
  explanation?: string;
  chapter?: string;
  /** 关联笔记名（走 resolveLink 解析，错题本/打开笔记直达） */
  note?: string;
}

export interface QuizBank {
  name: string;
  importedAt: number;
  questions: QuizQuestion[];
}

const KEY = 'knowlattice-qbanks';

export function loadBanks(): QuizBank[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as QuizBank[];
  } catch {
    return [];
  }
}

function persist(banks: QuizBank[]) {
  localStorage.setItem(KEY, JSON.stringify(banks));
}

/** 同名题库覆盖导入；返回更新后的题库列表 */
export function addBank(name: string, questions: QuizQuestion[]): QuizBank[] {
  const banks = loadBanks().filter((b) => b.name !== name);
  banks.unshift({ name, importedAt: Date.now(), questions });
  persist(banks);
  return banks;
}

export function removeBank(name: string): QuizBank[] {
  const banks = loadBanks().filter((b) => b.name !== name);
  persist(banks);
  return banks;
}

/** 导出全部题库（随备份文件保存） */
export function exportQbanks(): QuizBank[] {
  return loadBanks();
}

/** 从备份恢复题库（同名覆盖、其余保留）；返回恢复的题库数 */
export function importQbanks(state: unknown): number {
  if (!Array.isArray(state)) return 0;
  const existing = loadBanks();
  const merged = new Map(existing.map((b) => [b.name, b]));
  let n = 0;
  for (const raw of state) {
    const b = raw as Partial<QuizBank>;
    if (!b || typeof b.name !== 'string' || !Array.isArray(b.questions)) continue;
    merged.set(b.name, {
      name: b.name,
      importedAt: typeof b.importedAt === 'number' ? b.importedAt : Date.now(),
      questions: b.questions as QuizQuestion[],
    });
    n++;
  }
  persist([...merged.values()]);
  return n;
}

// ---------- 导入解析（宽松：兼容中英文字段名） ----------

function firstOf<T>(o: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k] as T;
  }
  return undefined;
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

/** 任意结构 → QuizQuestion[]；格式非法时抛错（信息面向使用者） */
export function normalizeQuestions(raw: unknown): QuizQuestion[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).questions)
      ? (raw as { questions: unknown[] }).questions
      : null;
  if (!list) throw new Error('题库格式：JSON 数组，或含 questions 数组的对象');
  const out: QuizQuestion[] = [];
  list.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) return;
    const o = item as Record<string, unknown>;
    const stem = firstOf<string>(o, ['stem', 'question', '题干', '题目']);
    if (!stem || !String(stem).trim()) return; // 无题干的条目跳过
    const rawOptions = firstOf<string[]>(o, ['options', 'choices', '选项']);
    const options = Array.isArray(rawOptions) ? rawOptions.map((x) => String(x)) : [];
    const rawAnswer = firstOf<string | number>(o, ['answer', 'correct', '答案', '正确答案']);
    const explanation = firstOf<string>(o, ['explanation', '解析', '解释']);
    const chapter = firstOf<string>(o, ['chapter', '章节', '科目']);
    const note = firstOf<string>(o, ['note', '笔记', '相关笔记']);
    const base = {
      id: `q-${Date.now().toString(36)}-${i}`,
      stem: String(stem).trim(),
      explanation: explanation ? String(explanation) : undefined,
      chapter: chapter ? String(chapter) : undefined,
      note: note ? String(note).trim() : undefined,
    };
    if (options.length >= 2 && rawAnswer !== undefined && answerIndex(rawAnswer, options) >= 0) {
      const ai = answerIndex(rawAnswer, options);
      out.push({ ...base, type: 'choice', options, answer: ai, answerText: options[ai] });
    } else if (rawAnswer !== undefined && String(rawAnswer).trim()) {
      // 无有效选项 → 简答
      out.push({ ...base, type: 'recall', options: [], answer: -1, answerText: String(rawAnswer).trim() });
    }
  });
  if (out.length === 0) throw new Error('未解析出有效题目（每题至少需要题干和答案）');
  return out;
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
    let type: QuizQuestion['type'] = 'recall';
    let answer = -1;
    let answerText = ansRaw || '';
    if (opts.length >= 2 && ansRaw) {
      const ai = answerIndex(ansRaw, opts);
      if (ai >= 0) { type = 'choice'; answer = ai; answerText = opts[ai]; }
    }
    if (!answerText) continue; // 无答案跳过
    out.push({
      id: `q-${Date.now().toString(36)}-${out.length}`,
      stem: r.stem.trim(),
      type,
      options: type === 'choice' ? opts : [],
      answer,
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
    options: columnOptions(r),
    answer: firstOf<string | number>(r, ['answer', 'correct', '答案', '正确答案']),
    explanation: firstOf<string>(r, ['explanation', '解析', '解释']),
    chapter: firstOf<string>(r, ['chapter', '章节', '科目']),
    note: firstOf<string>(r, ['note', '笔记', '相关笔记']),
  }));
  return normalizeQuestions(mapped); // 无有效题会抛错
}

/** 从题库随机抽 n 题（Fisher-Yates） */
export function pickQuestions(bank: QuizBank, n?: number): QuizQuestion[] {
  const qs = [...bank.questions];
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  return n && n < qs.length ? qs.slice(0, n) : qs;
}
