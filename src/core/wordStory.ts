/**
 * 单词工坊 · 薄弱词成文。
 *
 * 目标：把「背得最不顺的那批词」放进一篇值得熟背的短文里，再逐句拆搭配。
 * 这里只做与界面无关的四件事：
 * - 从练习记录里挑最不熟练的约 20%（不是随机，也不是「错得最多」一条轴）；
 * - 拼两次模型请求：先写短文，再逐句精读；
 * - 容错解析模型返回的 JSON（围栏、前后解释、个别字段缺失都兜住）；
 * - 目标词的词形识别与 Markdown 导出。
 *
 * 取词为什么用多因子：只看答错次数会把「刚学、只答对过一次」的词漏掉；
 * 只看 FSRS 难度又忽略「很久没复习、现在快忘了」。所以把正确率、lapses、
 * 难度和当前可提取性放在同一个分数里，排序才接近「背得最不熟」。
 */
import type { WireMessage } from './aiAgent';
import { defineStore } from '../storage/kv';
import { DAY, normWord, type Word, type WordRecord } from './wordDrill';

/** 取最不熟练的 20% */
export const WEAK_RATIO = 0.2;
/** 一篇短文能自然容纳的下限 / 上限：少于 8 个词撑不起语境，多于 20 个句子会变硬 */
export const WEAK_MIN = 8;
export const WEAK_MAX = 20;

export interface WeakWord {
  word: Word;
  /** 越大越不熟练；只用于排序，不是对外承诺的指标 */
  score: number;
  record: WordRecord;
}

/**
 * 不熟练度（越大越弱）。各项都做了截断，避免一个极端值（错过 40 次）压住其他信号。
 * 可提取性用 FSRS 的遗忘曲线：r = 0.9^(elapsed/stability)，1-r 就是「现在想起来的难度」。
 */
export function weaknessScore(rec: WordRecord, now = Date.now()): number {
  const total = Math.max(0, rec.right) + Math.max(0, rec.wrong);
  const accuracy = total > 0 ? Math.max(0, rec.right) / total : 0;
  const elapsedDays = Math.max(0, (now - (rec.lastReview || now)) / DAY);
  const stability = Math.max(0.1, rec.stability || 1);
  const retrievability = Math.exp((Math.log(0.9) * elapsedDays) / stability);
  const forgetting = Math.min(1, Math.max(0, 1 - retrievability));
  return (
    (1 - accuracy) * 3.2 +
    Math.min(6, Math.max(0, rec.wrong)) * 0.55 +
    Math.min(6, Math.max(0, rec.lapses)) * 0.45 +
    ((Math.min(10, Math.max(1, rec.difficulty || 5)) - 1) / 9) * 1.2 +
    forgetting * 1.6 +
    (rec.mastered ? -1.2 : 0) +
    (rec.reps === 0 ? 0.4 : 0)
  );
}

/**
 * 取当前词库最不熟练的一批词。
 * 只统计**练过**的词：没有记录就没有「熟不熟」可言，不能把没学过的词算成薄弱词。
 */
export function weakestWords(
  words: readonly Word[],
  records: Readonly<Record<string, WordRecord>>,
  {
    ratio = WEAK_RATIO,
    min = WEAK_MIN,
    max = WEAK_MAX,
    now = Date.now(),
  }: { ratio?: number; min?: number; max?: number; now?: number } = {},
): WeakWord[] {
  const seen = new Set<string>();
  const picked: WeakWord[] = [];
  for (const word of words) {
    const key = normWord(word.en);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const record = records[key];
    if (!record) continue;
    picked.push({ word, record, score: weaknessScore(record, now) });
  }
  picked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.record.lapses !== a.record.lapses) return b.record.lapses - a.record.lapses;
    if (b.record.wrong !== a.record.wrong) return b.record.wrong - a.record.wrong;
    if (b.record.difficulty !== a.record.difficulty) return b.record.difficulty - a.record.difficulty;
    return a.word.en.localeCompare(b.word.en);
  });
  const wanted = Math.min(
    picked.length,
    Math.min(Math.max(1, max), Math.max(min, Math.round(picked.length * Math.max(0, ratio)))),
  );
  return picked.slice(0, wanted);
}

export interface StorySentence {
  en: string;
  zh: string;
}

/** 模型回报的目标词实际形态：用于覆盖校验、挖空与标亮（可处理 went / children 这类不规则变化） */
export interface StoryWordUse {
  word: string;
  form: string;
}

export interface WordStory {
  title: string;
  titleZh: string;
  sentences: StorySentence[];
  used?: StoryWordUse[];
}

export interface StoryPoint {
  /** 必须逐字出现在原句中（允许大小写不同） */
  phrase: string;
  kind: string;
  zh: string;
  tip: string;
}

export interface StoryLine {
  /** 对应原文第几句（从 1 开始） */
  index: number;
  grammar: string;
  points: StoryPoint[];
}

export interface StoryAnalysis {
  lines: StoryLine[];
}

export const STORY_MIN_WORDS = 140;
export const STORY_MAX_WORDS = 200;

/** 提示词里的释义只取第一个义项：词库释义常带 5–8 个义项，全塞进去会把写作目标搅散 */
const TARGET_LINE = (word: Word): string => {
  const gloss = (word.zh.split(/[；;]/)[0] ?? word.zh).trim();
  const short = gloss.length > 40 ? `${gloss.slice(0, 40)}…` : gloss;
  return `- ${word.en} — ${short}`;
};

/** 第一次调用：写短文。词的顺序明确告诉模型可以打乱，避免它按词表硬排。 */
export function buildStoryMessages(words: readonly Word[], bankName = ''): WireMessage[] {
  const list = words.map(TARGET_LINE).join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是一位给中国英语学习者写范文的写作教练。你的任务不是「把词表塞进句子」，而是写一篇读者愿意背下来的短文。',
        '硬性规则：',
        '1. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释。',
        `2. 短文 ${STORY_MIN_WORDS}–${STORY_MAX_WORDS} 词，8–14 句；写一个完整的场景或小故事，有起承转合，结尾最好有余味。`,
        '3. 难度 B1–B2（适中）：以常见句型和具体动词为主；每句 8–20 词；最多 2 个较长的复合句，其余保持干净。',
        '4. 必须自然用上全部目标词，每个至少一次。可以按语法变形（时态、单复数、-ing/-ed、比较级），但不能换成别的词，也不要只换词族（如 decide → decision）充数。',
        '5. 词的先后顺序随意，不要按给定顺序排列；把词放在最自然、最像真实英语的位置，必要时换场景，绝不能为塞词写出别扭句。',
        '6. 第一目标是通顺、地道、值得熟背：用真实语境里会出现的搭配，少用生僻词，不写教科书腔和空洞总结。',
        '7. 中文译文要准确、自然，帮助理解，不逐字硬译。',
        '8. title 用 3–7 个词的英文短标题；titleZh 是它的中文。',
        '9. 另外输出 used：每个目标词一条，form 必须是短文里实际出现的原文片段（保留时态/单复数/比较级），不要写原形；同一个词出现多次时取第一次的形态。',
        '输出结构：{"title":"...","titleZh":"...","sentences":[{"en":"...","zh":"..."}],"used":[{"word":"目标词","form":"文中实际形态"}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        bankName ? `当前词库：${bankName}` : '当前词库：单词工坊',
        `目标词（共 ${words.length} 个；顺序不代表写作顺序）：`,
        list,
        '',
        '请写短文。',
      ].join('\n'),
    },
  ];
}

/** 第二次调用：逐句精读。把原句编号一起给出，要求逐句对齐。 */
export interface AnalysisRange {
  /** 1-based，含 */
  start: number;
  /** 1-based，含 */
  end: number;
}

/** 长文精读按句分批：单次输出越长越容易被 JSON 截断，6 句一批在质量与调用次数间折中 */
export function analysisBatches(story: WordStory, size = 6): AnalysisRange[] {
  const step = Math.max(1, Math.floor(size));
  const total = story.sentences.length;
  const out: AnalysisRange[] = [];
  for (let start = 1; start <= total; start += step) {
    out.push({ start, end: Math.min(start + step - 1, total) });
  }
  return out;
}

export function buildAnalysisMessages(story: WordStory, range?: AnalysisRange): WireMessage[] {
  const from = Math.max(1, range?.start ?? 1);
  const to = Math.min(story.sentences.length, range?.end ?? story.sentences.length);
  const lines = story.sentences
    .slice(from - 1, to)
    .map((s, i) => `${from + i}. ${s.en}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是一位英语精读老师，带学生把一篇短文拆到可以背下来的程度。',
        '只输出一个 JSON 对象，不要代码围栏，不要解释。',
        '规则：',
        '1. 只分析输入里列出的句子；条数、顺序与输入一致；index 用每句前面的原编号，不要重新从 1 数。',
        '2. 每句挑 1–3 个真正值得记的表达：固定搭配、动词短语、介词搭配、高分词组、地道句型。不要凑数，普通主谓宾不写。',
        '3. phrase 必须在该句中逐字出现（忽略大小写与首尾标点）；句中用了变形就照抄变形后的形式。禁止写句子里没有的表达。',
        '4. kind 只能是「固定搭配」「动词短语」「介词搭配」「高分词组」「地道句型」「语法结构」之一。',
        '5. zh 给中文意思；tip 说明为什么值得记、怎么用，控制在 30 字内，不要复述句意。',
        '6. grammar 写该句最值得学的一个结构或语法点（如「过去完成时铺垫背景」），没有就写空串。',
        '7. 不要编造语法术语；不确定就不写。',
        '输出结构：{"sentences":[{"index":1,"grammar":"","points":[{"phrase":"...","kind":"固定搭配","zh":"...","tip":"..."}]}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [`短文：${story.title}`, `逐句原文（第 ${from}–${to} 句）：`, lines].join('\n'),
    },
  ];
}

function unfence(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

/**
 * 宽松地取一个 JSON 对象：先整段解析，再截首尾花括号，最后容忍尾逗号。
 * 模型偶尔会在 JSON 前后加一句「以下是短文」，前两步就能覆盖。
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = unfence(raw);
  if (!text) return null;
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const value: unknown = JSON.parse(attempt);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      } catch {
        /* 换下一种候选 */
      }
    }
  }
  return null;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 解析短文。标题缺失可兜底，句子为空则视为失败（没有正文就没有可背的东西）。 */
export function parseStory(raw: string): WordStory | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const root =
    obj.story && typeof obj.story === 'object' && !Array.isArray(obj.story)
      ? (obj.story as Record<string, unknown>)
      : obj;
  const list = root.sentences ?? root.lines ?? root.text;
  if (!Array.isArray(list)) return null;
  const sentences: StorySentence[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const en = item.trim();
      if (en) sentences.push({ en, zh: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const en = textOf(row.en) || textOf(row.english) || textOf(row.sentence);
    if (!en) continue;
    const zh = textOf(row.zh) || textOf(row.cn) || textOf(row.translation);
    sentences.push({ en, zh });
  }
  if (!sentences.length) return null;
  const title = textOf(root.title) || textOf(root.name) || 'A Short Story';
  const titleZh = textOf(root.titleZh) || textOf(root.title_zh) || textOf(root.cnTitle);
  const used: StoryWordUse[] = [];
  const seenWords = new Set<string>();
  const rawUsed = root.used ?? root.wordUses ?? root.forms;
  if (Array.isArray(rawUsed)) {
    for (const item of rawUsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const word = textOf(row.word) || textOf(row.target) || textOf(row.en);
      const form = textOf(row.form) || textOf(row.surface) || textOf(row.used);
      if (!word || !form) continue;
      const key = normWord(word);
      if (!key || seenWords.has(key)) continue;
      seenWords.add(key);
      used.push({ word, form });
    }
  }
  return { title, titleZh, sentences, ...(used.length ? { used } : {}) };
}

/** 解析逐句精读。只保留有内容的句子（搭配或语法点），空壳句子不占位置。 */
export function parseAnalysis(raw: string): StoryAnalysis | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const root =
    obj.analysis && typeof obj.analysis === 'object' && !Array.isArray(obj.analysis)
      ? (obj.analysis as Record<string, unknown>)
      : obj;
  const list = root.sentences ?? root.lines;
  if (!Array.isArray(list)) return null;
  const lines: StoryLine[] = [];
  for (const [pos, item] of list.entries()) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const indexRaw = Number(row.index ?? row.no ?? row.n);
    const index = Number.isFinite(indexRaw) && indexRaw > 0 ? Math.round(indexRaw) : pos + 1;
    const grammar = textOf(row.grammar) || textOf(row.structure) || textOf(row.pattern);
    const points: StoryPoint[] = [];
    const rawPoints = row.points ?? row.phrases ?? row.collocations;
    if (Array.isArray(rawPoints)) {
      for (const point of rawPoints) {
        if (typeof point === 'string') {
          const phrase = point.trim();
          if (phrase) points.push({ phrase, kind: '固定搭配', zh: '', tip: '' });
          continue;
        }
        if (!point || typeof point !== 'object') continue;
        const p = point as Record<string, unknown>;
        const phrase = textOf(p.phrase) || textOf(p.expression) || textOf(p.text);
        if (!phrase) continue;
        points.push({
          phrase,
          kind: textOf(p.kind) || textOf(p.type) || '固定搭配',
          zh: textOf(p.zh) || textOf(p.meaning) || textOf(p.cn),
          tip: textOf(p.tip) || textOf(p.note) || textOf(p.why),
        });
      }
    }
    if (!grammar && !points.length) continue;
    lines.push({ index, grammar, points });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.index - b.index);
  return { lines };
}

/** 原文里的目标词词形（用于标亮/挖空的兜底）。常见屈折变化可覆盖；
 *  不规则变化优先使用短文里模型回报的 `used.form`（见 storySurfaceForms）。 */
export function wordForms(en: string): string[] {
  const base = en.trim().toLowerCase();
  if (!base) return [];
  if (/\s/.test(base)) return [base];
  const set = new Set([
    base,
    `${base}s`,
    `${base}es`,
    `${base}ed`,
    `${base}d`,
    `${base}ing`,
    `${base}er`,
    `${base}est`,
    `${base}ly`,
  ]);
  if (base.endsWith('e')) {
    set.add(`${base.slice(0, -1)}ing`);
    set.add(`${base.slice(0, -1)}ed`);
  }
  if (base.endsWith('y')) {
    set.add(`${base.slice(0, -1)}ies`);
    set.add(`${base.slice(0, -1)}ied`);
  }
  // stop → stopped / stopping：末尾是「辅音 + 元音 + 辅音」时双写
  if (/[^aeiou][aeiou][bcdfgklmnprstvz]$/.test(base)) {
    set.add(`${base}${base.slice(-1)}ed`);
    set.add(`${base}${base.slice(-1)}ing`);
  }
  return [...set];
}

/** 目标词是否在文本里出现（含常见词形；多词术语允许空白差异）。 */
export function wordAppears(text: string, en: string): boolean {
  const forms = wordForms(en);
  if (!forms.length) return false;
  const pattern = forms
    .sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(`\\b(?:${pattern})\\b`, 'i').test(text);
}

/* ---------------------------------------------------------- 覆盖 / 挖空 */

export interface StoryCoverage {
  used: Word[];
  missing: Word[];
}

const surface = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export function storyPlainText(story: WordStory): string {
  return story.sentences.map((sentence) => sentence.en).join(' ');
}

/**
 * 目标词是否都在短文里出现过。
 * 优先用模型回报的 used.form（能覆盖 went / children 这类不规则变化），
 * 没回报或回报的形态在原文里找不到时，退回词形规则检查。
 */
export function storyCoverage(story: WordStory, words: readonly Word[]): StoryCoverage {
  const text = surface(storyPlainText(story));
  const reported = new Map<string, string>();
  for (const use of story.used ?? []) reported.set(normWord(use.word), use.form);
  const used: Word[] = [];
  const missing: Word[] = [];
  for (const word of words) {
    const key = normWord(word.en);
    const form = reported.get(key);
    if ((form && text.includes(surface(form))) || wordAppears(storyPlainText(story), word.en)) {
      used.push(word);
    } else {
      missing.push(word);
    }
  }
  return { used, missing };
}

/** 文中实际出现的目标词形态（长词优先），供高亮与挖空共用 */
export function storySurfaceForms(story: WordStory, words: readonly Word[]): string[] {
  const text = surface(storyPlainText(story));
  const reported = new Map<string, string>();
  for (const use of story.used ?? []) reported.set(normWord(use.word), use.form);
  const forms = new Set<string>();
  for (const word of words) {
    const form = reported.get(normWord(word.en));
    if (form && text.includes(surface(form))) {
      forms.add(form);
      continue;
    }
    for (const candidate of wordForms(word.en)) {
      if (text.includes(surface(candidate))) forms.add(candidate);
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** 把目标词形态替换成挖空占位；前后用字母 lookaround，避免 art 误伤 start */
export function maskStoryText(
  text: string,
  forms: readonly string[],
  placeholder = '＿＿＿',
): string {
  if (!forms.length || !text) return text;
  const pattern = forms
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  if (!pattern) return text;
  return text.replace(new RegExp(`(?<![A-Za-z])(?:${pattern})(?![A-Za-z])`, 'gi'), placeholder);
}

/** 短文正文（不含标题）：单篇导出与「导出全部」共用，避免标题层级重复 */
function storyBodyMarkdown(story: WordStory, analysis?: StoryAnalysis | null): string {
  const out: string[] = [];
  for (const sentence of story.sentences) {
    out.push(sentence.en);
    if (sentence.zh) out.push(sentence.zh);
    out.push('');
  }
  if (analysis?.lines.length) {
    out.push('## 逐句精读', '');
    for (const line of analysis.lines) {
      const sentence = story.sentences[line.index - 1];
      out.push(`${line.index}. ${sentence?.en ?? ''}`);
      if (sentence?.zh) out.push(`   译：${sentence.zh}`);
      if (line.grammar) out.push(`   句型：${line.grammar}`);
      for (const point of line.points) {
        out.push(
          `   - ${point.phrase}｜${point.kind}${point.zh ? `｜${point.zh}` : ''}${point.tip ? `（${point.tip}）` : ''}`,
        );
      }
      out.push('');
    }
  }
  return out.join('\n').trim();
}

export function storyToMarkdown(story: WordStory, analysis?: StoryAnalysis | null): string {
  return [`# ${story.title}${story.titleZh ? `（${story.titleZh}）` : ''}`, '', storyBodyMarkdown(story, analysis)]
    .join('\n')
    .trim();
}

/** 本地日期（YYYY-MM-DD）：导出文件用本地时间，避免晚上导出显示成前一天 */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 文件名：去掉 Windows/macOS 不允许的字符，空标题兜底；中文标题原样保留 */
export function storyFileName(story: WordStory, createdAt = Date.now()): string {
  const slug = story.title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/[.-]+$/, '')
    .slice(0, 48)
    .replace(/[.-]+$/, '');
  return `${slug || 'word-story'}-${localDay(createdAt).replace(/-/g, '')}.md`;
}

/** 单篇导出：带 frontmatter，落到笔记软件里也能认出标题、日期与目标词 */
export function storyToMarkdownDocument(
  story: WordStory,
  analysis?: StoryAnalysis | null,
  meta: { createdAt?: number; bankName?: string; words?: readonly Word[] } = {},
): string {
  const createdAt = meta.createdAt ?? Date.now();
  const title = `${story.title}${story.titleZh ? `（${story.titleZh}）` : ''}`;
  const head = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `created: ${localDay(createdAt)}`,
    'source: 单词工坊',
  ];
  if (meta.bankName) head.push(`bank: ${JSON.stringify(meta.bankName)}`);
  if (meta.words?.length) head.push(`words: ${JSON.stringify(meta.words.map((word) => word.en))}`);
  head.push('---', '');
  return `${head.join('\n')}\n${storyToMarkdown(story, analysis)}\n`;
}

export function archiveFileName(createdAt = Date.now()): string {
  return `单词工坊-历史短文-${localDay(createdAt).replace(/-/g, '')}.md`;
}

/** 全部历史导出成一个 Markdown：每篇一个二级标题，正文不重复大标题 */
export function storyArchiveToMarkdown(entries: readonly StoryArchiveEntry[]): string {
  const head = ['# 单词工坊 · 历史短文', '', `> 共 ${entries.length} 篇，按生成时间倒序。`].join('\n');
  const sections = entries.map((entry, i) => {
    const title = `${entry.story.title}${entry.story.titleZh ? `（${entry.story.titleZh}）` : ''}`;
    const meta = `> ${localDay(entry.createdAt)} · ${entry.bankName || '单词工坊'} · ${entry.words.length} 词`;
    return [`## ${i + 1}. ${title}`, '', meta, '', storyBodyMarkdown(entry.story, entry.analysis)]
      .join('\n')
      .trim();
  });
  return [head, ...sections].join('\n\n---\n\n').trim();
}

/* ------------------------------------------------------------ 历史短文 */

/**
 * 生成历史只存在本机：短文、逐句精读、当时的取词快照。
 *
 * 为什么要存取词快照而不是只存词：回看历史时，用户需要知道「这篇是从哪批薄弱词来的」，
 * 而练习记录会继续变化，事后再按 en 去查已经不是当时那批了。
 * 上限 20 篇：一篇含精读约 6–10KB，20 篇仍在 localStorage 的舒适区内。
 */
export const STORY_ARCHIVE_KEY = 'knowlattice-word-drill-stories';
export const STORY_ARCHIVE_LIMIT = 20;

export interface StoryArchiveEntry {
  id: string;
  /** 生成时间戳 */
  createdAt: number;
  /** 生成时的词库名（CET-6 / 我的词库…） */
  bankName: string;
  /** 生成时的薄弱词快照（含当时的练习记录，用于词块提示） */
  words: WeakWord[];
  story: WordStory;
  analysis: StoryAnalysis | null;
  /** 收藏：收藏的条目排在前面，并在淘汰时优先保留 */
  pinned?: boolean;
}

export function newStoryId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function decodeArchiveWords(raw: unknown): WeakWord[] {
  if (!Array.isArray(raw)) return [];
  const out: WeakWord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { word?: unknown; record?: unknown; score?: unknown };
    const word = row.word as Partial<Word> | undefined;
    if (!word || typeof word.en !== 'string' || !normWord(word.en)) continue;
    if (typeof word.zh !== 'string' || !word.zh.trim()) continue;
    const key = normWord(word.en);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = (row.record && typeof row.record === 'object' ? row.record : {}) as Partial<WordRecord>;
    out.push({
      word: {
        en: word.en.trim(),
        zh: word.zh.trim(),
        ...(typeof word.ipa === 'string' && word.ipa.trim() ? { ipa: word.ipa.trim() } : {}),
        ...(typeof word.example === 'string' && word.example.trim() ? { example: word.example.trim() } : {}),
        ...(typeof word.origin === 'string' && word.origin.trim() ? { origin: word.origin.trim() } : {}),
      },
      record: {
        en: word.en.trim(),
        right: Math.max(0, asNumber(record.right)),
        wrong: Math.max(0, asNumber(record.wrong)),
        reps: Math.max(0, asNumber(record.reps)),
        due: asNumber(record.due),
        mastered: record.mastered === true,
        stability: Math.max(0.1, asNumber(record.stability, 1)),
        difficulty: Math.min(10, Math.max(1, asNumber(record.difficulty, 5))),
        lastReview: asNumber(record.lastReview),
        lapses: Math.max(0, asNumber(record.lapses)),
      },
      score: asNumber(row.score),
    });
  }
  return out;
}

/** 读取时逐条校验：坏条目丢掉，不让一条手改数据把整段历史清空 */
export function decodeStoryArchive(raw: unknown): StoryArchiveEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = textOf(row.id);
    if (!id || seen.has(id)) continue;
    if (!row.story || typeof row.story !== 'object') continue;
    const story = parseStory(JSON.stringify(row.story));
    if (!story) continue;
    const analysis =
      row.analysis && typeof row.analysis === 'object'
        ? parseAnalysis(JSON.stringify(row.analysis))
        : null;
    seen.add(id);
    out.push({
      id,
      createdAt: asNumber(row.createdAt),
      bankName: textOf(row.bankName).slice(0, 40),
      words: decodeArchiveWords(row.words),
      story,
      analysis,
      pinned: row.pinned === true,
    });
  }
  return sortStoryArchive(out);
}

/** 收藏优先、再按生成时间倒序；截到上限。所有入口共用这一套顺序。 */
export function sortStoryArchive(list: readonly StoryArchiveEntry[]): StoryArchiveEntry[] {
  return [...list]
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt)
    .slice(0, STORY_ARCHIVE_LIMIT);
}

export function makeStoryArchiveEntry(args: {
  id?: string;
  createdAt?: number;
  bankName?: string;
  words: readonly WeakWord[];
  story: WordStory;
  analysis: StoryAnalysis | null;
  pinned?: boolean;
}): StoryArchiveEntry {
  const createdAt = args.createdAt ?? Date.now();
  return {
    id: args.id ?? newStoryId(createdAt),
    createdAt,
    bankName: (args.bankName ?? '').trim().slice(0, 40),
    words: [...args.words],
    story: args.story,
    analysis: args.analysis,
    pinned: args.pinned === true,
  };
}

/** 新条目置顶；同 id 覆盖（「重试精读」不应多出一篇）。 */
export function upsertStoryArchive(
  list: readonly StoryArchiveEntry[],
  entry: StoryArchiveEntry,
): StoryArchiveEntry[] {
  return sortStoryArchive([entry, ...list.filter((item) => item.id !== entry.id)]);
}

export function removeStoryArchive(
  list: readonly StoryArchiveEntry[],
  id: string,
): StoryArchiveEntry[] {
  return list.filter((item) => item.id !== id);
}

export const storyArchiveStore = defineStore<StoryArchiveEntry[]>({
  key: STORY_ARCHIVE_KEY,
  fallback: [],
  decode: decodeStoryArchive,
});

export const loadStoryArchive = (): StoryArchiveEntry[] => storyArchiveStore.read();
export const saveStoryArchive = (list: StoryArchiveEntry[]): void => storyArchiveStore.write(list);
export const clearStoryArchive = (): void => storyArchiveStore.clear();

/** 备份恢复：按 id 只补不覆盖，本机已有条目优先；收藏与顺序按统一规则重排。 */
export function mergeStoryArchives(
  current: readonly StoryArchiveEntry[],
  incoming: readonly StoryArchiveEntry[],
): StoryArchiveEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  return sortStoryArchive([...current, ...incoming.filter((entry) => !seen.has(entry.id))]);
}

/** 整包备份的短文段：导入后返回本次新增/保留数量，供恢复报告使用 */
export function importStoryArchiveBackup(incoming: unknown): { added: number; kept: number } {
  const fresh = decodeStoryArchive(incoming);
  const current = loadStoryArchive();
  const merged = mergeStoryArchives(current, fresh);
  saveStoryArchive(merged);
  const currentIds = new Set(current.map((entry) => entry.id));
  const mergedIds = new Set(merged.map((entry) => entry.id));
  const added = fresh.filter((entry) => !currentIds.has(entry.id) && mergedIds.has(entry.id)).length;
  const kept = fresh.filter((entry) => currentIds.has(entry.id)).length;
  return { added, kept };
}
