/**
 * Anki 导入：把用户的存量 Anki 卡读进来（.apkg 二进制包 / Anki「导出为 .txt」的制表符文件）。
 *
 * 为什么要有这个模块：core/anki.ts 只做**导出**（notesToAnki / buildApkgBytes / exportApkg），
 * 全库没有任何反向读取代码，于是「Anki 里攒了几年的卡」进不了本项目——这是迁移路上第一块砖。
 * 它不 import ./anki：只共用 sql.js / jszip 两个依赖，避免导出逻辑被拖进来、也避免两边互相依赖。
 *
 * 三条设计取舍，都写在这里，免得后来者按「更聪明」的方式改坏：
 *
 * 1. **默认去向是笔记库，不是题库。** Anki 的 note 天然是「正面 / 背面」两段文字，
 *    与笔记（标题 + 正文）同构；而题库要求 options/answer/explanation 成套，
 *    Anki 的卡里并没有这套结构。硬猜成题会造出一堆选项为空、答案下标乱指的假题，
 *    污染统计与错题本。所以默认映射成笔记，题库只作为**可选出向**（notesToQuestions），
 *    并且只在字段 >= 2、第二个字段非空时才建。
 *
 * 2. **Cloze 必须转成本项目的 `{{答案}}`（见 core/cloze.ts），不能保留 `c1::`。**
 *    本项目复习界面只认 `{{}}` 一种标记：`maskCloze/revealCloze` 靠它遮答案、翻面还原。
 *    原样留下 `{{c1::答案}}`（去掉 c1 也只剩 `{{::答案}}`）时，正则 `\{\{([^{}\n]+)\}\}` 不认，
 *    用户会看到一段没被遮住的原句——**看起来导入成功了，挖空却全没了**，最难发现的一类失败。
 *    提示部分（`{{c1::答案::提示}}`）按"答案在前、其余忽略"处理，不把提示混进答案里。
 *
 * 3. **解析不出来就进 skipped 并说明原因，不猜。** 导入是不可逆操作（用户删掉原 Anki 就没有了），
 *    宁可少导入几条、把原因写清楚，也不要把半截内容拼成一条看起来正常的笔记/题目。
 *    每个 skipped 都带 `reason`（中文）与 `sample`（原始内容的短片段），界面可以直接展示。
 *
 * 兼容范围：`collection.anki2` 与 `collection.anki21`（同为 SQLite，flds 用 `\u001f` 分隔）；
 * 新版 Anki 导出的 `collection.anki21b`/`collection.anki2b` 是 zstd 压缩的单库，本模块不引新依赖去解，
 * 明确报错并让用户按 `collection.anki2` 重新导出（见 readApkg）。
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { notesToVaultFiles, type ImportNoteItem, type ImportToVaultResult } from './importToVault';

/** 从 .apkg 里读出来的一张卡（一个 Anki note = 一条） */
export interface ImportedNote {
  /** note 的字段值，按模型字段顺序；首字段通常是"正面/问题" */
  fields: string[];
  /** 模型名（Anki 里叫 note type），如 'Basic' */
  modelName: string;
  /** 空格分隔的标签，已 trim */
  tags: string[];
  /** 该 note 有几张卡（cloze 模型可能多张；拿不到就 1） */
  cards: number;
}

/** 一个 Anki 包的读取结果（.apkg 与 .txt 共用这个结构，界面只需处理一种） */
export interface ApkgContent {
  notes: ImportedNote[];
  /** 媒体文件名（media 清单里的值），本期只报告数量，不读文件内容 */
  mediaNames: string[];
  /** 用到的模型名，去重 */
  modelNames: string[];
  /**
   * 文本导入（.txt）里**没能读懂、被跳过**的行数（.apkg 走结构化读取，不会出现这个字段）。
   * 为什么单独报：非制表符分隔的导出会让每一行都切不出两列，若只说「没有读到任何卡片」，
   * 用户会以为文件选错了，而真正的原因在分隔符上（见 readAnkiTsv）。
   */
  skippedLines?: number;
}

/** 一条 note → 一篇笔记（默认去向：进笔记库） */
export interface MappedNote {
  title: string;
  body: string;
  tags: string[];
}

/** 批量映射结果：成功的进 items，失败的原样带原因进 skipped（导入界面把 skipped 列给用户看） */
export interface MapResult<T> {
  items: T[];
  skipped: Array<{ reason: string; sample: string }>;
}

/** Anki 字段分隔符（固定的 0x1f，不是可配置项） */
const FLD_SEP = '\u001f';
/** 标题截断长度：Anki 的正面常常是整段话，全塞进标题会把文件树撑爆 */
const TITLE_MAX = 80;
/** 模型名兜底：col.models 读不到时用的名字（不编造具体卡型） */
const UNKNOWN_MODEL = '(未知模型)';

// ---------- 文本清洗：Anki 字段是 HTML，本项目笔记是 markdown ----------

/** 常见 HTML 实体 → 字符（只覆盖笔记里真会出现的几个，不做通用解码） */
const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#34': '"',
  ldquo: '“',
  rdquo: '”',
};

/**
 * 去 HTML，得到本项目能直接用的纯文本：
 * - `<br>` / `</div>` / `</p>` → 换行（Anki 的换行几乎都在标签里，丢了它就成一大段）
 * - `<img ...>` 整个丢掉（本期不搬媒体文件，留下标签只会在正文里显示成乱码）
 * - 其余标签剥掉，保留内部文字
 * - HTML 实体解码（`&nbsp;` `&amp;` `&lt;` 等）
 */
function cleanField(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n') // 先统一换行
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Anki 挖空 → 本项目挖空：`{{c1::答案}}` / `{{c1::答案::提示}}` → `{{答案}}`。
 *
 * 两步做，且**必须先剥提示再脱壳**：若先把 `{{c1::答案::提示}}` 脱成 `{{答案::提示}}`，
 * 剩下的 `::` 会被拼进答案里，复习翻面看到的是「答案::提示」而不是答案。
 * 先按 `::` 切、只留第一段，就永远不会残留冒号。
 */
function ankiClozeToLocal(text: string): string {
  return text
    .replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (_m, _n: string, inner: string) => {
      const cut = inner.indexOf('::');
      const answer = cut >= 0 ? inner.slice(0, cut) : inner;
      return `{{${answer}}}`;
    })
    .replace(/\{\{c(\d+):([^{}]*)\}\}/g, '{{$2}}'); // 容错：老版本写成单冒号
}

/** 清洗单个字段：先转挖空、再去 HTML（顺序反了会把 `{{}}` 当标签处理掉的风险留给正则去赌） */
function cleanNoteField(raw: string): string {
  return cleanField(ankiClozeToLocal(raw));
}

/** 取第一行（标题来源）；全是空行时返回空串，由调用方判定 skipped */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

/** 解析失败时给用户看的片段：单行、最长 60 字，避免 skipped 列表里塞满整段 HTML */
function clip(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// ---------- 读 .apkg ----------

/**
 * 初始化 sql.js。与 core/anki.ts 用**同一套** `?url` 机制取打包后的 wasm 地址：
 * - Node（单测 / CLI）：不传 locateFile，sql.js 按自身模块目录找到同包内的 sql-wasm.wasm；
 * - 浏览器：sql.js 默认按 `new URL('sql-wasm.wasm', import.meta.url)` 去找，
 *   而浏览器里的 import.meta.url 是页面地址，落在站点根上必然 404，所以必须给 locateFile。
 *   `?url` 由打包器改写成本地 asset 的真实地址，因此**不需要往 public/ 放任何文件**；
 *   vitest 也走 Vite 的 transform，所以这条导入在单测里同样可用（core/anki.ts 就是这么做的）。
 * 实例缓存一份：每次导入都重新编译 wasm 会白等几百毫秒。
 */
let sqlPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
function initSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlPromise) {
    const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
    sqlPromise = initSqlJs(isNode ? {} : { locateFile: () => wasmUrl });
  }
  return sqlPromise;
}

/** sql.js 的值可能是 string | number | Uint8Array | null，这里只取文本 */
function text(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 解析 col.models：{ id: { name } } → 模型 id → 名字 */
function parseModelNames(modelsJson: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const models = JSON.parse(modelsJson) as Record<string, { name?: unknown } | null>;
    for (const [id, m] of Object.entries(models ?? {})) {
      if (m && typeof m.name === 'string' && m.name) out[id] = m.name;
    }
  } catch {
    // models 坏掉不该让整包读不出来：字段与标签都还在，只是模型名列不出来
  }
  return out;
}

/** 解析 media 清单：{"0":"a.png"} → 文件名列表（只取名字，**不读文件内容**） */
function parseMediaNames(mediaJson: string): string[] {
  try {
    const map = JSON.parse(mediaJson) as Record<string, unknown>;
    return Object.values(map ?? {}).filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * 读 .apkg 字节；结构不合法时抛出面向使用者的中文错误（不是英文异常栈）。
 *
 * 容错策略（每种情况都有明确出口）：
 * - 不是 zip / 字节为空 → 「不是有效的 .apkg 文件…」
 * - 缺 collection.anki2（含新版 Anki 的 collection.anki21b 压缩库） → 指名说缺什么、怎么重导
 * - 压缩库（.anki21b/.anki2b）→ 明确说不支持，让用户重导成 .anki2（不悄悄返回空结果）
 * - 没有 notes 表 → 「包里没有 notes 表…」（空集合的包会是这个错）
 * - flds 用 \u001f 分隔（Anki 固定约定）→ 直接切分
 * - cards 表缺失 / 某条 note 数不到卡 → cards 记 1（结构不完整不该让整包读不出来）
 * - col.models 损坏 → 模型名退化为「(未知模型)」，字段与标签照常给
 */
export async function readApkg(bytes: Uint8Array): Promise<ApkgContent> {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error('这个文件是空的，没读到任何内容。请重新导出 .apkg 后再试。');
  }

  // jszip 走动态 import：它只在用户真的导入 .apkg 时才需要下载。静态引入会把 jszip 塞进主包，
  // 破坏 core/anki.ts / core/vault.ts 已有的按需加载（构建期会报 INEFFECTIVE_DYNAMIC_IMPORT）。
  const { default: JSZipLib } = await import('jszip');
  const zip = await JSZipLib.loadAsync(bytes).catch(() => {
    // 解压失败要给出可执行的下一步，而不是把库里那句 "Corrupted zip" 直接甩给用户
    throw new Error('这不是有效的 .apkg 文件（解压失败）。请确认选择的是 Anki 导出的 .apkg，而不是 .txt 或压缩包外层的 .zip。');
  });

  const dbFile =
    zip.file('collection.anki2') ?? zip.file('collection.anki21');
  if (!dbFile) {
    if (zip.file('collection.anki21b') ?? zip.file('collection.anki2b')) {
      throw new Error('这个 .apkg 用的是新版 Anki 的压缩集合（collection.anki21b），本版本还不支持。请在 Anki 里重新导出，并勾选「支持旧版 Anki」/ 旧格式后再导入。');
    }
    throw new Error('这个 .apkg 里没有 collection.anki2（Anki 的卡库文件），无法读取卡片。可能文件不完整或来自其它软件。');
  }

  const dbBytes = await dbFile.async('uint8array');
  const SQL = await initSql();
  const db = new SQL.Database(dbBytes);
  try {
    const hasNotes = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").length > 0;
    if (!hasNotes) {
      throw new Error('这个 .apkg 的卡库里没有 notes 表，读不到任何卡片。可能是一个空集合，或导出的文件不完整。');
    }

    // 先看这张库里到底有哪些表：老库不一定有 col / cards（残缺导出、第三方转换都见过），
    // 直接 SELECT 会抛 "no such table" 并让整包读不出来——字段与标签明明还在，不该一起陪葬。
    const tables = new Set<string>();
    const tableRes = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (tableRes.length) {
      for (const row of tableRes[0].values) tables.add(text(row[0]));
    }

    let modelById: Record<string, string> = {};
    if (tables.has('col')) {
      const colRes = db.exec('SELECT models FROM col LIMIT 1');
      if (colRes.length && colRes[0].values.length) {
        modelById = parseModelNames(text(colRes[0].values[0][0]));
      }
    }

    const cardCount = new Map<string, number>();
    if (tables.has('cards')) {
      const cardRes = db.exec('SELECT nid, count(*) FROM cards GROUP BY nid');
      if (cardRes.length) {
        for (const row of cardRes[0].values) cardCount.set(text(row[0]), Number(row[1]) || 0);
      }
    }

    const notes: ImportedNote[] = [];
    const noteRes = db.exec('SELECT id, mid, tags, flds FROM notes');
    if (noteRes.length) {
      for (const row of noteRes[0].values) {
        const id = text(row[0]);
        const fields = text(row[3]).split(FLD_SEP);
        notes.push({
          fields,
          modelName: modelById[text(row[1])] ?? UNKNOWN_MODEL,
          tags: text(row[2]).split(/\s+/).filter(Boolean),
          cards: cardCount.get(id) ?? 1,
        });
      }
    }

    // 媒体清单是 zip 根下的 `media`（JSON 映射），只取名字
    const mediaFile = zip.file('media');
    const mediaNames = mediaFile ? parseMediaNames(await mediaFile.async('string')) : [];

    const modelNames = [...new Set(notes.map((n) => n.modelName))];
    return { notes, mediaNames, modelNames };
  } finally {
    db.close();
  }
}

// ---------- 读 Anki「导出为 .txt」（制表符） ----------

/**
 * Anki「导出为 .txt」的制表符文件（每行 正面<TAB>背面[<TAB>标签]）→ 等价结构。
 *
 * 该格式是**纯文本、无结构表**，所以模型名只能标成「Anki 文本导入」，
 * 字段按列切成 fields（保持与 readApkg 完全一样的下游形状，映射函数只需一套）。
 * 容错：CRLF、末尾空行、只有正面的半行（跳过）都按"宁可少一条也不猜"处理。
 * 字段内的 `<br>` 原样保留——它是 Anki 文本导出的换行，交给 cleanField 统一处理。
 */
/** Anki 文本导出的声明行：`#separator:comma` / `#tags column:3` / `#html:true` … */
const TSV_HEADER_RE = /^#\s*([a-zA-Z][a-zA-Z ]*?)\s*:\s*(.*)$/;
/**
 * 认得的声明键。**必须白名单**：正文首行完全可能是 `#定义: …` / `#1: …` 这类写法，
 * 只要见到 `#` 就当声明会把它整行吃掉（静默丢内容，正是本项目最忌讳的失败形态）。
 */
const TSV_HEADER_KEYS = new Set(['separator', 'tags column', 'columns', 'notetype', 'deck', 'html', 'guid column', 'media']);
/** 声明里的分隔符写法 → 真实分隔字符（Anki 写 `tab`/`comma`/… ，也可能直接写那个字符） */
const TSV_SEPARATORS: Record<string, string> = {
  tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':', slash: '/',
};

export function readAnkiTsv(raw: string): ApkgContent {
  const notes: ImportedNote[] = [];
  // 这两个默认值与加声明解析之前**逐字一致**：制表符分隔、第 3 列是标签。
  // 之所以要认声明：Anki 允许导出成逗号/分号/空格分隔，那样每一行都切不出两列，
  // 以前会被全部静默跳过（还提示用户「文件选错了」）——用户手里拿的明明是正确的导出文件。
  let separator = '\t';
  let tagsColumn = 3;
  let skippedLines = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue; // 空行
    // 声明行只在**第一条笔记出现之前**认
    if (!notes.length && line.startsWith('#')) {
      const m = TSV_HEADER_RE.exec(line);
      const key = m ? m[1].trim().toLowerCase() : '';
      if (m && TSV_HEADER_KEYS.has(key)) {
        const value = m[2].trim();
        if (key === 'separator') separator = TSV_SEPARATORS[value.toLowerCase()] ?? (value.slice(0, 1) || separator);
        else if (key === 'tags column') {
          const n = Number.parseInt(value, 10);
          // 0 = 这份导出没有标签列（Anki 允许），其余取正整数列号
          if (Number.isFinite(n) && n >= 0) tagsColumn = n;
        }
        continue; // 声明行本身不是卡片
      }
    }
    const cells = line.split(separator);
    if (cells.length < 2) { skippedLines++; continue; } // 只有一列：不是 Anki 的两列/三列格式，不猜
    const tags = tagsColumn > 0 ? (cells[tagsColumn - 1] ?? '').trim() : '';
    notes.push({
      // 字段切法与改动前等价：超过标签列时，把标签列及其后的所有列并成一个字段
      // （原来是 `cells.slice(0,2).concat(cells.slice(2).join('\t'))`，这里把 2 换成 tagsColumn-1，
      //   默认 tagsColumn=3 时逐字相同；多出来的列依然不会被拆散）
      fields: cells.length > tagsColumn
        ? cells.slice(0, tagsColumn - 1).concat(cells.slice(tagsColumn - 1).join(separator))
        : cells,
      modelName: 'Anki 文本导入',
      tags: tags ? tags.split(/\s+/).filter(Boolean) : [],
      cards: 1, // 文本导出不含卡数信息，保守记 1（接口注释里写明了"拿不到就 1"）
    });
  }
  return { notes, mediaNames: [], modelNames: [...new Set(notes.map((n) => n.modelName))], skippedLines };
}

// ---------- note → 笔记 ----------

/** 多字段拼接：字段各自 trim，空字段丢掉，用空行分隔（与笔记本里正文的写法一致） */
function joinFields(fields: string[]): string {
  return fields.filter(Boolean).join('\n\n');
}

/**
 * 一条 note → 一篇笔记。规则（可测、保守）：
 * - 字段先做 HTML/媒体/挖空清洗（见 cleanField / ankiClozeToLocal）
 * - 单字段模型 → 标题取正文第一行（截 80 字），body 是其余内容
 * - 多字段（含 Cloze）→ 标题取首字段第一行；body 是"首字段 + 其余字段"拼起来
 * - 空标题或空 body → 进 skipped，reason 用中文
 *
 * 为什么单字段也要拆出第一行当标题：笔记本里一篇笔记必须有标题（文件名），
 * 而单字段 Anki 卡（如 Cloze）的正面常常是"一句话 + 换行 + 补充"，首行最像标题。
 */
export function notesToNotes(notes: ImportedNote[]): MapResult<MappedNote> {
  const items: MappedNote[] = [];
  const skipped: Array<{ reason: string; sample: string }> = [];

  for (const note of notes) {
    const sample = clip(note.fields.join(' | '));

    if (!note.fields.length) {
      skipped.push({ reason: '没有字段内容', sample });
      continue;
    }

    const cleaned = note.fields.map(cleanNoteField);
    const first = cleaned[0] ?? '';
    const title = firstLine(first);

    if (!title) {
      skipped.push({ reason: '内容为空', sample: sample || '（全为空字段）' });
      continue;
    }

    let body: string;
    if (note.fields.length === 1) {
      // 单字段：首行做标题，其余做正文（正文为空则整条跳过，不留空笔记）
      body = first.split('\n').slice(1).join('\n').trim();
    } else {
      body = joinFields(cleaned);
    }

    if (!body) {
      skipped.push({ reason: '内容为空', sample: clip(first) || '（空字段）' });
      continue;
    }

    items.push({ title, body, tags: note.tags });
  }

  return { items, skipped };
}

// ---------- note → 题目（可选出向） ----------
/**
 * 选项行识别：行首"字母 + 分隔符"。
 * 只允许字母（不含数字）——真题里的数字多半是计量数据（`0.9% 氯化钠`），
 * 把它当选项会造出选项数对不上的假选择题，而这正是最该避免的"猜"。
 */
const OPTION_RE = /^\s*([A-Za-z])\s*[.、．,，:：)）]\s*\S/;

/** 题干里解析出的选项行 */
function parseOptions(stemText: string): { stem: string; options: string[] } {
  const lines = stemText.split('\n');
  const marks = lines.map((l) => OPTION_RE.exec(l)).map((m) => (m ? m[1].toUpperCase() : null));
  const found = marks.map((c, i) => ({ c, i })).filter((x) => x.c !== null);
  const none = { stem: stemText.trim(), options: [] as string[] };

  if (found.length < 2) return none; // 少于两项不算选择题

  const firstIdx = found[0].i;
  // 选项必须是连续的 A/B/C…（跳号说明这不是选项块，别硬切）
  for (let k = 0; k < found.length; k++) {
    if (found[k].c !== String.fromCharCode(65 + k)) return none;
  }

  // 选项块之前的题干行。最后一行由下面单独拼接（要剥掉行尾的「：」「—」等引导符），
  // 所以这里不能再包含它 —— 原来的 slice(0, firstIdx) 会把最后一行重复一遍。
  const before = lines.slice(0, Math.max(0, firstIdx - 1)).join('\n').trim();
  const options: string[] = [];
  for (let k = 0; k < found.length; k++) {
    const start = found[k].i;
    const end = k + 1 < found.length ? found[k + 1].i : lines.length;
    const block = lines.slice(start, end).join('\n').trim();
    // 去掉行首的字母标记，留下选项原文
    const textPart = block.replace(/^\s*[A-Za-z]\s*[.、．,，:：)）]\s*/, '').trim();
    if (!textPart) return none; // 空选项 → 解析失败，宁可不建题
    options.push(textPart);
  }

  const stem = [before, firstIdx > 0 ? lines[firstIdx - 1].replace(/[：:—-]\s*$/, '') : '']
    .filter(Boolean)
    .join('\n')
    .trim();
  return { stem: stem || stemText.trim(), options };
}

/** 从答案字段里取选项字母 → 下标集合（没有匹配的字母就返回空，调用方退回 recall） */
function answerIndicesFrom(answerText: string, count: number): number[] {
  const letters = answerText.toUpperCase().match(/[A-Z]/g) ?? [];
  const out = new Set<number>();
  for (const l of letters) {
    const idx = l.charCodeAt(0) - 65;
    if (idx >= 0 && idx < count) out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 一条 note → 一道题（可选出向：进题库）。规则同样保守：
 * - 只有字段数 >= 2、且第二个字段非空时才建题；题干=首字段，答案/解析=第二个字段
 * - 首字段里若含 `A.` `B.` 这类选项行，把它们解析成 options（>=2 项才算选择题），
 *   答案从答案字段里的字母取（取第一个命中的字母做 answer，多选题本项目的答案文本仍完整保留）
 * - 首字段有选项行但答案字段里找不到任何选项字母 → 仍按 recall 建（不猜字母）
 * - 解析不出选项 → 建成 recall（type:'recall', options:[], answer:-1, answerText=答案字段）
 * - 单字段 / 第二字段为空 → 进 skipped 并说明原因（Anki 的卡本来就不保证第二个字段是答案）
 */
export function notesToQuestions(
  notes: ImportedNote[],
  opts?: { chapter?: string }
): MapResult<{ stem: string; options: string[]; answer: number; answerText: string; explanation: string; chapter?: string }> {
  type Out = { stem: string; options: string[]; answer: number; answerText: string; explanation: string; chapter?: string };
  const items: Out[] = [];
  const skipped: Array<{ reason: string; sample: string }> = [];

  for (const note of notes) {
    const sample = clip(note.fields.join(' | '));

    if (note.fields.length < 2) {
      skipped.push({ reason: '只有一列字段，无法确定答案', sample });
      continue;
    }

    const stemText = cleanNoteField(note.fields[0] ?? '');
    const answerText = cleanNoteField(note.fields[1] ?? '');

    if (!stemText) {
      skipped.push({ reason: '题干为空', sample });
      continue;
    }
    if (!answerText) {
      skipped.push({ reason: '第二个字段为空，没有答案', sample: clip(stemText) });
      continue;
    }

    const { stem, options } = parseOptions(stemText);
    const idx = options.length ? answerIndicesFrom(answerText, options.length) : [];
    const isChoice = options.length >= 2 && idx.length > 0;

    items.push({
      stem: stem || stemText,
      options: isChoice ? options : [],
      answer: isChoice ? idx[0] : -1,
      answerText,
      explanation: answerText,
      ...(opts?.chapter ? { chapter: opts.chapter } : {}),
    });
  }

  return { items, skipped };
}

// ---------- 摘要 ----------

/**
 * 导入前的摘要，给界面显示"我要吃进去的是什么"。
 * 刻意只报**能确证**的数字（note 数、模型名、媒体文件数），不报"将生成多少张卡"——
 * cards 字段在部分包里拿不到（退化为 1），把估算当事实写出来会误导用户。
 */
export function apkgSummary(content: ApkgContent): string {
  if (!content.notes.length) {
    // 有跳过行时要说清是「格式对不上」还是「文件里真没内容」——这两种情况用户要做的事完全不同
    if (content.skippedLines) {
      return `读到了 ${content.skippedLines} 行，但没有一行能切成两列以上——分隔符可能不是制表符（Anki 文本导出默认用制表符，也可以选逗号 / 分号 / 空格，请按导出时选的那一种核对）。`;
    }
    return '这个文件里没有读到任何卡片。请确认导出的是 Anki 的 .apkg 或「导出为 .txt」，且包里确实有笔记。';
  }
  const parts = [`共 ${content.notes.length} 条笔记`];
  if (content.modelNames.length) parts.push(`模型：${content.modelNames.join('、')}`);
  parts.push(content.mediaNames.length ? `媒体文件 ${content.mediaNames.length} 个（本期不导入）` : '无媒体文件');
  if (content.skippedLines) parts.push(`${content.skippedLines} 行没读懂（已跳过：每行至少要能切成两列）`);
  return parts.join('；');
}

// ---------- 组装落盘文件（写盘交给共用模块） ----------

/**
 * 导入资料的默认落点。
 * 集中放在一个目录里，用户一眼能看出"这些是外来的"，
 * 也便于整批删除/重导——散落到各章节目录里就再也认不出来了。
 *
 * ⚠️ 这里**不带前导点**，与最初设想的 `.imported/anki` 不同，原因在共用模块上：
 * importToVault.notesToVaultFiles 会用 knowledgePack.safeDir 校验目录，而 safeSegment
 * 明确不允许以 `.` 开头的路径段（"隐藏/系统目录"）。传 `.imported/anki` 会命中它的
 * 「目录本身不安全 → 整批都不写」分支，结果是**每条都进 skipped、一篇都不落盘**。
 * 用户看到的是"导入成功、新增 0 篇"，属于本项目最忌讳的那类失败（看起来成功、其实什么都没做）。
 * 所以默认落点定为 `imported/anki`：同样集中、同样一眼看出是外来资料，且真能落盘。
 * 若以后 safeSegment 放开隐藏目录，把这一行改回 `.imported/anki` 即可（只此一处）。
 */
const ANKI_IMPORT_DIR = 'imported/anki';

/**
 * 标签里被当作「章节」的键名。
 * 与 core/qbank.ts 导入题库时的候选键（`chapter` / `章节` / `科目`）保持同一套写法：
 * 两处各定一套，用户就会遇到"题库导入认章节、Anki 导入不认"这类不一致。
 * 必须是 `键:值` 形式（Anki 标签不允许含空格，所以这种标记正好合法）。
 * **不做模糊猜测**：光看标签文字猜不出哪个是章节，猜错会把统计热力图分错组，
 * 而分错组的图看起来完全正常——这类错误事后几乎无法发现。
 */
const CHAPTER_TAG_RE = /^(?:chapter|章节|科目)\s*[:：]\s*(.+)$/i;

/** 从 Anki 标签里取章节：只认显式的 `章节:生理学` 这类标记，取不到返回空串（不猜） */
function chapterOf(tags: string[]): string {
  for (const t of tags) {
    const m = CHAPTER_TAG_RE.exec(t.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

/** 默认来源标注：`Anki 导入（Basic、Cloze）`；模型名单拿不到时退化为 `Anki 导入` */
function defaultSourceNote(modelNames: string[]): string {
  const models = modelNames.map((m) => m.trim()).filter(Boolean);
  return models.length ? `Anki 导入（${models.join('、')}）` : 'Anki 导入';
}

/**
 * .apkg / .txt 内容 → 可直接交给 vault.importMdFiles 的文件列表。
 * - 默认把每条 Anki note 变成一篇笔记（而不是一道题）：笔记是唯一事实来源，
 *   进笔记后自动获得复习卡、Anki 导出、错题归位、全文检索等既有联动
 *   （题库是另一条可选出向，见 notesToQuestions；本函数不替用户做这个决定）。
 * - `dir` 默认 `imported/anki`（导入的资料集中放，便于用户一眼看出"这些是外来的"；
 *   为什么不是最初写的 `.imported/anki`，见 ANKI_IMPORT_DIR 的注释——共用模块拒绝隐藏目录）
 * - `sourceNote` 会被写进每篇的 source 字段，默认 `Anki 导入（<模型名列表>）`
 * - 映射失败/内容为空的条目走 skipped，reason 用中文
 *
 * 路径安全、重名处理、frontmatter 组装**全部委托给 notesToVaultFiles**：
 * 那是三条导入入口（Anki、同业题库、结构化数据集）共用的写盘通道，
 * 这里再实现一遍必然分叉——"从 A 入口进来的能抽查，从 B 入口进来的不能"。
 * 所以本函数只做两件事：note → ImportNoteItem 的形状转换，以及把两处 skipped 合并报出。
 */
export function apkgToVaultFiles(
  content: ApkgContent,
  opts?: { dir?: string; sourceNote?: string }
): ImportToVaultResult {
  const mapped = notesToNotes(content.notes);
  const items: ImportNoteItem[] = mapped.items.map((n) => {
    const chapter = chapterOf(n.tags);
    // 不猜章节：标签里没有 `章节:` 这类显式标记时**不带 chapter 键**（写出来是空值）
    return { title: n.title, body: n.body, tags: n.tags, ...(chapter ? { chapter } : {}) };
  });

  const sourceNote = (opts?.sourceNote ?? '').trim() || defaultSourceNote(content.modelNames);
  const res = notesToVaultFiles(items, { dir: opts?.dir ?? ANKI_IMPORT_DIR, sourceNote });

  return {
    files: res.files,
    skipped: [
      // 映射阶段跳过的条目只有 sample（截断的原始片段），拿它当标题报给用户；
      // 一条都不报才是真的糟糕——用户不知道少了什么
      ...mapped.skipped.map((s) => ({ title: s.sample || '(无法映射)', reason: s.reason })),
      // 共用模块自己跳过的（标题含非法字符、重名、目录不安全）原样带上
      ...res.skipped,
    ],
    // 标题被清洗的记录也要传出去：入口处若只报「新增 N 篇」，用户会以为标题一字未改
    renamed: res.renamed,
  };
}
