/**
 * 导师模式（DeepTutor 式掌握度门禁）：把「陪练」从一轮问答升级成可追踪的学习路径。
 *
 * 灵感来自 HKUDS/DeepTutor 的 guided learning：知识点不是「讲过了」就算学会，
 * 而要过一道掌握门槛才允许进入下一个。这里不引入任何外部依赖，只落一张本地台账：
 *
 *   0 未测 → 1 有印象 → 2 能复述 → 3 能应用（通过）
 *
 * 规则（同时写进系统提示，模型必须照做）：
 * - 每次只推进一个台阶：讲解 → 例题 → 学生复述/应用 → 判定 → set_mastery；
 * - 未到 3 不许开新知识点；2 时只做变式确认；≤1 回到讲解；
 * - 学生答错先给线索重试，连续两次失败才降级讲解；
 * - 每轮结束必须落一条记录，没有记录就等于没通过；
 * - 学生坚持跳关时可以放行，但 evidence 必须写明是「放行」。
 *
 * 台账只存学习元数据（主题 / 等级 / 依据 / 次数 / 时间），不写用户笔记；
 * 存储走 storage/kv 的统一入口，键在 KV_KEYS 登记。
 */
import { defineStore } from '../storage/kv';
import type { AgentToolDef } from './aiAgent';

export const MASTERY_LABELS = ['未测', '有印象', '能复述', '能应用'] as const;
export type MasteryLevel = 0 | 1 | 2 | 3;
/** 通过门槛：只有到这个等级才允许进入下一个知识点 */
export const MASTERY_PASS = 3;

export interface MasteryEntry {
  level: MasteryLevel;
  /** 判定依据：模型必须写「为什么给这个等级」，便于复看与纠偏 */
  evidence: string;
  /** 被判定过几次（同一主题反复练习会累加） */
  attempts: number;
  updatedAt: number;
}

export type MasteryMap = Record<string, MasteryEntry>;

const masteryStore = defineStore<MasteryMap>({
  key: 'knowlattice-tutor-mastery',
  fallback: {},
  decode: (raw, fallback) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
    const out: MasteryMap = {};
    for (const [topic, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const level = clampLevel(v.level);
      out[topic] = {
        level,
        evidence: typeof v.evidence === 'string' ? v.evidence : '',
        attempts: Math.max(1, Math.floor(Number(v.attempts) || 1)),
        updatedAt: Math.floor(Number(v.updatedAt) || 0),
      };
    }
    return out;
  },
});

export function loadMastery(): MasteryMap {
  return masteryStore.read();
}

export function saveMastery(map: MasteryMap): void {
  masteryStore.write(map);
}

/** 任何非法等级都夹到 0–3：模型传 4、-1、"2" 都不会写坏台账 */
export function clampLevel(value: unknown): MasteryLevel {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MASTERY_PASS, Math.max(0, n)) as MasteryLevel;
}

/**
 * 写入一次判定。纯函数：返回新 map，不碰存储，便于单测与「先算后写」。
 * 同一主题重复判定只累加 attempts 并覆盖等级/依据，不保留历史（台账不是日志，
 * 历史在当天学习日志里）。
 */
export function applyMastery(
  map: MasteryMap,
  topic: string,
  level: unknown,
  evidence: string,
  now = Date.now(),
): MasteryMap {
  const key = topic.trim();
  if (!key) return map;
  const previous = map[key];
  return {
    ...map,
    [key]: {
      level: clampLevel(level),
      evidence: evidence.trim().slice(0, 200),
      attempts: (previous?.attempts ?? 0) + 1,
      updatedAt: now,
    },
  };
}

/** 等级对应的下一步指令：既给模型做提示，也给界面显示 */
export function nextStepHint(level: MasteryLevel): string {
  switch (level) {
    case MASTERY_PASS:
      return '已过门槛（能应用）：可以进入下一个知识点，或换一道综合题巩固。';
    case 2:
      return '能复述但还没证明能应用：先用一道变式/应用题确认，过了才能开新知识点。';
    case 1:
      return '只有印象：回到讲解与例子，讲完立刻让学生复述一遍再判定。';
    default:
      return '还没测过：先出一道诊断题，测出真实起点再决定讲多深。';
  }
}

const DAY_MS = 86_400_000;

function ago(now: number, at: number): string {
  if (!at) return '时间未知';
  const days = Math.floor((now - at) / DAY_MS);
  return days <= 0 ? '今天' : `${days} 天前`;
}

/**
 * 台账文本：给模型看的报告，也给面板摘要用。
 * 先列「还没过的」再列「已通过的」——导师最需要知道的是哪里还卡着。
 */
export function masteryReport(map: MasteryMap, now = Date.now(), limit = 8): string {
  const rows = Object.entries(map);
  if (!rows.length) return '导师台账还是空的：还没有任何知识点被判定过。先诊断，再记录第一条。';
  const sorted = rows.sort((a, b) => a[1].level - b[1].level || b[1].updatedAt - a[1].updatedAt);
  const lines = sorted.slice(0, limit).map(([topic, e]) =>
    `- ${topic}：${MASTERY_LABELS[e.level]}（${e.level}/3）· ${e.attempts} 次判定 · 最近 ${ago(now, e.updatedAt)}`
    + (e.evidence ? ` · 依据：${e.evidence}` : ''));
  const rest = sorted.length - lines.length;
  const passed = rows.filter(([, e]) => e.level === MASTERY_PASS).length;
  return [
    `掌握度台账：${rows.length} 个知识点，已过门槛 ${passed} 个，未过 ${rows.length - passed} 个。`,
    ...lines,
    ...(rest > 0 ? [`…（其余 ${rest} 个省略）`] : []),
  ].join('\n');
}

/** 系统提示里的导师契约：与 COACH_PROMPT_LINES 叠加（导师比陪练更严格） */
export const TUTOR_PROMPT_LINES = [
  '【导师模式】本会话是目标驱动的导师制学习，以下规则优先级最高：',
  '- 开局三件事：确认这次要学的目标 → 用 get_weak_chapters / get_review_due / get_mastery 选一个知识点 → 说明这次要过的门槛。',
  '- 掌握度四级：0 未测 / 1 有印象 / 2 能复述 / 3 能应用。只有到 3 才允许进入下一个知识点；到 2 只做变式确认；≤1 回到讲解与例子。',
  '- 每次只推进一个台阶：讲解 → 例题 → 让学生复述或应用 → 判定 → 立刻调用 set_mastery 记录（evidence 写判定依据）。',
  '- 学生答错：先归类（知识没记住 / 概念混淆 / 审题偏差 / 临床推理跳步），给一条线索让他重试；连续两次失败才降级讲解。',
  '- 每轮结束前必须落一条 set_mastery；没有记录就等于没通过，不要口头宣布「掌握了」。',
  '- 学生坚持跳到下一个知识点时，说明未过门槛，由学生决定是否放行；放行也要记录，evidence 写明「学生要求跳过」。',
  '- 会话收尾：列出已过 / 未过的知识点（带 [[双链]]），再用 propose_study_log 写进当天学习日志。',
];

export const TUTOR_TOOLS: AgentToolDef[] = [
  {
    name: 'get_mastery',
    description: '查看导师模式的掌握度台账：每个知识点的等级（0 未测 / 1 有印象 / 2 能复述 / 3 能应用）、判定依据与最近时间。决定从哪里开始时先看它。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_mastery',
    description: '记录一个知识点的掌握度判定（导师模式每轮必须调用）。level 0–3；evidence 写判定依据，例如「能独立说出前负荷三要素，变式题答对」。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '知识点名称（简短，如「心力衰竭的前负荷」）' },
        level: { type: 'integer', minimum: 0, maximum: 3, description: '0 未测 / 1 有印象 / 2 能复述 / 3 能应用' },
        evidence: { type: 'string', description: '判定依据：学生刚才说了/做对了什么，或为什么放行' },
      },
      required: ['topic', 'level'],
    },
  },
];

/** 备份用：掌握度台账（主题 → 等级 / 依据 / 次数 / 时间）。 */
export function exportMastery(): MasteryMap {
  return loadMastery();
}

/** 恢复用：只补不覆盖，同一主题保留本地最新判定。 */
export function importMastery(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const current = loadMastery();
  const next: MasteryMap = { ...current };
  let added = 0;
  let kept = 0;
  for (const [topic, raw] of Object.entries(incoming as Record<string, unknown>)) {
    const key = topic.trim();
    if (!key) continue;
    if (current[key]) {
      kept += 1;
      continue;
    }
    const value = raw as Partial<MasteryEntry>;
    if (!value || typeof value !== 'object') continue;
    next[key] = {
      level: clampLevel(value.level),
      evidence: typeof value.evidence === 'string' ? value.evidence : '',
      attempts: Math.max(1, Math.floor(Number(value.attempts) || 1)),
      updatedAt: Math.floor(Number(value.updatedAt) || 0),
    };
    added += 1;
  }
  if (added > 0) saveMastery(next);
  return { added, kept };
}
