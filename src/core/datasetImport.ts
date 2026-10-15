/**
 * 结构化数据集导入：把用户自己带来的 JSON「数据集」变成可复习、可检索的笔记。
 *
 * 为什么切三类：同类备考 App 随包分发的结构化数据，用途几乎都落在这三种上——
 *   1) symptom-disease 症状→疾病对照：看到症状能想起哪些疾病，是串联记忆的主干；
 *   2) mnemonic 口诀/记忆术库：短句、要点罗列，天然适合挖空与反复背诵；
 *   3) term-list 中英术语表：术语检索与对照。
 * 各家字段名中英混用、单复数混用、层级深浅不一，所以**认字段要宽容**（本模块的探测与映射），
 * 但**产出形态必须统一**（写死的中文标签行 + 统一标题/章节），否则「从哪个入口导进来的笔记
 * 能不能进复习卡」就会随来源而变，事后极难解释。故本模块只做格式搬运，写盘一律交给
 * core/importToVault 的 notesToVaultFiles——那条通道自带 L1 复习卡、Anki 导出、检索、图谱等联动。
 *
 * 为什么**必须**带来源标注（版权预防）：本模块**不随包分发任何第三方内容**，文件由用户自己提供；
 * 但一旦进了笔记库，它就会被复习、被导出、被分享，甚至被再次分发。因此每篇笔记都强制写入
 * frontmatter 的 `source`（由 notesToVaultFiles 保证，本模块不另起炉灶），
 * 让「这份资料从哪来」永远跟着笔记走、在任何界面都看得见，不会被误当成使用者自己的原创。
 *
 * 为什么不改写原文：导入器只搬运位置、不改写、不润色。把字段名换成笔记里的中文标签、
 * 把疾病名包成 [[双链]] 属于格式适配（链接文字仍是原名，一个字没动），
 * 出问题时可以与源文件逐字对照。疾病名允许指向还不存在的笔记：用户之后可以补。
 *
 * 纯函数、零项目依赖（只 import ./importToVault 与标准库），不碰 DOM / localStorage。
 */
import {
  notesToVaultFiles,
  type ImportNoteItem,
  type ImportToVaultResult,
  type VaultFile,
} from './importToVault';

export type DatasetKind = 'symptom-disease' | 'mnemonic' | 'term-list' | 'unknown';

export interface DatasetDetection {
  kind: DatasetKind;
  /** 0-1；unknown 一律 0 */
  confidence: number;
  /** 命中的依据（中文，写明字段名），界面可直接展示，让用户能核对也能反驳 */
  evidence: string[];
  /** 预计能产出多少条（取 datasetToNotes 的实际条数，所以不会与后续写盘结果对不上） */
  count: number;
}

type JsonObject = Record<string, unknown>;

/** 条目列表的来源：数组本身，或对象里某个数组字段（context 是去掉该字段后的其余外层字段） */
interface EntrySource {
  entries: unknown[];
  context: JsonObject | null;
  /** 命中列表用的字段名，用于判断「是不是术语列表」 */
  listKey: string | null;
}

interface KindScore {
  kind: DatasetKind;
  score: number;
  evidence: string[];
}

/** 低于此分不认：宁可说「没识别出来」，也不要把无关 JSON 硬塞进笔记库（不猜） */
const MIN_CONFIDENCE = 0.3;

/** 探测只看前若干条，避免在几万条的数据集上做无谓的全量扫描 */
const SAMPLE_SIZE = 5;

/** 各类数据集的展示名（界面与总结文案共用） */
const KIND_LABELS: Record<DatasetKind, string> = {
  'symptom-disease': '症状→疾病对照',
  mnemonic: '口诀/记忆术',
  'term-list': '术语表',
  unknown: '未识别',
};

/** 外层列表字段候选（对象里哪个键下藏着条目数组） */
const LIST_KEYS: string[] = [
  'entries',
  '列表',
  'items',
  'data',
  'list',
  'records',
  'rows',
  'terms',
  '术语',
  '词条',
];

/** 症状→疾病：症状名、疾病名、分类 */
const SYMPTOM_KEYS: string[] = ['symptom', '症状'];
const DISEASE_KEYS: string[] = ['diseases', 'diseasesRaw', '疾病'];
const SYMPTOM_CATEGORY_KEYS: string[] = ['category', '分类', '系统'];

/** 口诀：关键词、分类、内容、口诀本身，以及组成/功用/主治这类分项 */
const KEYWORD_KEYS: string[] = ['keyword', '关键词', '名称'];
const MNEMONIC_CATEGORY_KEYS: string[] = ['category', '分类', '专科'];
const MNEMONIC_KEYS: string[] = ['mnemonic', '口诀', '助记'];
const DETAIL_KEYS: string[] = ['detail', '内容', '详情'];
const COMPOSITION_KEYS: string[] = ['composition', '组成'];
const FUNCTION_KEYS: string[] = ['function', '功用', '功效'];
const INDICATION_KEYS: string[] = ['indication', '主治', '适应症', '适应证'];
const SOURCE_KEYS: string[] = ['source', '出处', '来源'];

/** 口诀数据集允许把元信息放在外层（{ specialty, source_note, entries }） */
const OUTER_SPECIALTY_KEYS: string[] = ['specialty', '专科', '分类'];
const OUTER_SOURCE_KEYS: string[] = ['source_note', '来源', '出处', 'source'];

/** 术语：中英、备注、分类、词条列表、文档标题 */
const EN_KEYS: string[] = ['en', '英文'];
const ZH_KEYS: string[] = ['zh', '中文'];
const NOTE_KEYS: string[] = ['note', '备注'];
const TERM_CATEGORY_KEYS: string[] = ['category', '分类'];
const TERM_LIST_KEYS: string[] = ['terms', '术语', '词条'];
const TITLE_KEYS: string[] = ['title', '标题'];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 宽容取文本：字符串去首尾空白，数字/布尔转字符串（数据集里常见 1/true 当值） */
function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 按候选字段名取第一个非空文本；取不到返回 ''（调用方据此决定要不要写这一行） */
function pickText(obj: JsonObject | null | undefined, keys: string[]): string {
  if (!isObject(obj)) return '';
  for (const key of keys) {
    const text = asText(obj[key]);
    if (text) return text;
  }
  return '';
}

/** 按候选字段名取第一个非空原始值（数组按「非空数组」算非空），用于疾病列表、词条列表 */
function pickValue(obj: JsonObject | null | undefined, keys: string[]): unknown {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value) ? value.length > 0 : asText(value)) return value;
  }
  return undefined;
}

/**
 * 值 → 字符串列表：数组直接取，字符串按顿号/逗号/分号/换行拆（数据集里两种写法都很常见）。
 * 同名重复只保留一次——否则正文里会出现「[[甲]]、[[甲]]」这种双链接噪声。
 */
function toList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => asText(v))
    : asText(value).split(/[、,，;；\n]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 写一行「- 标签: 值」；值为空就整行不写（缺失的键不留空行） */
function pushLine(lines: string[], label: string, value: string): void {
  if (value) lines.push(`- ${label}: ${value}`);
}

/** 双链文案；源文件里已经写成 [[甲]] 的不再套一层 */
function toLink(name: string): string {
  return name.startsWith('[[') && name.endsWith(']]') ? name : `[[${name}]]`;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return '数组';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'object') return '对象';
  if (type === 'string') return '字符串';
  if (type === 'number') return '数字';
  if (type === 'boolean') return '布尔值';
  return '未知类型';
}

/** 字符串输入按 JSON 文本解析；其它类型原样使用（不抛错，失败由调用方按「命中 0 条」展示） */
function parseJsonValue(raw: unknown): { ok: boolean; value: unknown } {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  const text = raw.trim();
  if (!text) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * 找出条目数组：数组原样用；对象先看候选列表字段；再退一步看任意「元素是对象」的数组字段；
 * 都没有时把对象本身当成一条记录（单条数据集）。context 保留外层字段，供条款目的分类/来源用。
 */
function locateEntries(value: unknown): EntrySource | null {
  if (Array.isArray(value)) return { entries: value, context: null, listKey: null };
  if (!isObject(value)) return null;
  for (const key of LIST_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      const context: JsonObject = { ...value };
      delete context[key];
      return { entries: candidate, context, listKey: key };
    }
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (Array.isArray(candidate) && candidate.length > 0 && isObject(candidate[0])) {
      const context: JsonObject = { ...value };
      delete context[key];
      return { entries: candidate, context, listKey: key };
    }
  }
  return { entries: [value], context: null, listKey: null };
}

function sampleObjects(entries: unknown[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const entry of entries) {
    if (isObject(entry)) out.push(entry);
    if (out.length >= SAMPLE_SIZE) break;
  }
  return out;
}

function scoreSymptomDisease(sample: JsonObject[]): KindScore {
  const evidence: string[] = [];
  let score = 0;
  const withSymptom = sample.filter((o) => pickText(o, SYMPTOM_KEYS)).length;
  if (withSymptom > 0) {
    score += 0.45;
    evidence.push(`${withSymptom}/${sample.length} 条含字段 symptom/症状`);
  }
  const withDiseases = sample.filter((o) => toList(pickValue(o, DISEASE_KEYS)).length > 0).length;
  if (withDiseases > 0) {
    score += 0.45;
    evidence.push(`${withDiseases}/${sample.length} 条含字段 diseases/diseasesRaw/疾病`);
  }
  if (withSymptom > 0 && withDiseases > 0) {
    score += 0.1 * (Math.min(withSymptom, withDiseases) / sample.length);
    evidence.push('症状与疾病字段出现在同一条里（症状→疾病对照的特征）');
  }
  return { kind: 'symptom-disease', score, evidence };
}

function scoreMnemonic(sample: JsonObject[], context: JsonObject | null): KindScore {
  const evidence: string[] = [];
  let score = 0;
  const withKeyword = sample.filter((o) => pickText(o, KEYWORD_KEYS)).length;
  if (withKeyword > 0) {
    score += 0.4;
    evidence.push(`${withKeyword}/${sample.length} 条含字段 keyword/关键词/名称`);
  }
  const withMnemonic = sample.filter((o) => pickText(o, MNEMONIC_KEYS)).length;
  if (withMnemonic > 0) {
    score += 0.35;
    evidence.push(`${withMnemonic}/${sample.length} 条含字段 mnemonic/口诀/助记`);
  }
  const withDetail = sample.filter((o) => pickText(o, DETAIL_KEYS)).length;
  if (withDetail > 0) {
    score += 0.15;
    evidence.push(`${withDetail}/${sample.length} 条含字段 detail/内容/详情`);
  }
  const withParts = sample.filter(
    (o) =>
      pickText(o, COMPOSITION_KEYS) || pickText(o, FUNCTION_KEYS) || pickText(o, INDICATION_KEYS)
  ).length;
  if (withParts > 0) {
    score += 0.05;
    evidence.push(`${withParts}/${sample.length} 条含组成/功用/主治分项字段`);
  }
  if (pickText(context, OUTER_SPECIALTY_KEYS) || pickText(context, OUTER_SOURCE_KEYS)) {
    score += 0.05;
    evidence.push('外层含专科或来源说明字段（specialty/专科、source_note/来源）');
  }
  return { kind: 'mnemonic', score, evidence };
}

function scoreTermList(
  sample: JsonObject[],
  context: JsonObject | null,
  listKey: string | null
): KindScore {
  const evidence: string[] = [];
  let score = 0;
  const withPair = sample.filter((o) => pickText(o, EN_KEYS) && pickText(o, ZH_KEYS)).length;
  if (withPair > 0) {
    score += 0.45;
    evidence.push(`${withPair}/${sample.length} 条含字段 en/英文 与 zh/中文`);
  }
  const nestedTerms = sample.filter((o) => Array.isArray(pickValue(o, TERM_LIST_KEYS))).length;
  const listIsTerms = listKey !== null && TERM_LIST_KEYS.includes(listKey);
  if (nestedTerms > 0 || listIsTerms) {
    score += 0.45;
    evidence.push(
      nestedTerms > 0
        ? `${nestedTerms}/${sample.length} 条含字段 terms/术语（词条数组）`
        : `外层列表字段是 terms/术语（词条数组）`
    );
  }
  const withNote = sample.filter((o) => pickText(o, NOTE_KEYS)).length;
  if (withNote > 0) {
    score += 0.05;
    evidence.push(`${withNote}/${sample.length} 条含字段 note/备注`);
  }
  if (pickText(context, [...TITLE_KEYS, 'docId', 'id'])) {
    score += 0.05;
    evidence.push('外层含 docId/id 或 title/标题（文档形态的术语表）');
  }
  return { kind: 'term-list', score, evidence };
}

/**
 * 探测 JSON 属于哪类数据集：只看字段组合，不看内容语义（不猜）。
 * 认不出来就返回 unknown，并在 evidence 里说清缺哪些字段，界面可以据此提示用户。
 */
export function detectDataset(raw: unknown): DatasetDetection {
  const parsed = parseJsonValue(raw);
  if (!parsed.ok) {
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: ['输入不是合法 JSON（文本输入需为 JSON 文本），无法解析'],
      count: 0,
    };
  }
  const src = locateEntries(parsed.value);
  if (!src) {
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: [
        `顶层是${describeType(parsed.value)}，既不是数组，也没有 entries/列表、terms/术语 这类列表字段`,
      ],
      count: 0,
    };
  }
  if (src.entries.length === 0) {
    return { kind: 'unknown', confidence: 0, evidence: ['找到了列表字段，但列表为空，没有条目可导入'], count: 0 };
  }
  const sample = sampleObjects(src.entries);
  if (sample.length === 0) {
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: [`列表里有 ${src.entries.length} 项，但没有一项是对象，取不到字段`],
      count: 0,
    };
  }
  const scores: KindScore[] = [
    scoreSymptomDisease(sample),
    scoreMnemonic(sample, src.context),
    scoreTermList(sample, src.context, src.listKey),
  ];
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < MIN_CONFIDENCE) {
    return {
      kind: 'unknown',
      confidence: 0,
      evidence: [
        `读到 ${sample.length} 条记录，但没有命中任何一类数据集的字段组合`,
        '症状→疾病：需要 symptom/症状 与 diseases/diseasesRaw/疾病',
        '口诀：需要 keyword/关键词/名称，或 mnemonic/口诀/助记，或 detail/内容/详情',
        '术语：需要 en/英文 与 zh/中文，或 terms/术语 列表',
      ],
      count: 0,
    };
  }
  return {
    kind: best.kind,
    confidence: Math.min(1, Math.round(best.score * 100) / 100),
    evidence: best.evidence,
    count: datasetToNotes(parsed.value, best.kind).length,
  };
}

/**
 * 数据集 → 导入用的笔记条目（纯函数，只搬运不改写）。
 * 解析不出任何条目时返回空数组（不抛错——调用方按「命中 0 条」给用户看）；
 * kind 为 unknown 时同样返回空数组（不猜）。
 */
export function datasetToNotes(raw: unknown, kind: DatasetKind): ImportNoteItem[] {
  if (kind === 'unknown') return [];
  const parsed = parseJsonValue(raw);
  if (!parsed.ok) return [];
  const src = locateEntries(parsed.value);
  if (!src || src.entries.length === 0) return [];
  if (kind === 'symptom-disease') return symptomDiseaseNotes(src);
  if (kind === 'mnemonic') return mnemonicNotes(src);
  if (kind === 'term-list') return termListNotes(src);
  return [];
}

/** 症状→疾病：一条症状一篇笔记，疾病名写成 [[双链]]（允许指向还不存在的笔记） */
function symptomDiseaseNotes(src: EntrySource): ImportNoteItem[] {
  const items: ImportNoteItem[] = [];
  for (const entry of src.entries) {
    if (!isObject(entry)) continue;
    const symptom = pickText(entry, SYMPTOM_KEYS);
    // 没有症状名就没有标题，构不成一篇笔记（写盘层也无从命名）
    if (!symptom) continue;
    const diseases = toList(pickValue(entry, DISEASE_KEYS));
    const body = diseases.length ? `- 相关疾病: ${diseases.map(toLink).join('、')}` : '';
    items.push({ title: symptom, body, chapter: pickText(entry, SYMPTOM_CATEGORY_KEYS) });
  }
  return items;
}

/** 口诀：一条口诀一篇笔记，正文只有实际存在的行（出处/组成/功用/主治/口诀） */
function mnemonicNotes(src: EntrySource): ImportNoteItem[] {
  const items: ImportNoteItem[] = [];
  for (const entry of src.entries) {
    if (!isObject(entry)) continue;
    const keyword = pickText(entry, KEYWORD_KEYS);
    if (!keyword) continue;
    const lines: string[] = [];
    pushLine(lines, '出处', pickText(entry, SOURCE_KEYS) || pickText(src.context, OUTER_SOURCE_KEYS));
    pushLine(lines, '组成', pickText(entry, COMPOSITION_KEYS));
    pushLine(lines, '功用', pickText(entry, FUNCTION_KEYS));
    pushLine(lines, '主治', pickText(entry, INDICATION_KEYS));
    // 口诀优先取专用字段，没有才退到通用内容字段（detail/内容/详情），避免正文空着
    pushLine(lines, '口诀', pickText(entry, MNEMONIC_KEYS) || pickText(entry, DETAIL_KEYS));
    items.push({
      title: keyword,
      body: lines.join('\n'),
      chapter: pickText(entry, MNEMONIC_CATEGORY_KEYS) || pickText(src.context, OUTER_SPECIALTY_KEYS),
    });
  }
  return items;
}

/** 一条词条 → 一篇笔记；中英都没有就没有标题，交给调用方按「命中 0 条」处理 */
function termItem(term: JsonObject, chapter: string): ImportNoteItem | null {
  const en = pickText(term, EN_KEYS);
  const zh = pickText(term, ZH_KEYS);
  // 标题：中文优先，其次英文，最后才用 title/标题兜底（扁平数组与文档形态都可能只给标题）
  const title = zh || en || pickText(term, TITLE_KEYS);
  if (!title) return null;
  const lines: string[] = [];
  pushLine(lines, '英文', en);
  pushLine(lines, '中文', zh);
  pushLine(lines, '备注', pickText(term, NOTE_KEYS));
  return { title, body: lines.join('\n'), chapter };
}

/** 术语表：记录自带 terms/术语 就算文档形态（一条记录一组词条），否则记录本身就是词条 */
function termListNotes(src: EntrySource): ImportNoteItem[] {
  const items: ImportNoteItem[] = [];
  for (const record of src.entries) {
    if (!isObject(record)) continue;
    const ownChapter = pickText(record, TERM_CATEGORY_KEYS) || pickText(src.context, TERM_CATEGORY_KEYS);
    const nested = pickValue(record, TERM_LIST_KEYS);
    if (Array.isArray(nested)) {
      // 文档形态：记录自己的 title/标题 当章节兜底，免得它随导入消失
      const chapter = ownChapter || pickText(record, TITLE_KEYS);
      for (const term of nested) {
        if (!isObject(term)) continue;
        const item = termItem(term, chapter);
        if (item) items.push(item);
      }
      continue;
    }
    const item = termItem(record, ownChapter || pickText(src.context, TITLE_KEYS));
    if (item) items.push(item);
  }
  return items;
}

/**
 * 一步到位：数据集文本 → 可写盘文件。内部走 notesToVaultFiles，
 * 因此每个文件都自带 frontmatter 的 `source`（来源标注是不可跳过的预防措施）。
 * opts.kind 可由界面覆盖探测结果（用户比探测更懂自己的文件）。
 */
export function datasetToVaultFiles(
  raw: unknown,
  opts: { kind?: DatasetKind; dir?: string; sourceNote: string }
): ImportToVaultResult & { detection: DatasetDetection } {
  const detected = detectDataset(raw);
  const kind: DatasetKind = opts.kind && opts.kind !== 'unknown' ? opts.kind : detected.kind;
  const items = datasetToNotes(raw, kind);
  const forced = kind !== detected.kind;
  const detection: DatasetDetection = {
    kind,
    confidence: forced ? 0.5 : detected.confidence,
    evidence: forced
      ? [`调用方指定为${KIND_LABELS[kind]}数据集`, ...detected.evidence]
      : detected.evidence,
    // count 一律取实际产出的条数：探测说能导 3 条、结果只写出 2 篇，是最难解释的那种不一致
    count: items.length,
  };
  // renamed 一并透出：标题里的非法字符是被清洗（而不是整条丢弃）的，得让用户看得见改成了什么
  const { files, skipped, renamed } = notesToVaultFiles(items, {
    dir: opts.dir,
    sourceNote: opts.sourceNote,
  });
  return { files, skipped, renamed, detection };
}

/** 给界面用的一句话：识别成什么、能导入多少、跳过了多少、来源是什么 */
export function datasetSummary(
  res: {
    detection: DatasetDetection;
    files: VaultFile[];
    skipped: Array<{ reason: string }>;
  },
  sourceNote: string
): string {
  const head =
    res.detection.kind === 'unknown'
      ? '未能识别数据集类型'
      : `识别为${KIND_LABELS[res.detection.kind]}数据集`;
  return `${head} · 可导入 ${res.files.length} 篇 · 跳过 ${res.skipped.length} 篇 · 来源：${sourceNote}`;
}
