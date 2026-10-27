/**
 * 错题严重度：把「这条错题有多危险」从记录本身推出来，不依赖后端打标。
 *
 * 四档（口径取自错题手术台的标签语义）：
 * - 致命盲区 critical：还在第 0 阶段，且已经错过两次以上——一错就会拉低整段表现
 * - 顽固病灶 stubborn：反复回炉（lapses ≥ 2），按原节奏怎么刷都推不动
 * - 隐形地雷 landmine：曾经推进过（有晋级时间），又被打回原点——短期最容易反弹
 * - 普通题 normal：其余，按常规复盘节奏即可
 *
 * 判定顺序即优先级：顽固 > 地雷 > 盲区 > 普通。已归档的一律 normal（不再挂标签）。
 */
import { MAX_STAGE, isArchived, stageOf, type MistakeRecord } from './mistakes';

export type Severity = 'critical' | 'stubborn' | 'landmine' | 'normal';

export interface SeverityInfo {
  verdict: Severity;
  label: string;
  /** 为什么归到这一档 */
  meta: string;
  /** 建议动作 */
  action: string;
}

const SEVERITY_INFO: Record<Severity, Omit<SeverityInfo, 'verdict'>> = {
  critical: { label: '致命盲区', meta: '错一次就会拉低整段表现', action: '优先清理' },
  stubborn: { label: '顽固病灶', meta: '重复出错，建议安排二刷', action: '持续追踪' },
  landmine: { label: '隐形地雷', meta: '短期容易反弹，别放过', action: '及时补强' },
  normal: { label: '普通题', meta: '可以纳入常规复盘节奏', action: '维持节奏' },
};

export function severityOf(r: MistakeRecord): Severity {
  if (isArchived(r)) return 'normal';
  const stage = stageOf(r);
  const lapses = r.lapses ?? 0;
  const advanced = (r.lastAdvanceAt ?? 0) > 0;
  if (lapses >= 2) return 'stubborn';
  if (lapses >= 1 && advanced) return 'landmine';
  if (!advanced && stage === 0 && (r.count ?? 0) >= 2) return 'critical';
  return 'normal';
}

export function severityInfo(r: MistakeRecord): SeverityInfo {
  const verdict = severityOf(r);
  return { verdict, ...SEVERITY_INFO[verdict] };
}

/** 列表行的悬停说明：为什么这一档 + 该怎么做 */
export function severityHint(r: MistakeRecord): string {
  const info = severityInfo(r);
  return info.meta + ' · ' + info.action;
}

/** 已归档的题不进严重度排序，导出给调用方做「要不要显示标签」的判断 */
export function needsAttention(r: MistakeRecord): boolean {
  return !isArchived(r) && stageOf(r) < MAX_STAGE && severityOf(r) !== 'normal';
}
