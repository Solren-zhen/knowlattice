/**
 * 别人导出的题库 JSON → 我们自己的题目形状（**通用映射**，不逐家硬编码）。
 *
 * ## 为什么这么做
 *
 * 1) **不逐家硬编码**：导出格式是各家 App 自己的序列化结果，而且会随版本变（同一家前后两版
 *    都可能改键名）。写成一串 `if (是万川) … else if (是窦起心搏) …` 的适配器，等于把
 *    「用户数 × 版本数」种格式固进代码，永远追不上；判断「是哪一家」最靠不住的恰恰是文件名 /
 *    题库名这类元信息。所以这里只做两件事：**形状探测**（一组字段候选规则，谁命中多按谁解析）
 *    与 **字段候选映射**（同一个语义列若干候选键，第一个有内容的胜出）。新格式只要字段名落在
 *    候选表里就能直接吃进来。
 * 2) **探测失败必须报「期望字段」**：用户手里是一份「打不开」的文件，唯一能自救的线索就是
 *    「我缺哪个字段」。所以 `unknown` 时 `items: []`，并在 `skipped` / `evidence` 里写出期望的
 *    字段名（例如「没找到题干字段（期望 stem/question/题干/题目/s/title/tktitle）」）——宁可明确
 *    报告命中 0 条，也不猜着塞进一堆空题。
 * 3) **产出只用既有字段名**：产物会直接喂给 `core/qbank` 的 `normalizeQuestions`，走与本项目题库
 *    完全相同的解析路径（选项图片、多选判分、A3/A4 题组展开、面向用户的错误提示都不必重写）。
 *    因此产出只用这套**已支持**的字段名：stem / options / answer / answers / image / optionImages /
 *    explanation / explanations / chapter / chapters / note / groupStem / groupNo / groupTotal / sub。
 *    认不出来的键一律丢弃：塞进自定义键没有任何一处会读它，却会被导出、统计、Anki 同步一路带着，
 *    纯属往用户的题库里存垃圾。同理简答**不产出 `answerText`**——`normalizeQuestions` 在无有效选项时
 *    会用 `answer` / `正确答案` 的值当 `answerText`，所以简答只产出 `{ stem, answer: <答案文本> }`。
 * 4) **保守解析（宁少不多）**：取不出题干 → 跳过并说明；选项不足 2 项 → 落成简答；落不成简答
 *    （答案只有下标、没有可读文本）→ 跳过并说明。少导入一条能看见原因，比多一条垃圾可解释得多。
 * 5) **零项目依赖**：只 import 标准库（其实一条都不 import）。`core/qbank` 的导入流程要调用本模块，
 *    反向 import 会成环，所以字段别名表在本文件里复制了一份小表——宁可重复也不引环。
 *
 * 纯函数：不碰 DOM / localStorage / 文件，输入输出都是普通 JS 值（可单测、可在 Worker 里跑）。
 */

/** 探测到的形状：本项目格式 / 短键题库（万川医考风格）/ 富文本题库（窦起心搏风格）/ 未识别 */
export type SchemaKind = 'native' | 'short-keys' | 'rich-blocks' | 'unknown';

/** 形状探测结果 */
export interface Detection {
  kind: SchemaKind;
  /** 0-1；用于界面显示「这份文件有多像某个格式」 */
  confidence: number;
  /** 命中的依据（中文，给出命中的字段名），用于界面解释「为什么这么判断」 */
  evidence: string[];
}

/** 映射结果 */
export interface MappedQuestions {
  /** 已归一成我们自己的题目形状（**不生成 id**：id 由 core/qbank 的 normalizeQuestions 负责） */
  items: Array<Record<string, unknown>>;
  /** 逐条跳过原因（中文）；index 是该条在导入列表里的 0 基下标 */
  skipped: Array<{ index: number; reason: string }>;
}

// ---------- 基础工具（只认字符串/数字，绝不把对象字符串化成 "[object Object]"） ----------

/** 字段「有内容」的判定：null/undefined、空串、空数组、空对象都算没给 */
function filled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** 只收「普通对象」（排除 null 与数组）；所有逐条解析都先过这一关 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 字符串化：非字符串/数字一律回空串（避免把对象/数组拼成垃圾文本进题干） */
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** 一组候选键里第一个「有内容」的值；都没有则 undefined */
function firstFilled(o: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (filled(o[k])) return o[k];
  return undefined;
}

/** 一眼看得出是图片地址的字符串：带图片扩展名，或 data:image。其余一律不猜 */
function looksLikeImageUrl(s: string): boolean {
  return /^data:image\//i.test(s) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)([?#]|$)/i.test(s);
}

/** `[[IMG]]` 占位符：本项目只支持一张题干图，占位符留着会在题干里显示成乱码 */
const IMG_PLACEHOLDER_RE = /\[\[\s*img\s*\]\]/gi;

/** 去掉 `[[IMG]]` 占位符并收敛多余空白 */
function stripImgPlaceholder(s: string): string {
  return s.replace(IMG_PLACEHOLDER_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** 图片块类型名（各家富文本里叫法不一，type 还常是数字码，所以同时看内容像不像图片地址） */
const IMAGE_BLOCK_TYPES = new Set(['image', 'img', 'pic', 'picture', 'photo', '图', '图片', '影像']);

/**
 * 富文本块 / 字符串 / 数组 → 纯文本 + 里面的图片地址（顺序保留）。
 * 兼容 `[{type,content}]`（type 可为数字码）、`{content}`、`{analysis}`、纯字符串数组。
 */
function flattenBlocks(v: unknown): { text: string; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  const walk = (x: unknown, inImage: boolean): void => {
    if (x === undefined || x === null) return;
    if (typeof x === 'string') {
      const t = x.trim();
      if (!t) return;
      if (inImage || looksLikeImageUrl(t)) images.push(t);
      else texts.push(t);
      return;
    }
    if (typeof x === 'number' || typeof x === 'boolean') {
      texts.push(String(x));
      return;
    }
    if (Array.isArray(x)) {
      for (const y of x) walk(y, inImage);
      return;
    }
    const o = asRecord(x);
    if (!o) return;
    const type = (str(o.type) || str(o.typeName) || str(o.blockType) || str(o.kind)).toLowerCase();
    const content = firstFilled(o, ['content', 'text', 'value', 'oldtext', 'src', 'url']);
    walk(content, inImage || IMAGE_BLOCK_TYPES.has(type));
  };
  walk(v, false);
  return { text: texts.join('\n').trim(), images };
}

/** 图片字段 → 地址列表：字符串、字符串数组、`[{url|src}]` 都收，其余忽略 */
function urlList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) out.push(...urlList(x));
    return out;
  }
  const r = asRecord(v);
  return r ? urlList(firstFilled(r, ['url', 'src', 'g', '图片'])) : [];
}

/** 章节/知识点字段 → 列表（数组与分隔字符串都吃；去空白去重保序） */
function listFrom(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (x: unknown): void => {
    const r = asRecord(x);
    const s = str(x) || (r ? str(r.name ?? r.title ?? r.value) : '');
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(v)) {
    for (const x of v) push(x);
  } else if (typeof v === 'string') {
    for (const part of v.split(/[,，、;；/|]/)) push(part);
  } else {
    push(v);
  }
  return out;
}

/**
 * 答案 → 正确项下标集合（去重升序、越界丢弃）。
 * 数字/纯数字串当下标；单个字母按字母表位置；给了 `letterIndex`（选项自带的 val 字母）时优先用它，
 * 因为选项顺序未必等于字母顺序。
 */
function pickIndices(raw: unknown, count: number, letterIndex?: Map<string, number>): number[] {
  const out = new Set<number>();
  const push = (v: unknown): void => {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < count) out.add(v);
      return;
    }
    const s = str(v);
    if (!s) return;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n < count) out.add(n);
      return;
    }
    const letter = /^([A-Za-z])/.exec(s);
    if (!letter) return;
    const n = letterIndex?.get(letter[1].toUpperCase()) ?? letter[1].toUpperCase().charCodeAt(0) - 65;
    if (n >= 0 && n < count) out.add(n);
  };
  if (Array.isArray(raw)) for (const v of raw) push(v);
  else push(raw);
  return [...out].sort((a, b) => a - b);
}

/** 答案里能读出来的文本（数字与纯数字串视为下标，不算文本） */
function answerTextOf(raw: unknown): string {
  const parts: string[] = [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const x of list) {
    if (typeof x === 'number') continue;
    const s = str(x);
    if (!s || /^-?\d+$/.test(s)) continue;
    parts.push(s);
  }
  return parts.join('；');
}

/**
 * 多套解析 → `[{ source, text }]`（我们自己的形状）。
 * 兼容 `{ 老师名: { analysis: [{type,content}] } }`（窦起心搏 jiexiArr）、`{ 老师名: '文本' }`
 * 与 `[{ source|name, text|analysis }]`。解析不出就返回空数组（调用方据此**不带** explanations 键）。
 */
function normalizeExplanations(v: unknown): Array<{ source: string; text: string }> {
  const out: Array<{ source: string; text: string }> = [];
  const push = (source: string, text: string): void => {
    const t = text.trim();
    if (t) out.push({ source: source.trim(), text: t });
  };
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = asRecord(x);
      if (!r) {
        push('', flattenBlocks(x).text);
        continue;
      }
      const source = str(r.source) || str(r.name) || str(r.teacher) || str(r.老师);
      push(source, flattenBlocks(firstFilled(r, ['text', 'analysis', 'content'])).text);
    }
    return out;
  }
  const o = asRecord(v);
  if (o) {
    for (const [key, val] of Object.entries(o)) {
      const inner = asRecord(val);
      // 有 analysis 就只取 analysis：否则会把 jiangyi / daotu 之类一并拼成一段乱文
      push(key, flattenBlocks(inner ? (inner.analysis ?? val) : val).text);
    }
  }
  return out;
}

// ---------- 顶层题目数组 ----------

/** 题目数组可能挂在这些顶层键下（数组本体最常见，其余是各家的包壳） */
const LIST_KEYS = ['questions', 'questionList', 'data', 'list', 'items', 'rows', '题目'] as const;

/** 顶层探测结果：题目数组 + 它在哪个键下（用于 evidence 里解释「从哪儿取的」） */
interface ListProbe {
  items: unknown[];
  containerKey: string | null;
}

/** 顶层 → 题目数组：数组本体，或 `{questions:[…]}` / `{data:{list:[…]}}` 这类一层嵌套 */
function probeList(raw: unknown): ListProbe {
  if (Array.isArray(raw)) return { items: raw, containerKey: null };
  const o = asRecord(raw);
  if (!o) return { items: [], containerKey: null };
  for (const k of LIST_KEYS) {
    const v = o[k];
    if (Array.isArray(v)) return { items: v, containerKey: k };
  }
  for (const k of LIST_KEYS) {
    const nested = asRecord(o[k]);
    if (!nested) continue;
    for (const k2 of LIST_KEYS) {
      const v = nested[k2];
      if (Array.isArray(v)) return { items: v, containerKey: `${k}.${k2}` };
    }
  }
  return { items: [], containerKey: null };
}

// ---------- 形状探测 ----------

/** 抽样上限：只看前若干条就够判形状，几万条的文件不必逐条扫 */
const SAMPLE_LIMIT = 20;

/** 低于这个相似度就不认（核心字段已在过半条目里命中，但这个分数说明字段太零散） */
const MIN_SHAPE_SCORE = 0.4;

/** 形状展示名（界面直接用；导出/测试也读它） */
const KIND_LABEL: Record<SchemaKind, string> = {
  native: '本项目题库格式',
  'short-keys': '短键题库（万川医考风格）',
  'rich-blocks': '富文本题库（窦起心搏风格）',
  unknown: '未识别的格式',
};

/** 各语义的候选键（本项目格式别名 + 同业写法）。顺序即优先级，第一个有内容的胜出 */
const STEM_KEYS = ['stem', 'question', '题干', '题目'] as const;
const OPTION_KEYS = ['options', 'choices', '选项'] as const;
const ANSWER_KEYS = ['answer', 'correct', '答案', '正确答案'] as const;
const MULTI_ANSWER_KEYS = ['answers', 'correctAnswers', '多选答案'] as const;
/** 简答答案文本（我们自己的导出把简答题文本放这里；产出侧不产出它，见模块注释第 3 条） */
const RECALL_TEXT_KEYS = ['answerText', 'correctAnswer', 'recallAnswer'] as const;
const EXPLANATION_KEYS = ['explanation', '解析', '解释'] as const;
const EXPLANATIONS_KEYS = ['explanations', '解析集', '多解', 'jiexiArr'] as const;
const CHAPTER_KEYS = ['chapter', '章节', '科目'] as const;
const CHAPTER_LIST_KEYS = ['chapters', 'chapterList', '多章节', '知识点'] as const;
const NOTE_KEYS = ['note', '笔记', '相关笔记'] as const;
const IMAGE_KEYS = ['image', 'img', '图片', '图片路径', '题图'] as const;
const OPTION_IMAGE_KEYS = ['optionImages', '选项图片', 'optionImgs'] as const;
const SUB_KEYS = ['sub', 'subs', 'subQuestions', 'children', '小问', '子题'] as const;

/** 本项目格式里「我方字段名 → 各家别名」的完整对照（产出只写左边的名字） */
const NATIVE_FIELD_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['stem', STEM_KEYS],
  ['image', IMAGE_KEYS],
  ['options', OPTION_KEYS],
  ['answer', ANSWER_KEYS],
  ['answers', MULTI_ANSWER_KEYS],
  ['explanation', EXPLANATION_KEYS],
  ['explanations', EXPLANATIONS_KEYS],
  ['chapter', CHAPTER_KEYS],
  ['chapters', CHAPTER_LIST_KEYS],
  ['note', NOTE_KEYS],
  ['optionImages', OPTION_IMAGE_KEYS],
  ['sub', SUB_KEYS],
  ['groupStem', ['groupStem']],
  ['groupNo', ['groupNo']],
  ['groupTotal', ['groupTotal']],
];

/** 富文本块数组：`[{type,content}]`（有的家 type 写成数字码，故只要求「是块对象数组」） */
function isBlockList(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.some((x) => {
    const r = asRecord(x);
    return r !== null && ('content' in r || 'type' in r || 'text' in r || 'typeName' in r);
  });
}

/** 一条探测规则 */
interface ProbeRule {
  /** 命中的依据（中文，含字段名）——过半条目命中就进 evidence */
  label: string;
  weight: number;
  /** 核心字段：过半条目都没命中 → 该形状直接出局（避免「擦边」误判） */
  core?: boolean;
  hit: (o: Record<string, unknown>) => boolean;
}

/** 一种候选形状 */
interface ShapeSpec {
  kind: Exclude<SchemaKind, 'unknown'>;
  rules: ProbeRule[];
}

/** 本项目格式的探测规则（长字段名 + 中文字段名） */
const NATIVE_RULES: ProbeRule[] = [
  { label: '题干字段 stem/question/题干/题目', weight: 3, core: true, hit: (o) => firstFilled(o, STEM_KEYS) !== undefined },
  {
    label: '答案字段 answer/answers/答案/正确答案/answerText',
    weight: 2,
    core: true,
    hit: (o) => firstFilled(o, ANSWER_KEYS) !== undefined || firstFilled(o, MULTI_ANSWER_KEYS) !== undefined || firstFilled(o, RECALL_TEXT_KEYS) !== undefined,
  },
  { label: '选项字段 options/choices/选项（数组）', weight: 2, hit: (o) => Array.isArray(firstFilled(o, OPTION_KEYS)) },
  { label: '解析字段 explanation/解析', weight: 1, hit: (o) => firstFilled(o, EXPLANATION_KEYS) !== undefined },
  {
    label: '章节字段 chapter/章节/chapters',
    weight: 1,
    hit: (o) => firstFilled(o, CHAPTER_KEYS) !== undefined || firstFilled(o, CHAPTER_LIST_KEYS) !== undefined,
  },
  { label: '笔记字段 note/笔记', weight: 0.5, hit: (o) => firstFilled(o, NOTE_KEYS) !== undefined },
  { label: '图片字段 image/图片', weight: 0.5, hit: (o) => firstFilled(o, IMAGE_KEYS) !== undefined },
];

/** 短键题库（万川医考风格）的探测规则 */
const SHORT_RULES: ProbeRule[] = [
  { label: '题干字段 s', weight: 3, core: true, hit: (o) => str(o.s) !== '' || flattenBlocks(o.s).text !== '' },
  {
    label: '答案字段 a（题组外层用 sub 装小问）',
    weight: 2,
    core: true,
    hit: (o) => filled(o.a) || (Array.isArray(o.sub) && o.sub.length > 0),
  },
  { label: '选项字段 o（数组）', weight: 2, hit: (o) => Array.isArray(o.o) },
  { label: '题型码 t（1-7）', weight: 1, hit: (o) => { const n = Number(o.t); return Number.isInteger(n) && n >= 1 && n <= 7; } },
  { label: '解析字段 x', weight: 0.5, hit: (o) => str(o.x) !== '' },
  { label: '题目 ID 字段 i', weight: 0.5, hit: (o) => filled(o.i) },
  { label: '共用题干字段 sub', weight: 0.5, hit: (o) => Array.isArray(o.sub) && o.sub.length > 0 },
  { label: '图片字段 g/ag/ai', weight: 0.5, hit: (o) => filled(o.g) || filled(o.ag) || filled(o.ai) },
];

/** 富文本题库（窦起心搏风格）的探测规则 */
const RICH_RULES: ProbeRule[] = [
  { label: '题干富文本字段 title/tktitle:[{type,content}]', weight: 4, core: true, hit: (o) => isBlockList(o.title) || isBlockList(o.tktitle) },
  {
    label: '选项对象数组 options:[{val,oldtext,content}]',
    weight: 2,
    hit: (o) =>
      Array.isArray(o.options) &&
      o.options.some((x) => {
        const r = asRecord(x);
        return r !== null && ('val' in r || 'oldtext' in r);
      }),
  },
  { label: '多套解析字段 jiexiArr', weight: 1, hit: (o) => filled(o.jiexiArr) },
  { label: '挖空答案字段 tkanswer', weight: 1, hit: (o) => filled(o.tkanswer) },
  {
    label: '字母答案 answer:["A"]',
    weight: 1,
    hit: (o) => Array.isArray(o.answer) && o.answer.length > 0 && o.answer.every((x) => /^[A-Za-z][.、．]?$/.test(str(x))),
  },
  {
    label: '学情字段 year/diffict/plan_type/knowledge',
    weight: 0.5,
    hit: (o) => filled(o.year) || filled(o.diffict) || filled(o.plan_type) || filled(o.knowledge),
  },
];

const SHAPES: ShapeSpec[] = [
  { kind: 'native', rules: NATIVE_RULES },
  { kind: 'short-keys', rules: SHORT_RULES },
  { kind: 'rich-blocks', rules: RICH_RULES },
];

/** 单形状打分：逐规则算「多少比例的条目命中」，核心规则全过半才算这个形状可选 */
function scoreShape(spec: ShapeSpec, sample: readonly Record<string, unknown>[]): {
  score: number;
  coreHit: boolean;
  hits: string[];
} {
  let weightSum = 0;
  let hitSum = 0;
  let coreHit = true;
  const hits: string[] = [];
  for (const rule of spec.rules) {
    weightSum += rule.weight;
    let n = 0;
    for (const o of sample) if (rule.hit(o)) n++;
    const ratio = n / sample.length;
    hitSum += rule.weight * ratio;
    const majority = ratio >= 0.5;
    if (majority) hits.push(rule.label);
    if (rule.core && !majority) coreHit = false;
  }
  return { score: weightSum ? hitSum / weightSum : 0, coreHit, hits };
}

/** 探测不出形状时，逐语义报「期望字段」——这是用户唯一能自救的线索 */
function missingHints(sample: readonly Record<string, unknown>[]): string[] {
  const hints: string[] = [];
  if (!sample.some((o) => firstFilled(o, STEM_KEYS) !== undefined || str(o.s) !== '' || isBlockList(o.title) || isBlockList(o.tktitle))) {
    hints.push('没找到题干字段（期望 stem/question/题干/题目/s/title/tktitle）');
  }
  if (!sample.some((o) => Array.isArray(o.o) || Array.isArray(firstFilled(o, OPTION_KEYS)))) {
    hints.push('没找到选项字段（期望 options/选项/o/choices）');
  }
  if (!sample.some((o) => firstFilled(o, ANSWER_KEYS) !== undefined || filled(o.a) || filled(o.tkanswer))) {
    hints.push('没找到答案字段（期望 answer/answers/答案/正确答案/a/tkanswer）');
  }
  if (!hints.length) {
    hints.push('题干/选项/答案都有，但字段组合不属于任一已知形状（字段名是自创的，请核对导出模板）');
  }
  return hints;
}

/** 任取一个 JSON 值 → 判定它是哪种题库形状；判定不了就明确说缺什么 */
export function detectQbankSchema(raw: unknown): Detection {
  const probe = probeList(raw);
  const sample: Record<string, unknown>[] = [];
  for (const v of probe.items.slice(0, SAMPLE_LIMIT)) {
    const r = asRecord(v);
    if (r) sample.push(r);
  }
  if (sample.length === 0) {
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: [
        probe.items.length === 0
          ? probe.containerKey === null
            ? '没找到题目数组（期望顶层数组，或 {"questions":[…]} / {"data":[…]} / {"list":[…]}）'
            : `顶层键 ${probe.containerKey} 是空数组：这份文件里没有题目`
          : `找到 ${probe.items.length} 条题目，但没有一条是对象（期望每题一个 {…} 对象）`,
      ],
    };
  }
  const scored = SHAPES.map((spec) => ({ spec, ...scoreShape(spec, sample) }));
  let best: (typeof scored)[number] | null = null;
  for (const s of scored) {
    if (!s.coreHit) continue;
    if (best === null || s.score > best.score) best = s;
  }
  const facts = [`共 ${probe.items.length} 条题目，抽样前 ${sample.length} 条`];
  if (probe.containerKey) facts.push(`题目取自顶层键 ${probe.containerKey}`);
  if (best === null || best.score < MIN_SHAPE_SCORE) {
    const near = scored.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: [
        ...missingHints(sample),
        ...(near.score > 0
          ? [`最接近的形状是「${KIND_LABEL[near.spec.kind]}」（相似度 ${Math.round(near.score * 100)}%），但核心字段没在过半条目里命中，不按它解析`]
          : []),
        ...facts,
      ],
    };
  }
  return {
    kind: best.spec.kind,
    confidence: Number(Math.min(1, Math.max(0, best.score)).toFixed(2)),
    evidence: [`命中 ${best.hits.join('、')}`, ...facts],
  };
}

// ---------- 逐条映射 ----------

/** 单条映射结果：要么给出归一后的条目，要么给出中文跳过原因 */
type ItemResult = { ok: true; item: Record<string, unknown> } | { ok: false; reason: string };

/** 本项目格式的条目 → 只保留既有字段名（别名归一到规范名，自定义键一律丢弃） */
function pickNative(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ours, aliases] of NATIVE_FIELD_ALIASES) {
    const v = firstFilled(src, aliases);
    if (v === undefined) continue;
    if (ours === 'explanations') {
      const list = normalizeExplanations(v);
      if (list.length) out.explanations = list;
      continue;
    }
    if (ours === 'sub') {
      const subs = Array.isArray(v)
        ? v.map((x) => { const r = asRecord(x); return r ? pickNative(r) : null; }).filter((x): x is Record<string, unknown> => x !== null)
        : [];
      if (subs.length) out.sub = subs;
      continue;
    }
    out[ours] = v;
  }
  return out;
}

/**
 * 本项目格式（或字段名兼容它的文件）逐条映射。
 * 这里只做「归一 + 校验」：解析细节交给 core/qbank 的 normalizeQuestions，避免两套规则漂移。
 */
function mapNativeItem(src: Record<string, unknown>): ItemResult {
  const picked = pickNative(src);
  const stem = str(picked.stem);
  if (!stem) return { ok: false, reason: '没找到题干（本项目格式期望字段 stem/question/题干/题目）' };
  const options = Array.isArray(picked.options) ? picked.options : [];
  if (options.length < 2) {
    // 无有效选项 → 简答：把可读答案文本放回 answer（不产出 answerText，见模块注释第 3 条）
    const text = str(firstFilled(src, RECALL_TEXT_KEYS));
    if (!text) {
      return {
        ok: false,
        reason: '选项少于 2 项，也没有可读的答案文本（简答题期望 answerText 文本，或 answer 直接写答案文本）',
      };
    }
    const recall: Record<string, unknown> = { ...picked, stem, answer: text };
    delete recall.options;
    delete recall.answers;
    return { ok: true, item: recall };
  }
  if (!filled(picked.answer) && !filled(picked.answers)) {
    return { ok: false, reason: '有 ≥2 个选项，但没找到答案（期望 answer/answers/答案/正确答案）' };
  }
  return { ok: true, item: { ...picked, stem } };
}

/** 短键选项 `o` → 文本数组 + 与下标对齐的图片数组（`{c,g}` 与纯字符串两种写法都收） */
function shortOptions(raw: unknown): { texts: string[]; images: (string | null)[] } {
  const texts: string[] = [];
  const images: (string | null)[] = [];
  if (!Array.isArray(raw)) return { texts, images };
  for (const v of raw) {
    if (typeof v === 'string' || typeof v === 'number') {
      texts.push(str(v));
      images.push(null);
      continue;
    }
    const r = asRecord(v);
    if (!r) {
      texts.push('');
      images.push(null);
      continue;
    }
    const blocks = flattenBlocks(firstFilled(r, ['c', 'content', 'text', '选项']));
    let text = stripImgPlaceholder(blocks.text);
    let image = urlList(firstFilled(r, ['g', 'img', 'image', '图片']))[0] ?? blocks.images[0] ?? null;
    // 选项文本本身就是一张图（或只有图没有文字）→ 文本留空、图片留下
    if (!image && looksLikeImageUrl(text)) {
      image = text;
      text = '';
    }
    texts.push(text);
    images.push(image);
  }
  return { texts, images };
}

/**
 * 短键题库（万川医考风格）逐条映射。
 * `t` 题型码：1 单选 / 2、3 多选 / 4 判断 / 5 图文 / 6 共用题干 / 7 填空。
 * 题型码只用来兜底（判断补「正确/错误」，题组认 sub），**不按码写分支解析**——码会随版本变。
 */
function mapShortItem(src: Record<string, unknown>): ItemResult {
  const stemBlocks = flattenBlocks(src.s);
  const stem = stripImgPlaceholder(stemBlocks.text);
  const stemImages = [...urlList(src.g), ...stemBlocks.images];
  const analysis = str(src.x);
  // 题型码 6（共用题干）：外层是病例、sub 是小问。**不自己展开**——展开与 id/序号生成是
  // normalizeQuestions 的职责，两处展开必然漂移（"普通题认得、小问不认得"最难查）。
  const subs = Array.isArray(src.sub) ? src.sub : [];
  if (subs.length) {
    const inner: Array<Record<string, unknown>> = [];
    for (const v of subs) {
      const r = asRecord(v);
      if (!r) continue;
      const res = mapShortItem(r);
      if (res.ok) inner.push(res.item);
    }
    if (inner.length) {
      const group: Record<string, unknown> = { sub: inner };
      if (stem) group.stem = stem;
      if (analysis) group.explanation = analysis;
      if (stemImages[0]) group.image = stemImages[0];
      return { ok: true, item: group };
    }
  }
  if (!stem) {
    return {
      ok: false,
      reason: subs.length
        ? '共用题干（万川短键 sub）里的小问都没能解析出题干与答案，外层也没有病例题干'
        : '没找到题干（万川短键期望字段 s）',
    };
  }
  const typeCode = Number.isInteger(Number(src.t)) ? Number(src.t) : 0;
  const opt = shortOptions(src.o);
  let texts = opt.texts;
  let images = opt.images;
  // 判断题（题型码 4）常常不给 o：因为「对/错」是题型自带的，补上两个选项比落成简答更好用
  if (typeCode === 4 && texts.length < 2 && pickIndices(src.a, 2).length === 1) {
    texts = ['正确', '错误'];
    images = [null, null];
  }
  const usable = texts.length >= 2 && (texts.some((t) => t.trim() !== '') || images.some(Boolean));
  const picks = usable ? pickIndices(src.a, texts.length) : [];
  if (usable && picks.length >= 1) {
    const item: Record<string, unknown> = { stem, options: texts, answer: picks[0] };
    // 多选只在真的有 ≥2 个正确项时才带 answers（与本项目「answers 只在多选时出现」的约定一致；
    // 题型码是 2/3 但答案只有一个下标时，单选语义才是对的）
    if (picks.length > 1) item.answers = picks;
    if (stemImages[0]) item.image = stemImages[0];
    if (analysis) item.explanation = analysis;
    if (images.some(Boolean)) item.optionImages = images;
    return { ok: true, item };
  }
  // 选项不足 2 项（或答案对不上选项）→ 落成简答：只产出能读的答案文本
  const text = answerTextOf(src.a);
  if (!text) {
    return {
      ok: false,
      reason: usable
        ? '有选项但答案（万川短键 a）解析不出正确项下标'
        : '选项少于 2 项，且答案没有可读文本（万川短键 a 只有下标或为空），无法还原成简答答案',
    };
  }
  const recall: Record<string, unknown> = { stem, answer: text };
  if (stemImages[0]) recall.image = stemImages[0];
  if (analysis) recall.explanation = analysis;
  return { ok: true, item: recall };
}

/**
 * 富文本题库（窦起心搏风格）逐条映射。
 * `title/tktitle` 是 `[{type,content}]` 富文本；`options` 是 `[{val,oldtext,content}]`；
 * `answer` 是 `['A']`；`tkanswer` 是挖空答案；`jiexiArr` 是一题多套解析；
 * `knowledge` 是知识点（映射到我们的 chapters/chapter）；`year/diffict/plan_type` 我们没有对应字段，丢弃。
 */
function mapRichItem(src: Record<string, unknown>): ItemResult {
  const titleBlocks = flattenBlocks(src.title ?? src.tktitle);
  const stem = stripImgPlaceholder(titleBlocks.text);
  if (!stem) return { ok: false, reason: '没找到题干（窦起心搏富文本期望字段 title/tktitle:[{type,content}]）' };
  const rawOptions = Array.isArray(src.options) ? src.options : [];
  const texts: string[] = [];
  const images: (string | null)[] = [];
  const letterIndex = new Map<string, number>();
  rawOptions.forEach((v, i) => {
    if (typeof v === 'string' || typeof v === 'number') {
      texts.push(str(v));
      images.push(null);
      return;
    }
    const r = asRecord(v);
    if (!r) {
      texts.push('');
      images.push(null);
      return;
    }
    const val = str(r.val);
    if (/^[A-Za-z]$/.test(val)) letterIndex.set(val.toUpperCase(), i);
    const blocks = flattenBlocks(r.content);
    const fallback = str(r.oldtext) || str(r.text) || (val.length > 1 ? val : '');
    let text = stripImgPlaceholder(blocks.text) || fallback;
    let image = blocks.images[0] ?? (str(firstFilled(r, ['image', 'img'])) || null);
    if (!image && looksLikeImageUrl(text)) {
      image = text;
      text = '';
    }
    texts.push(text);
    images.push(image);
  });
  const explanations = normalizeExplanations(firstFilled(src, EXPLANATIONS_KEYS));
  const analysis = flattenBlocks(firstFilled(src, ['analysis', 'jiexi', '解析'])).text;
  const chapters = listFrom(firstFilled(src, [...CHAPTER_LIST_KEYS, 'knowledge']));
  const stemImage = titleBlocks.images[0] ?? (str(firstFilled(src, IMAGE_KEYS)) || undefined);
  const validIndex = letterIndex.size ? letterIndex : undefined;
  const picks = pickIndices(src.answer ?? src.correct, texts.length, validIndex);
  const usable = texts.length >= 2 && texts.some((t) => t.trim() !== '');
  if (usable && picks.length >= 1) {
    const item: Record<string, unknown> = { stem, options: texts, answer: picks[0] };
    if (picks.length > 1) item.answers = picks;
    if (stemImage) item.image = stemImage;
    if (images.some(Boolean)) item.optionImages = images;
    if (analysis) item.explanation = analysis;
    if (explanations.length) item.explanations = explanations;
    if (chapters.length === 1) item.chapter = chapters[0];
    else if (chapters.length > 1) item.chapters = chapters;
    return { ok: true, item };
  }
  // 无有效选项 → 简答：挖空答案 tkanswer（或写成文本的 answer）必须有可读内容，否则跳过
  const text = flattenBlocks(src.tkanswer).text || str(src.answer);
  if (!text) {
    return {
      ok: false,
      reason: usable
        ? '有选项但答案（窦起心搏 answer:["A"]）解析不出正确项下标'
        : '选项少于 2 项（期望 options:[{val,oldtext,content}]），也没有可读答案（期望 tkanswer 或 answer 文本）',
    };
  }
  const recall: Record<string, unknown> = { stem, answer: text };
  if (stemImage) recall.image = stemImage;
  if (analysis) recall.explanation = analysis;
  if (explanations.length) recall.explanations = explanations;
  if (chapters.length === 1) recall.chapter = chapters[0];
  else if (chapters.length > 1) recall.chapters = chapters;
  return { ok: true, item: recall };
}

/**
 * 探测到的形状 → 归一化条目数组（可直接喂给 core/qbank 的 normalizeQuestions）。
 * 形状探测不出来时返回 `items: []`，并在 `skipped` 里用中文写清**期望字段**（不猜）。
 */
export function mapToQuestions(raw: unknown): MappedQuestions {
  const det = detectQbankSchema(raw);
  const probe = probeList(raw);
  const source: Record<string, unknown>[] = [];
  for (const v of probe.items) {
    const r = asRecord(v);
    if (r) source.push(r);
  }
  if (det.kind === 'unknown') {
    const why = det.evidence.filter((e) => !e.startsWith('共 ')).join('；');
    const reason =
      source.length === 0
        ? `一条题目都没解析出来：${why}`
        : `整份文件（共 ${source.length} 条）都没识别出已知题库形状：${why}。请确认这是题库文件，或把这份 JSON 的字段名反馈给我们适配`;
    return { items: [], skipped: [{ index: 0, reason }] };
  }
  const mapper = det.kind === 'native' ? mapNativeItem : det.kind === 'short-keys' ? mapShortItem : mapRichItem;
  const items: Array<Record<string, unknown>> = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  source.forEach((src, index) => {
    const res = mapper(src);
    if (res.ok) items.push(res.item);
    else skipped.push({ index, reason: res.reason });
  });
  return { items, skipped };
}

/**
 * 给界面用的一句话说明：这份文件被识别成什么、能导入多少题、跳过了多少（并给出第一条跳过原因）。
 * 形状名 / 题数 / 跳过数三件事必带——用户判断「要不要继续导入」只看这三个数。
 */
export function mappingSummary(det: Detection, mapped: MappedQuestions): string {
  const label = KIND_LABEL[det.kind];
  const percent = `${Math.round(det.confidence * 100)}%`;
  const head =
    det.kind === 'unknown'
      ? `这份文件没识别出已知题库格式（${label}，置信度 ${percent}），不会导入任何题目`
      : `识别为「${label}」（置信度 ${percent}）`;
  const first = mapped.skipped[0];
  const skipNote = first
    ? `；跳过 ${mapped.skipped.length} 条，例：第 ${first.index + 1} 条 ${first.reason}`
    : '；没有跳过任何条目';
  return `${head}：可导入 ${mapped.items.length} 题${skipNote}。依据：${det.evidence.join('；')}`;
}
