/*
 * 技能卡：把「一类任务该怎么用工具、按什么顺序」沉淀成知识库里的一篇笔记。
 *
 * 为什么放 vault 而不是塞进代码或 localStorage：
 *   - 它是用户的资产，应该能改、能删、能进版本库、能跟着同步走；
 *   - 已有的索引（docIndex）、指令文件守卫（AI命令/ 下写入一律要确认）直接复用，
 *     模型不能自己悄悄改掉自己的行为；
 *   - 蒸馏产物落在这里，「这个助手越来越顺手」这件事对用户可见、可审计。
 *
 * 三条硬边界（不可越）：
 *   1. 技能只能编排**已注册**的工具，出现未注册工具整卡作废——否则卡里写个
 *      delete_everything 就能让模型以为有这样的能力；
 *   2. 技能不改变写入的确认语义：卡里说「直接改」也不算数，仍要用户点应用；
 *   3. 常驻上下文的只有目录（id + 何时用），步骤正文靠 load_skill 按需取。
 */

import type { AgentToolDef } from './aiAgent';
import { hashArgs, type TurnTrace } from './agentTrace';

/** 技能卡目录（与面板的指令文件守卫同源：这个前缀下写入必须人工确认） */
export const SKILL_DIR = 'AI命令/技能/';
export const SKILL_MAX_CARDS = 50;
export const SKILL_MAX_TOOLS = 12;
/** 目录注入上限：超了按 confidence 截断，宁可少给几张也不挤占正文预算 */
export const SKILL_CATALOG_LIMIT = 1_200;

export interface SkillCard {
  /** 由文件名（去 .md）得到，稳定且可读 */
  id: string;
  path: string;
  /** frontmatter 的 skill:，缺省用 id */
  name: string;
  /** frontmatter 的 when:，一句话说明「什么情况下用这张卡」 */
  when: string;
  /** 允许编排的工具名（顺序即建议顺序） */
  tools: string[];
  /** 0..1，蒸馏时的滑动平均；手工写的卡默认 0.5 */
  confidence: number;
  /** 被复用并成功的次数，样本不足时蒸馏不加权 */
  samples: number;
  updated: number;
  /** 蒸馏判定失效后标记，不再注入目录也不删除内容 */
  retired: boolean;
}

export interface SkillDrop {
  id: string;
  reason: 'no_frontmatter' | 'no_when' | 'no_tools' | 'tool_unregistered' | 'too_many_tools' | 'retired' | 'over_limit';
  /** 造成作废的具体工具名 / 卡数，便于用户改卡 */
  detail: string;
}

/** 只解析顶层「key: value」标量行：技能卡 frontmatter 刻意保持成手写友好的样子，
 *  引入完整 YAML 解析器会为几行键值多背一个依赖。 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return out;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return null; // 没有收尾 --- 就不当 frontmatter，避免把正文误读成配置
}

/** 正文（去掉 frontmatter），供 load_skill 回给模型 */
export function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n').replace(/^\n+/, '');
  }
  return text;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function splitTools(v: string | undefined): string[] {
  if (!v) return [];
  const raw = v.replace(/^\[|\]$/g, '');
  return raw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 解析一张技能卡；缺 when 或缺 tools 的卡不算技能（宁可不注入，也不要让模型
 *  看到一张「不知道什么时候用」的卡——那只会变成 prompt 噪音）。 */
export function parseSkillCard(path: string, text: string): SkillCard | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const when = (fm.when ?? '').trim();
  const tools = splitTools(fm.tools);
  if (!when || !tools.length) return null;
  return {
    id,
    path,
    name: (fm.skill ?? '').trim() || id,
    when,
    tools,
    confidence: Math.min(1, Math.max(0, num(fm.confidence, 0.5))),
    samples: Math.max(0, Math.trunc(num(fm.samples, 0))),
    updated: num(fm.updated, 0),
    retired: (fm.retired ?? '').trim() === 'true',
  };
}

/** 收集知识库里全部技能卡（按 id 去重，后写覆盖先写） */
export function collectSkills(docs: ReadonlyMap<string, string>): SkillCard[] {
  const byId = new Map<string, SkillCard>();
  for (const [path, text] of docs) {
    if (!path.startsWith(SKILL_DIR) || !path.endsWith('.md')) continue;
    const card = parseSkillCard(path, text);
    if (card) byId.set(card.id, card);
  }
  return [...byId.values()];
}

/** 按 id 或 name 找卡：模型不一定记得住 id，两种键都认 */
export function findSkill(docs: ReadonlyMap<string, string>, key: string): SkillCard | null {
  const want = key.trim();
  if (!want) return null;
  const cards = collectSkills(docs);
  return cards.find((c) => c.id === want) ?? cards.find((c) => c.name === want)
    ?? cards.find((c) => c.id.toLowerCase() === want.toLowerCase()) ?? null;
}

/** 校验并排序：未注册工具 / 步骤过多 / 已退休的卡出列；超上限按 confidence×新近度截断。
 *  isRegistered 由调用方传入注册表判定，避免这里 import 工具定义形成环。 */
export function validateSkills(
  cards: readonly SkillCard[],
  isRegistered: (tool: string) => boolean,
  opts: { max?: number; includeRetired?: boolean } = {}
): { active: SkillCard[]; dropped: SkillDrop[] } {
  const max = opts.max ?? SKILL_MAX_CARDS;
  const dropped: SkillDrop[] = [];
  const ok: SkillCard[] = [];
  for (const c of cards) {
    if (c.retired && !opts.includeRetired) {
      dropped.push({ id: c.id, reason: 'retired', detail: '' });
      continue;
    }
    const bad = c.tools.filter((t) => !isRegistered(t));
    if (bad.length) {
      dropped.push({ id: c.id, reason: 'tool_unregistered', detail: bad.join(', ') });
      continue;
    }
    if (c.tools.length > SKILL_MAX_TOOLS) {
      dropped.push({ id: c.id, reason: 'too_many_tools', detail: String(c.tools.length) });
      continue;
    }
    ok.push(c);
  }
  ok.sort((a, b) => (b.confidence - a.confidence) || (b.updated - a.updated));
  const active = ok.slice(0, max);
  for (const c of ok.slice(max)) dropped.push({ id: c.id, reason: 'over_limit', detail: String(max) });
  return { active, dropped };
}

/** 常驻上下文的那一小段：id + 何时用。一条约 20 token，50 张卡也只有一个工具定义的量级。 */
export function formatSkillCatalog(cards: readonly SkillCard[], limit = SKILL_CATALOG_LIMIT): string {
  if (!cards.length) return '';
  const lines: string[] = [];
  for (const c of cards) {
    const line = '- ' + c.id + '：' + c.when;
    if (lines.join('\n').length + line.length > limit) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** load_skill 的返回值：正文原样给模型（截断到与 read_note 同量级，避免一张卡撑爆上下文） */
export function skillBody(docs: ReadonlyMap<string, string>, card: SkillCard, max = 6_000): string {
  const raw = docs.get(card.path) ?? '';
  const body = stripFrontmatter(raw).trim();
  const head = '【技能卡】' + card.name + '（' + card.id + '）\n适用：' + card.when
    + '\n建议顺序：' + card.tools.join(' → ') + '\n\n';
  const room = Math.max(0, max - head.length);
  const cut = body.length > room ? body.slice(0, room) + '\n\n（技能卡过长，已截断。）' : body;
  return head + cut;
}

export const LOAD_SKILL_TOOL: AgentToolDef = {
  name: 'load_skill',
  description: '读取一张技能卡的完整步骤（系统提示里的技能目录只给 id 与适用场景）。'
    + '要在多步任务里按经验做法编排工具时先取一次对应卡，再照它执行；卡里的步骤只是建议，与用户当前要求冲突时以用户为准。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '技能卡 id（目录里的名字），也接受卡名' },
    },
    required: ['id'],
  },
};

/** 序列化回 Markdown（B3 蒸馏写回用）：保持 frontmatter 手写友好的同一套键。 */
export function toSkillMarkdown(card: SkillCard, body: string): string {
  return [
    '---',
    'skill: ' + card.name,
    'when: ' + card.when,
    'tools: ' + card.tools.join(', '),
    'confidence: ' + card.confidence.toFixed(2),
    'samples: ' + card.samples,
    'updated: ' + card.updated,
    ...(card.retired ? ['retired: true'] : []),
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------ 蒸馏（B3） */

/** 工具序列 → 指纹。技能的本质是「这几步按这个顺序做」，所以用序列而不是集合做键：
 *  先查再改和先改再查是两张不同的卡。 */
export function signatureOf(tools: readonly string[]): string {
  return tools.join('>');
}

export interface DistillOptions {
  /** 有卡时：置信度变化不足这个量就不写回，避免每轮都动一次文件 */
  minDelta?: number;
  /** 无卡时：同类任务成功多少次才值得建议固化成卡 */
  minSamples?: number;
  /** 滑动平均系数：α 越大越信最近一次，越小越稳 */
  alpha?: number;
  now?: number;
  /** 单轮最多建议几张（剩下的下一轮再来） */
  maxSuggestions?: number;
}

export interface DistillResult {
  /** 已有卡：置信度/样本数/退休标记需要写回的（写回由调用方落盘） */
  updates: SkillCard[];
  /** 库里还没有对应卡、但样本量够了的建议（**不自动落盘**：指令文件只能由用户决定要不要生成） */
  suggestions: SkillCard[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 从回合轨迹里蒸馏技能：同一意图多次成功 → 提升对应卡片的置信度；
 * 有失败或被拒 → 降。只做两件事：
 *   1. 已有卡的 confidence / samples / retired 演化；
 *   2. 反复出现但无卡可依的任务，产出一张**建议卡**交给用户决定。
 * 为什么不自动新建卡：技能卡是指令文件，模型/程序替用户决定「以后都照这个做」
 * 等于悄悄改行为；建议卡让用户看一眼再落盘（落盘后走 C:\...\AI命令/ 的写入确认）。
 */
export function distillSkills(
  traces: readonly TurnTrace[],
  cards: readonly SkillCard[],
  opts: DistillOptions = {}
): DistillResult {
  const alpha = opts.alpha ?? 0.2;
  const minSamples = opts.minSamples ?? 3;
  const minDelta = opts.minDelta ?? 0.05;
  const now = opts.now ?? Date.now();
  const maxSuggestions = opts.maxSuggestions ?? 3;

  const groups = new Map<string, { pos: TurnTrace[]; neg: number }>();
  for (const t of traces) {
    if (!t.intentKey) continue;
    const g = groups.get(t.intentKey) ?? { pos: [], neg: 0 };
    if (t.outcome === 'ok' && t.calls.length >= 2 && t.calls.every((c) => c.ok)) g.pos.push(t);
    else g.neg += 1;
    groups.set(t.intentKey, g);
  }

  const updates: SkillCard[] = [];
  const suggestions: SkillCard[] = [];
  const seenSignatures = new Set<string>();

  for (const g of groups.values()) {
    if (!g.pos.length) continue;
    const last = g.pos[g.pos.length - 1];
    // 连续去重：同一工具连着调两次（比如分段 read_note）在卡里只算一步
    const tools: string[] = [];
    for (const c of last.calls) {
      if (tools[tools.length - 1] !== c.name) tools.push(c.name);
    }
    const seq = tools.slice(0, SKILL_MAX_TOOLS);
    if (seq.length < 2) continue; // 单步任务不值得固化成技能
    const signature = signatureOf(seq);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    const rate = clamp01(g.pos.length / (g.pos.length + g.neg));
    const existing = cards.find((c) => signatureOf(c.tools) === signature);
    if (existing) {
      const next = round2(clamp01((1 - alpha) * existing.confidence + alpha * rate));
      if (Math.abs(next - existing.confidence) < minDelta) continue;
      const samples = existing.samples + g.pos.length;
      updates.push({
        ...existing,
        confidence: next,
        samples,
        updated: now,
        // 越用越差（反复失败/被拒）就退休：留着只会误导模型按错的顺序做
        retired: existing.retired || (next < 0.2 && samples >= 5),
      });
      continue;
    }
    if (g.pos.length < minSamples) continue;
    const id = 'auto-' + hashArgs(signature).slice(0, 8);
    suggestions.push({
      id,
      path: SKILL_DIR + id + '.md',
      name: '自动沉淀：' + seq[0] + ' → ' + seq[seq.length - 1],
      when: '同类任务已重复成功 ' + g.pos.length + ' 次（关键词：' + last.intentKey.split(' ').slice(0, 6).join(' ') + '）',
      tools: seq,
      confidence: round2(rate),
      samples: g.pos.length,
      updated: now,
      retired: false,
    });
  }

  updates.sort((a, b) => b.updated - a.updated);
  suggestions.sort((a, b) => b.samples - a.samples);
  return { updates, suggestions: suggestions.slice(0, maxSuggestions) };
}

/* ---------------------------------------------------------------- 人格卡 */

/**
 * 人格卡：常驻 system prompt 的一段固定口吻/立场。和技能卡同一个守卫目录（AI命令/ 下
 * 写入一律要确认），用途却不同：技能是「按需取的方法」，人格是「每轮都在的角色」。
 * 分开是因为预算不同——技能目录只进 id + 何时用，人格正文每轮都进上下文，
 * 所以只注入第一张（多张会互相打架）并且必须限额。
 */
export const SOUL_DIR = 'AI命令/人格/';
export const SOUL_PREFIX_LIMIT = 1_200;

export interface SoulCard {
  path: string;
  /** frontmatter 的 persona:，缺省用文件名 */
  name: string;
  /** 去 frontmatter 后的正文 */
  text: string;
}

export function collectSouls(docs: ReadonlyMap<string, string>): SoulCard[] {
  const out: SoulCard[] = [];
  for (const [path, text] of docs) {
    if (!path.startsWith(SOUL_DIR) || !path.endsWith('.md')) continue;
    const front = parseFrontmatter(text) ?? {};
    const name = (front.persona || front.name || path.slice(SOUL_DIR.length).replace(/[.]md$/, '')).trim();
    const body = stripFrontmatter(text).trim();
    if (!body) continue;
    out.push({ path, name, text: body });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 取第一张卡并按预算截断；没有卡时返回空串（调用方据此不加这段） */
export function formatSoulPrefix(cards: readonly SoulCard[], limit = SOUL_PREFIX_LIMIT): string {
  const first = cards[0];
  if (!first) return '';
  return first.text.length > limit ? first.text.slice(0, limit) + '…' : first.text;
}
