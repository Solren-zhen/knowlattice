/**
 * 知识点录音：一条知识点 = 一段讲解音频 + 逐句字幕时间轴。
 *
 * 数据来自内容包的 `topic/*.json`（导出侧已把每条知识点的科目/章路径与字幕压成
 * `{s,e,t}`）。为什么要接这一层：题库能刷题但讲不明白，录音能讲但没有题；
 * 两边挂同一个知识点名，才能在「今天刷这一章」和「听这一章」之间来回跳。
 *
 * 只存本机（localStorage），音频是远端直链、不进备份——签名直链写进备份只会带死链，
 * 而字幕/路径本身很小，用户重导一次内容包就回来了。
 */
import type { Cue } from './subtitle';

export const KNOWLEDGE_AUDIO_KEY = 'knowlattice-knowledge-audio';

/** 一条知识点录音。`cues` 用压缩键（s/e/t）：字幕动辄上百句，键名占的空间比正文还多。 */
export interface KnowledgeAudio {
  id: string;
  name: string;
  /** 科目 / 章 …… 从宽到窄，界面里直接当分组路径用 */
  path: string[];
  minutes?: number;
  audio: string;
  cues: Array<{ s: number; e: number; t: string }>;
}

/**
 * 认「知识点清单」：数组，且至少一条同时有 name 与 audio（或 srt）。
 * 不能只看有没有 audio——老导出物只有 name/qids，导进来是个空面板。
 */
export function looksLikeKnowledgeTopics(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((it) => {
    const r = it as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return false;
    return typeof r.name === 'string' && (typeof r.audio === 'string' || Array.isArray(r.srt));
  });
}

function toCues(raw: unknown): KnowledgeAudio['cues'] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeAudio['cues'] = [];
  for (const c of raw) {
    const r = c as Record<string, unknown> | null;
    if (!r) continue;
    const s = Number(r.s ?? r.start);
    const e = Number(r.e ?? r.end);
    const t = String(r.t ?? r.text ?? '').trim();
    if (!t || !Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    out.push({ s, e, t });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** 任意形状 → 知识点录音清单；没有音频且没有字幕的条目丢掉（点开只能看个名字，没有意义）。 */
export function parseKnowledgeTopics(raw: unknown): KnowledgeAudio[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeAudio[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    const r = it as Record<string, unknown> | null;
    if (!r) continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const audio = typeof r.audio === 'string' ? r.audio.trim() : '';
    const cues = toCues(r.srt);
    if (!name || (!audio && !cues.length)) continue;
    const pathRaw = Array.isArray(r.path) ? r.path : [];
    const id = String(r.topicId ?? r.id ?? `${name}@${pathRaw.join('/')}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const path = Array.isArray(r.path) ? r.path.filter((p): p is string => typeof p === 'string' && !!p) : [];
    const minutes = Number(r.minutes);
    out.push({
      id,
      name,
      path,
      ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
      audio,
      cues,
    });
  }
  return out;
}

export function loadKnowledgeAudio(): KnowledgeAudio[] {
  try {
    const raw = localStorage.getItem(KNOWLEDGE_AUDIO_KEY);
    if (!raw) return [];
    return parseKnowledgeTopics(JSON.parse(raw));
  } catch {
    // 存储被禁用或内容坏了：当作没有，别让整块界面挂掉
    return [];
  }
}

/** 按 id 合并（同一条知识点重导时覆盖，旧的不动）。返回写入结果，失败不抛。 */
export function saveKnowledgeAudio(next: KnowledgeAudio[]): { added: number; total: number; ok: boolean } {
  const prev = loadKnowledgeAudio();
  const byId = new Map(prev.map((k) => [k.id, k]));
  let added = 0;
  for (const k of next) {
    if (!byId.has(k.id)) added += 1;
    byId.set(k.id, k);
  }
  const all = [...byId.values()].sort((a, b) => {
    const pa = a.path.join('/');
    const pb = b.path.join('/');
    return pa === pb ? a.name.localeCompare(b.name, 'zh') : pa.localeCompare(pb, 'zh');
  });
  try {
    localStorage.setItem(KNOWLEDGE_AUDIO_KEY, JSON.stringify(all));
    return { added, total: all.length, ok: true };
  } catch {
    return { added: 0, total: prev.length, ok: false };
  }
}

/** 名字/路径/字幕全文匹配；空查询返回全部（面板一打开就得有东西看）。 */
export function searchKnowledgeAudio(list: KnowledgeAudio[], q: string, limit = 120): KnowledgeAudio[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list.slice(0, limit);
  const hit: Array<{ k: KnowledgeAudio; score: number }> = [];
  for (const k of list) {
    const name = k.name.toLowerCase();
    const path = k.path.join(' ').toLowerCase();
    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (name.includes(needle)) score = 1;
    else if (path.includes(needle)) score = 2;
    else if (k.cues.some((c) => c.t.toLowerCase().includes(needle))) score = 3;
    if (score >= 0) hit.push({ k, score });
  }
  hit.sort((a, b) => a.score - b.score || a.k.name.localeCompare(b.k.name, 'zh'));
  return hit.slice(0, limit).map((h) => h.k);
}

/** 当前播放位置落在第几句（找不到返回 -1）。二分：字幕一两百句，线性扫也可以，但这里免费。 */
export function activeCueIndex(cues: KnowledgeAudio['cues'], seconds: number): number {
  if (!cues.length) return -1;
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (seconds < cues[mid].s) hi = mid - 1;
    else if (seconds >= cues[mid].e) lo = mid + 1;
    else { found = mid; break; }
  }
  return found;
}

/** 字幕转成通用 Cue（给 subtitle.ts 的既有能力复用：复制成卡片、导出等）。 */
export function cuesOf(k: KnowledgeAudio): Cue[] {
  return k.cues.map((c) => ({ start: c.s, end: c.e, text: c.t }));
}
