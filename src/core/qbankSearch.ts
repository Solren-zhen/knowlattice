/**
 * 题库搜题：跨题库按关键词找题（题干 / 选项 / 答案 / 解析 / 章节 / 关联笔记）。
 *
 * 为什么单独成模块、而不是塞进笔记全文检索（core/searchIndex）：
 *   笔记索引用 MiniSearch + bigram，文档是**长文**、数量在千级；
 *   而题库是**十万级短记录**（一份大题库就有十几万道题），且每道题的字段是
 *   固定的六类。给十万条建 MiniSearch 索引再逐键重建，代价与收益不成比例。
 *   这里改用「逐题 haystack 缓存 + 子串命中」：一次建好每题的小写 haystack
 *   （WeakMap 挂在题库对象上，重新导入会换对象、缓存自然失效），
 *   之后每次搜索只是一遍 indexOf——十万题在毫秒级。
 *
 * 匹配纪律（与 core/searchHit.locateAll 一致，可测）：
 *   · 查询按空白拆成多个词，**词与词是与关系**（都要命中）；
 *   · 每个词先查自身，查不到再展开等价词（core/medSynonyms 的 expandQuery），
 *     所以「心梗」能搜到写着「心肌梗死」的题；
 *   · 纯 ASCII 词按**词边界**匹配（"AMI" 不会在 "family" 里命中）；含 CJK 的词直接子串。
 * 命中字段按 题干→选项→答案→解析→章节→笔记 的优先级取第一个作为展示片段。
 */
import { chaptersOf, explanationsOf, type QuizBank, type QuizQuestion } from './qbank';
import { expandQuery } from './medSynonyms';
import { locateAll, type Hit } from './searchHit';

export type QuestionField = 'stem' | 'option' | 'answer' | 'explanation' | 'chapter' | 'note';

export const QUESTION_FIELD_LABELS: Record<QuestionField, string> = {
  stem: '题干',
  option: '选项',
  answer: '答案',
  explanation: '解析',
  chapter: '章节',
  note: '笔记',
};

export interface QuestionHit {
  bank: string;
  question: QuizQuestion;
  /** 命中的字段集合（题干优先展示，其余用于「命中选项/解析」提示） */
  fields: QuestionField[];
  /** 展示片段来自哪个字段：题干命中就是 'stem'，否则是首个命中的字段 */
  primary: QuestionField;
  /** 用于列表展示的文本（primary 字段的原文） */
  text: string;
  /** text 内的命中区间，供 <mark> 高亮（相对 text 的偏移） */
  hits: Hit[];
}

export interface SearchOptions {
  /** 每个题库最多返回多少条（默认 20） */
  perBank?: number;
  /** 全局最多返回多少条（默认 80） */
  limit?: number;
  /** 是否启用等价词扩展（默认 true；测试可关掉断言精确匹配） */
  expand?: boolean;
}

const DEFAULT_PER_BANK = 20;
const DEFAULT_LIMIT = 80;

/** 纯 ASCII 字母数字词：按词边界匹配，避免短缩写被更长单词吞掉 */
const isAsciiWord = (t: string): boolean => /^[a-z0-9]+$/.test(t);
const isAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 97 && c <= 122);

/**
 * hay 里是否含 term（hay 必须已小写）。
 * 纯 ASCII 词查词边界，其余直接子串——与 locateAll 的匹配语义保持一致，
 * 否则「搜得到但高亮不到」这种不一致最难解释。
 */
export function containsTerm(hay: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  if (!isAsciiWord(t)) return hay.includes(t);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(t, from);
    if (i < 0) return false;
    const before = i > 0 ? hay.charCodeAt(i - 1) : -1;
    const after = i + t.length < hay.length ? hay.charCodeAt(i + t.length) : -1;
    if ((before < 0 || !isAlnum(before)) && (after < 0 || !isAlnum(after))) return true;
    from = i + 1;
  }
}

/** 题目的可搜字段（保序，题干在最前） */
function fieldTexts(q: QuizQuestion): Array<[QuestionField, string]> {
  const out: Array<[QuestionField, string]> = [['stem', q.stem]];
  for (const o of q.options) if (o) out.push(['option', o]);
  if (q.answerText) out.push(['answer', q.answerText]);
  for (const e of explanationsOf(q)) if (e.text) out.push(['explanation', e.text]);
  const chapters = chaptersOf(q);
  if (chapters.length) out.push(['chapter', chapters.join(' ')]);
  if (q.note) out.push(['note', q.note]);
  return out;
}

const hayOf = (q: QuizQuestion): string =>
  fieldTexts(q).map(([, t]) => t).join('\n').toLowerCase();

/** 每题 haystack 缓存：WeakMap 挂在题库对象上，重新导入换对象即自动失效 */
const preparedCache = new WeakMap<QuizBank, string[]>();

function prepared(bank: QuizBank): string[] {
  let hays = preparedCache.get(bank);
  if (!hays) {
    hays = bank.questions.map(hayOf);
    preparedCache.set(bank, hays);
  }
  return hays;
}

/** 查询 → 每个原始词的候选集合（自身 + 等价词），已去空去重 */
export function termAlternatives(query: string, expand = true): string[][] {
  const rawTerms = query.trim().split(/\s+/).filter(Boolean);
  return rawTerms.map((term) => {
    const alts = expand ? expandQuery(term) : [term];
    return [...new Set(alts.map((a) => a.trim()).filter(Boolean))];
  });
}

function makeHit(q: QuizQuestion, bank: string, alts: string[][]): QuestionHit {
  const allAlts = [...new Set(alts.flat())];
  const texts = fieldTexts(q);
  const fields = new Set<QuestionField>();
  let primary: QuestionField = 'stem';
  let text = q.stem;
  let found = false;
  for (const [field, t] of texts) {
    if (!allAlts.some((a) => containsTerm(t.toLowerCase(), a))) continue;
    fields.add(field);
    if (!found) {
      found = true;
      primary = field;
      text = t;
    }
  }
  return { bank, question: q, fields: [...fields], primary, text, hits: locateAll(text, allAlts) };
}

/** 在单个题库里搜题（结果上限 perBank） */
export function searchBank(bank: QuizBank, query: string, opts: SearchOptions = {}): QuestionHit[] {
  const alts = termAlternatives(query, opts.expand !== false);
  if (!alts.length) return [];
  const perBank = opts.perBank ?? DEFAULT_PER_BANK;
  const hay = prepared(bank);
  const out: QuestionHit[] = [];
  for (let i = 0; i < bank.questions.length && out.length < perBank; i++) {
    // 词与词是与关系：每个原始词都要命中（命中任一等价词即可）
    if (!alts.every((group) => group.some((a) => containsTerm(hay[i], a)))) continue;
    out.push(makeHit(bank.questions[i], bank.name, alts));
  }
  return out;
}

/** 跨题库搜题：按传入顺序扫描，累计到 limit 条即停（默认 80） */
export function searchBanks(banks: QuizBank[], query: string, opts: SearchOptions = {}): QuestionHit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const perBank = opts.perBank ?? DEFAULT_PER_BANK;
  const out: QuestionHit[] = [];
  for (const bank of banks) {
    if (out.length >= limit) break;
    const room = Math.min(perBank, limit - out.length);
    if (room <= 0) break;
    out.push(...searchBank(bank, query, { ...opts, perBank: room }));
  }
  return out;
}
