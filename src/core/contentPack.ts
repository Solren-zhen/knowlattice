/**
 * 内容包（`kq.pack.v1`）→ 本应用题库字段的**纯映射**。
 *
 * 为什么单独一层：导出侧给的是中立结构（题干/选项/解析都写成「块数组」，图片只给稳定 ref），
 * 落库侧（core/qbank）认的是 stem/options/answer/… 这套字段名。两边都要能各自演进，
 * 所以中间放一层不碰 DOM、不读文件、不写存储的纯函数——单测直接喂对象就能覆盖。
 *
 * 本层只做**字段改名与结构展平**，不改写一个字的内容：题干、选项、解析、知识点都是原样搬运。
 * 图片是唯一例外：这里只交回 ref（落库要写文件，属于调用方的事），
 * 位置对不上的（比如解析正文里的图，题库模型没有对应字段）如实计数交回，不静默丢。
 */
import { normalizeQuestions } from './qbank';
import type { QuizQuestion } from './qbank';

/** 内容包的 format 标记；与导出侧 out/index.json 的 format 字段同值 */
export const CONTENT_PACK_FORMAT = 'kq.pack.v1';

export type ContentPackRole = 'index' | 'unit' | 'bundle' | 'unknown';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 合集（bundle）：把整个包的几十个单元塞进一个文件。
 *  存在理由——「选一整个文件夹」依赖 webkitdirectory，某些环境里拿不到文件列表，
 *  而单元文件有三百多个，让用户一个个选等于没法用。一个文件就是一个包。 */
export function isPackBundle(raw: unknown): boolean {
  const o = asRecord(raw);
  if (!o || !Array.isArray(o.units) || !o.units.length) return false;
  const first = asRecord(o.units[0]);
  return !!first && Array.isArray(first.items);
}

/** 合集里的单元列表（剔除形状不对的） */
export function packBundleUnits(raw: unknown): unknown[] {
  const o = asRecord(raw);
  return Array.isArray(o?.units) ? o.units.filter((u) => !!asRecord(u)) : [];
}

/** 一份 .json 在内容包里扮演什么角色：索引 / 单元 / 合集 / 不是内容包。
 *  单元按形状认（unitId + items）而不是只认 format 标记：早期导出的单元文件没带标记，
 *  只认标记会把它们丢进题库通道，报一句「没识别出题目」——用户拿到的是误导性的失败原因。 */
export function detectContentPack(raw: unknown): ContentPackRole {
  const o = asRecord(raw);
  if (!o) return 'unknown';
  if (isPackBundle(raw)) return 'bundle';
  if (o.format === CONTENT_PACK_FORMAT && Array.isArray(o.units)) return 'index';
  if (typeof o.unitId === 'string' && Array.isArray(o.items)) return 'unit';
  return 'unknown';
}

/** 块数组里的文字（块之间用换行连，保留原始分行） */
function blocksText(v: unknown): string {
  if (!Array.isArray(v)) return '';
  const parts: string[] = [];
  for (const b of v) {
    const rec = asRecord(b);
    if (!rec) continue;
    if (rec.t === 'text' && typeof rec.v === 'string') parts.push(rec.v);
  }
  return parts.join('\n').trim();
}

/** 块数组里的图片 ref（按出现顺序） */
function blocksRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const b of v) {
    const rec = asRecord(b);
    if (rec && rec.t === 'image' && typeof rec.v === 'string' && rec.v) out.push(rec.v);
  }
  return out;
}

/** 单元在某题库列表里显示的名字：科目 · 分组 · 标题 */
export function packUnitTitle(raw: unknown): string {
  const o = asRecord(raw) ?? {};
  const parts = [o.subject, o.group, o.title].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.join(' · ') || (typeof o.unitId === 'string' ? o.unitId : '内容包单元');
}

/** 索引摘要（只导入 index.json 时给用户看的那一行） */
export function packIndexSummary(raw: unknown): string {
  const o = asRecord(raw) ?? {};
  const units = Array.isArray(o.units) ? o.units : [];
  const stats = asRecord(o.stats);
  const total = typeof stats?.items === 'number' ? stats.items : undefined;
  const packs = new Set<string>();
  for (const u of units) {
    const rec = asRecord(u);
    if (rec && typeof rec.pack === 'string') packs.add(rec.pack);
  }
  return `${units.length} 个单元${total !== undefined ? ` / ${total} 题` : ''}${packs.size ? `（${[...packs].join('、')}）` : ''}`;
}

/**
 * 一个单元里出现的所有图片 ref（含题干 / 选项 / 解析 / 小问 / item.media）。
 * 调用方先拿这份清单去落图，再走 packUnitToQuestions——顺序反了会留下「题进来、图没有」的半截状态。
 */
export function collectPackRefs(raw: unknown): string[] {
  const o = asRecord(raw);
  if (!o || !Array.isArray(o.items)) return [];
  const refs: string[] = [];
  const walk = (item: Record<string, unknown>): void => {
    refs.push(...blocksRefs(item.stem));
    if (Array.isArray(item.choices)) {
      for (const c of item.choices) {
        const rec = asRecord(c);
        if (rec) refs.push(...blocksRefs(rec.body));
      }
    }
    if (Array.isArray(item.rationale)) {
      for (const r of item.rationale) {
        const rec = asRecord(r);
        if (rec) refs.push(...blocksRefs(rec.body));
      }
    }
    if (Array.isArray(item.media)) for (const m of item.media) if (typeof m === 'string' && m) refs.push(m);
    if (Array.isArray(item.sub)) for (const s of item.sub) { const rec = asRecord(s); if (rec) walk(rec); }
  };
  for (const it of o.items) { const rec = asRecord(it); if (rec) walk(rec); }
  return [...new Set(refs)];
}

/** 一道题最终要落成的 app 字段（图片位置已由 resolve 换成实际路径） */
interface Built {
  raw: Record<string, unknown>;
  /** 填进图的位置数（题干图 + 选项图） */
  placed: number;
  /** 有图但题库模型装不下的位置数（解析正文里的图） */
  dropped: number;
}

function buildOne(item: Record<string, unknown>, resolve: (ref: string) => string | undefined): Built | null {
  const stem = blocksText(item.stem);
  const stemRefs = blocksRefs(item.stem);
  let placed = 0;
  let dropped = 0;

  // 选项：文字按选项顺序摊平（app 的 options 是 string[]），每项第一张图进 optionImages 同位
  const choices = Array.isArray(item.choices) ? item.choices : [];
  const options: string[] = [];
  const optionImages: Array<string | null> = [];
  for (const c of choices) {
    const rec = asRecord(c);
    if (!rec) continue;
    options.push(blocksText(rec.body));
    const first = blocksRefs(rec.body)[0];
    const path = first ? resolve(first) : undefined;
    optionImages.push(path ?? null);
    if (path) placed += 1;
  }

  // 题干图：口腔里没图时用 item.media（「这道题挂了哪些图」的清单）兜一张，不重复计数
  const mediaRefs = Array.isArray(item.media) ? item.media.filter((m): m is string => typeof m === 'string') : [];
  const stemPath = [...stemRefs, ...mediaRefs].map(resolve).find(Boolean);
  if (stemPath) placed += 1;

  // 讲解音频：item.media 里的对象条目（字符串是图片 ref，对象才是音视频）
  const avRows = (Array.isArray(item.media) ? item.media : []).filter((m) => asRecord(m));
  const audioRow = avRows.map(asRecord).find((m) => m?.kind === 'audio' && typeof m.url === 'string');

  // 答案：一到多个都原样带出。单选给 answer（app 单选就是这个键），多选给 answers。
  // 'N' / '无' 是源数据里的「未提供答案」占位，按没给处理——留在答案里会变成一道必然判错的题。
  const answers = (Array.isArray(item.answers) ? item.answers : [])
    .map((a) => String(a).trim())
    .filter((a) => a && a !== 'N' && a !== '无');
  const isChoiceQ = options.length >= 2;
  const multiRefs = new Set(answers.filter((a) => /^[A-Za-z]{2,}$/.test(a)));
  const isMulti = answers.length > 1 || multiRefs.size > 0;

  // 解析：一个来源用 explanation，多个来源用 explanations（app 支持一题多套解析）
  const rs = Array.isArray(item.rationale) ? item.rationale : [];
  const exps: Array<{ source: string; text: string }> = [];
  for (const r of rs) {
    const rec = asRecord(r);
    if (!rec) continue;
    const text = blocksText(rec.body);
    dropped += blocksRefs(rec.body).length;
    if (text) exps.push({ source: typeof rec.source === 'string' && rec.source ? rec.source : '解析', text });
  }

  // 归类：真实章节在前，知识点在后（app 的掌握度按 chapter/chapters 聚合）
  const meta = asRecord(item.meta) ?? {};
  const chapters = (Array.isArray(meta.chapters) ? meta.chapters : []).map((c) => String(c).trim()).filter(Boolean);
  const knowledge = (Array.isArray(item.knowledge) ? item.knowledge : [])
    .map((k) => {
      const rec = asRecord(k);
      return rec && typeof rec.name === 'string' ? rec.name.trim() : '';
    })
    .filter(Boolean);
  const groups = [...new Set([...chapters, ...knowledge])];

  const raw: Record<string, unknown> = { stem };
  if (options.length) raw.options = options;
  if (isChoiceQ) {
    // 多选给完整数组，单选给单值（app 里 answers 只在多选时才存在）
    if (isMulti) raw.answers = answers;
    else if (answers.length === 1) raw.answer = answers[0];
  } else if (answers.length) {
    // 简答 / 填空 / 判断：没有选项，答案是文本。用 answer 而非 answers——
    // recall 分支只认 answer，给 answers 会被静默丢成一道「没有答案」的题。
    raw.answer = answers.join(' / ');
  }
  if (exps.length === 1) raw.explanation = exps[0].text;
  else if (exps.length > 1) raw.explanations = exps;
  if (groups.length) raw.chapter = groups[0];
  if (groups.length >= 2) raw.chapters = groups;
  if (stemPath) raw.image = stemPath;
  if (optionImages.some(Boolean)) raw.optionImages = optionImages;
  if (audioRow?.url) {
    raw.audio = String(audioRow.url);
    const dur = Number(audioRow.dur);
    if (Number.isFinite(dur) && dur > 0) raw.audioDur = dur;
  }

  if (!stem && !stemPath) return null; // 无题干条目跳过（与 normalizeQuestions 同一口径）
  return { raw, placed, dropped };
}

/** 单元 → app 题库字段的原始条目（还没归一化，交 normalizeQuestions 就是最终题目） */
export function packUnitToRaw(
  raw: unknown,
  resolve: (ref: string) => string | undefined = () => undefined
): { questions: Record<string, unknown>[]; placed: number; dropped: number } {
  const o = asRecord(raw);
  const questions: Record<string, unknown>[] = [];
  let placed = 0;
  let dropped = 0;
  if (!o || !Array.isArray(o.items)) return { questions, placed, dropped };

  for (const it of o.items) {
    const item = asRecord(it);
    if (!item) continue;
    const subs = Array.isArray(item.sub) ? item.sub.map(asRecord).filter((s): s is Record<string, unknown> => Boolean(s)) : [];
    if (subs.length >= 1) {
      // 共用题干题组：外层给病例原文，小问各成一题（app 自己会展开 sub 并带 groupStem/序号）
      const caseStem = blocksText(item.stem);
      const built: Record<string, unknown>[] = [];
      for (const sub of subs) {
        const b = buildOne(sub, resolve);
        if (!b) continue;
        // 病例原文里的图落不到「小问题干」上——补进没有图的小问，避免整组丢图；补过的不再计入 dropped
        if (!b.raw.image) {
          const alt = blocksRefs(caseStem ? item.stem : undefined).map(resolve).find(Boolean);
          if (alt) b.raw.image = alt;
        }
        built.push(b.raw);
        placed += b.placed;
        dropped += b.dropped;
      }
      if (built.length) {
        questions.push({ stem: caseStem, sub: built });
        continue;
      }
    }
    const b = buildOne(item, resolve);
    if (!b) continue;
    questions.push(b.raw);
    placed += b.placed;
    dropped += b.dropped;
  }
  return { questions, placed, dropped };
}

/** 一步到位：单元 → 归一化题目（调用方已把图片落库时用这个，不需要中间的原始条目） */
export function packUnitToQuestions(
  raw: unknown,
  resolve: (ref: string) => string | undefined = () => undefined
): { questions: QuizQuestion[]; placed: number; dropped: number } {
  const { questions, placed, dropped } = packUnitToRaw(raw, resolve);
  // 空单元直接交回空数组：normalizeQuestions 对「一条都没解析出来」是抛错的（手工导入时那是对的，
  // 用户贴的文本解析不出来，得当场告诉他）。内容包是机器生成的，整个单元没答案属于数据本身的性质，
  // 该由调用方按单元报「这单元没有能建成的题目」——抛出去只会变成一个看不出原因的失败行。
  if (!questions.length) return { questions: [], placed, dropped };
  try {
    return { questions: normalizeQuestions(questions), placed, dropped };
  } catch {
    // 条目都在，但每条都缺答案/题干 → normalizeQuestions 仍然抛。同上：按单元交回空数组。
    return { questions: [], placed, dropped };
  }
}
