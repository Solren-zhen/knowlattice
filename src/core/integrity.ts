/**
 * 数据自检：只吃数据、吐报告，不碰存储。
 *
 * 检查与修复共用同一批结果：`checkIntegrity()` 是唯一判定来源，
 * `planRepairs()` 只接受检查项自己报出来的 id——绝不按外部传入的 id 盲删。
 *
 * 修复范围刻意保守：
 *   - 能删：指向不存在题库/题目的统计与收藏（删掉不影响任何内容）；
 *   - 只报告：空题干、重复 id、断链、疑似孤儿附件（删错会让正文破图或丢内容）。
 */
import { findOrphanAttachments } from './attachmentOrphans';
import type { LinkIndex } from './linkIndex';

export type Severity = 'high' | 'medium' | 'low';

export type CheckId =
  | 'stat-bank-missing'
  | 'stat-question-missing'
  | 'star-bank-missing'
  | 'star-question-missing'
  | 'empty-question'
  | 'duplicate-question-id'
  | 'broken-link'
  | 'orphan-attachment';

export interface IntegrityIssue {
  id: string;
  title: string;
  detail: string;
}

export interface IntegrityCheck {
  id: CheckId;
  title: string;
  severity: Severity;
  count: number;
  items: IntegrityIssue[];
  fixable: boolean;
  /** 修复动作的一句话说明，UI 直接显示 */
  fixNote: string;
}

/** 与 storage/qbank 的结构保持同构；core 不反向 import storage。 */
export interface IntegrityBank {
  name: string;
  questions: readonly unknown[];
}
export interface IntegrityStat {
  bank: string;
  qid: string;
}
export interface IntegrityStar {
  bank: string;
  qid: string;
}

export interface IntegrityData {
  banks: readonly IntegrityBank[];
  stats: readonly IntegrityStat[];
  stars: readonly IntegrityStar[];
  docs: ReadonlyMap<string, string>;
  attachmentPaths: readonly string[];
  linkIndex?: LinkIndex;
}

export const SEVERITY_LABEL: Record<Severity, string> = { high: '严重', medium: '中等', low: '轻微' };

function questionIdsOf(bank: IntegrityBank): Set<string> {
  const ids = new Set<string>();
  for (const raw of bank.questions) {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

function make(
  id: CheckId,
  title: string,
  severity: Severity,
  items: IntegrityIssue[],
  fixable: boolean,
  fixNote: string,
): IntegrityCheck {
  return { id, title, severity, count: items.length, items, fixable, fixNote };
}

function checkStats(data: IntegrityData): IntegrityCheck[] {
  const byName = new Map(data.banks.map((bank) => [bank.name, bank]));
  const bankMissing: IntegrityIssue[] = [];
  const questionMissing: IntegrityIssue[] = [];
  const cache = new Map<string, Set<string>>();
  for (const stat of data.stats) {
    const bank = byName.get(stat.bank);
    if (!bank) {
      bankMissing.push({ id: `${stat.bank}::${stat.qid}`, title: `${stat.bank} / ${stat.qid}`, detail: '统计记录指向的题库不存在' });
      continue;
    }
    let ids = cache.get(stat.bank);
    if (!ids) {
      ids = questionIdsOf(bank);
      cache.set(stat.bank, ids);
    }
    if (!ids.has(stat.qid)) {
      questionMissing.push({ id: `${stat.bank}::${stat.qid}`, title: `${stat.bank} / ${stat.qid}`, detail: '统计记录指向的题目不在该题库里' });
    }
  }
  return [
    make('stat-bank-missing', '统计指向不存在的题库', 'high', bankMissing, true, '删除这些统计记录'),
    make('stat-question-missing', '统计指向不存在的题目', 'high', questionMissing, true, '删除这些统计记录'),
  ];
}

function checkStars(data: IntegrityData): IntegrityCheck[] {
  const byName = new Map(data.banks.map((bank) => [bank.name, bank]));
  const bankMissing: IntegrityIssue[] = [];
  const questionMissing: IntegrityIssue[] = [];
  const cache = new Map<string, Set<string>>();
  for (const star of data.stars) {
    const bank = byName.get(star.bank);
    if (!bank) {
      bankMissing.push({ id: `${star.bank}::${star.qid}`, title: `${star.bank} / ${star.qid}`, detail: '收藏记录指向的题库不存在' });
      continue;
    }
    let ids = cache.get(star.bank);
    if (!ids) {
      ids = questionIdsOf(bank);
      cache.set(star.bank, ids);
    }
    if (!ids.has(star.qid)) {
      questionMissing.push({ id: `${star.bank}::${star.qid}`, title: `${star.bank} / ${star.qid}`, detail: '收藏记录指向的题目不在该题库里' });
    }
  }
  return [
    make('star-bank-missing', '收藏指向不存在的题库', 'medium', bankMissing, true, '删除这些收藏记录'),
    make('star-question-missing', '收藏指向不存在的题目', 'medium', questionMissing, true, '删除这些收藏记录'),
  ];
}

function checkQuestions(data: IntegrityData): IntegrityCheck[] {
  const empty: IntegrityIssue[] = [];
  const duplicate: IntegrityIssue[] = [];
  for (const bank of data.banks) {
    const seen = new Map<string, number>();
    for (const raw of bank.questions) {
      const q = raw as { id?: unknown; stem?: unknown } | null;
      const id = typeof q?.id === 'string' ? q.id : '';
      const stem = typeof q?.stem === 'string' ? q.stem : '';
      if (!id) empty.push({ id: `${bank.name}::?`, title: bank.name, detail: '有一道题缺少 id，逐题统计无法对上' });
      else if (!stem.trim()) empty.push({ id: `${bank.name}::${id}`, title: `${bank.name} / ${id}`, detail: '题干为空' });
      if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const [id, count] of seen) {
      if (count > 1) duplicate.push({ id: `${bank.name}::${id}`, title: `${bank.name} / ${id}`, detail: `同一题库里出现 ${count} 次` });
    }
  }
  return [
    make('empty-question', '空题干 / 缺 id', 'medium', empty, false, '不改动：题目内容要自己补'),
    make('duplicate-question-id', '题库内重复 id', 'high', duplicate, false, '不改动：合并题目需要人工判断保留哪一条'),
  ];
}

/** 从笔记路径建「可解析目标名」集合：完整路径、去掉 .md 的路径、文件名。 */
export function noteNameSet(docs: ReadonlyMap<string, string>): Set<string> {
  const names = new Set<string>();
  for (const path of docs.keys()) {
    if (!path.endsWith('.md')) continue;
    const noExt = path.replace(/\.md$/i, '');
    names.add(noExt.toLowerCase());
    const base = noExt.split('/').pop();
    if (base) names.add(base.toLowerCase());
  }
  return names;
}

function checkBrokenLinks(data: IntegrityData): IntegrityCheck {
  const items: IntegrityIssue[] = [];
  if (!data.linkIndex) return make('broken-link', '失效双链', 'low', items, false, '只列出不改动：到笔记的反链面板里改');
  const names = noteNameSet(data.docs);
  for (const [path, targets] of data.linkIndex.outgoing) {
    if (!data.docs.has(path)) continue;
    for (const target of targets) {
      const key = target.trim().toLowerCase();
      if (!key || names.has(key)) continue;
      items.push({ id: `${path}::${target}`, title: path, detail: `[[${target}]] 找不到对应笔记` });
    }
  }
  return make('broken-link', '失效双链', 'low', items, false, '只列出不改动：到笔记的反链面板里改');
}

function checkOrphans(data: IntegrityData): IntegrityCheck {
  const noteTexts = [...data.docs.entries()]
    .filter(([path]) => path.endsWith('.md'))
    .map(([, body]) => body);
  const result = findOrphanAttachments(data.attachmentPaths, noteTexts);
  const items = result.orphans.map((path) => ({
    id: path,
    title: path,
    detail: '没有任何笔记正文引用（正文之外挂载的音频/题库题图可能仍在使用，删前请确认）',
  }));
  return make('orphan-attachment', '疑似孤儿附件', 'low', items, false, '只列出不自动删：附件可能被音频/题库等正文之外的引用使用');
}

/** 跑全部检查；顺序固定，UI 直接按顺序渲染。 */
export function checkIntegrity(data: IntegrityData): IntegrityCheck[] {
  return [
    ...checkStats(data),
    ...checkStars(data),
    ...checkQuestions(data),
    checkBrokenLinks(data),
    checkOrphans(data),
  ];
}

export interface IntegritySummary {
  problems: number;
  issues: number;
  bySeverity: Record<Severity, number>;
}

export function integritySummary(checks: readonly IntegrityCheck[]): IntegritySummary {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  let problems = 0;
  let issues = 0;
  for (const check of checks) {
    if (check.count === 0) continue;
    problems += 1;
    issues += check.count;
    bySeverity[check.severity] += check.count;
  }
  return { problems, issues, bySeverity };
}

export type RepairKind = 'remove-stat' | 'remove-star';

export interface RepairOp {
  kind: RepairKind;
  bank: string;
  qid: string;
}

export interface RepairPlan {
  ops: RepairOp[];
  skipped: { check: CheckId; reason: string }[];
}

/**
 * 根据体检结果生成修复动作。只接受检查项自己报出来的条目 id；
 * 同一记录只保留一条操作（统计与收藏各自独立）。
 */
export function planRepairs(checks: readonly IntegrityCheck[]): RepairPlan {
  const ops: RepairOp[] = [];
  const skipped: RepairPlan['skipped'] = [];
  for (const check of checks) {
    if (check.count === 0) continue;
    if (!check.fixable) {
      skipped.push({ check: check.id, reason: check.fixNote });
      continue;
    }
    const kind: RepairKind | null =
      check.id === 'stat-bank-missing' || check.id === 'stat-question-missing'
        ? 'remove-stat'
        : check.id === 'star-bank-missing' || check.id === 'star-question-missing'
          ? 'remove-star'
          : null;
    if (!kind) {
      skipped.push({ check: check.id, reason: check.fixNote });
      continue;
    }
    for (const item of check.items) {
      const at = item.id.lastIndexOf('::');
      if (at <= 0) continue;
      ops.push({ kind, bank: item.id.slice(0, at), qid: item.id.slice(at + 2) });
    }
  }
  const seen = new Set<string>();
  return {
    ops: ops.filter((op) => {
      const key = op.kind + ':' + op.bank + ':' + op.qid;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    skipped,
  };
}

/** 报告 Markdown：体检结果 + 本次修复计数。 */
export function integrityReport(
  checks: readonly IntegrityCheck[],
  report: { at: number; removedStats?: number; removedStars?: number } = { at: Date.now() },
): string {
  const summary = integritySummary(checks);
  const lines = [
    '# 数据自检报告',
    '',
    '生成时间：' + new Date(report.at).toLocaleString(),
    '',
    summary.issues === 0
      ? '结论：未发现问题。'
      : `结论：共 ${summary.issues} 条问题，分布在 ${summary.problems} 个体检项（严重 ${summary.bySeverity.high} / 中等 ${summary.bySeverity.medium} / 轻微 ${summary.bySeverity.low}）。`,
    '',
  ];
  if (report.removedStats || report.removedStars) {
    lines.push(`本次修复：删除统计 ${report.removedStats ?? 0} 条、收藏 ${report.removedStars ?? 0} 条。`, '');
  }
  for (const check of checks) {
    lines.push(`## ${check.title}（${check.count === 0 ? '正常' : `${check.count} 条 · ${SEVERITY_LABEL[check.severity]}`}）`);
    if (check.count === 0) {
      lines.push('无问题。', '');
      continue;
    }
    lines.push('处理方式：' + (check.fixable ? check.fixNote : '只报告不修改——' + check.fixNote), '');
    for (const item of check.items) lines.push(`- ${item.title}：${item.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}
