/**
 * 元认知校准（confidence calibration）：作答前先报「有几分把握」，事后比对自信与实际正确率。
 *
 * 依据：Dunlosky 2013（自我评估是低效策略，但可训练）；Calibrating Calibration 2023 meta
 * 显示自信度与正确率的差值能被训练并直接改进复习时间分配。医学生普遍高估掌握度，
 * 所以这里只做一件事：把「报了几档自信」和「实际答对多少」并排摆出来。
 *
 * 存储：只存 5 个桶的计数（n / correct），不存逐题日志——几十字节，随备份一起走，
 * 也不会因为刷题量变大而膨胀。key 与 days/mistakes 同层（localStorage）。
 */
export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface CalibBucket {
  confidence: Confidence;
  /** 报了这一档自信度的作答次数 */
  n: number;
  /** 其中答对的次数 */
  correct: number;
}

export interface CalibSummary {
  /** 总样本数（只有报了自信度的作答才计入） */
  n: number;
  correct: number;
  buckets: CalibBucket[];
  /**
   * 过度自信指数：平均自信度（折算成 0~1）− 实际正确率。
   * 正数 = 高估自己（报 80% 把握却只对 60%），负数 = 低估。样本为 0 时返回 0。
   */
  overconfidence: number;
}

const KEY = 'knowlattice-qcalib';

/** 5 档的措辞：只写「把握程度」，不写「对/错」，避免暗示答案 */
export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  1: '纯猜',
  2: '不确定',
  3: '一半一半',
  4: '比较有把握',
  5: '很确定',
};

export const CONFIDENCE_VALUES: Confidence[] = [1, 2, 3, 4, 5];

type RawCounts = Record<string, { n?: unknown; correct?: unknown }>;

function readRaw(): RawCounts {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as RawCounts;
  } catch {
    return {};
  }
}

function writeRaw(raw: RawCounts): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(raw));
  } catch {
    /* 存不进去（隐私模式/配额）不该影响答题本身 */
  }
}

function countOf(raw: RawCounts, c: Confidence): { n: number; correct: number } {
  const entry = raw[String(c)];
  const n = typeof entry?.n === 'number' && Number.isFinite(entry.n) && entry.n > 0 ? Math.floor(entry.n) : 0;
  const correct = typeof entry?.correct === 'number' && Number.isFinite(entry.correct) && entry.correct > 0
    ? Math.min(Math.floor(entry.correct), n)
    : 0;
  return { n, correct };
}

/** 记一次「报了自信度」的作答。confidence 非法或非整数直接忽略。 */
export function recordCalibration(confidence: Confidence, correct: boolean): void {
  if (!CONFIDENCE_VALUES.includes(confidence)) return;
  const raw = readRaw();
  const cur = countOf(raw, confidence);
  raw[String(confidence)] = { n: cur.n + 1, correct: cur.correct + (correct ? 1 : 0) };
  writeRaw(raw);
}

/** 始终返回 5 个桶（没数据的档位 n=0），供视图直接画图 */
export function loadCalibration(): CalibBucket[] {
  const raw = readRaw();
  return CONFIDENCE_VALUES.map((confidence) => ({ confidence, ...countOf(raw, confidence) }));
}

export function calibrationSummary(): CalibSummary {
  const buckets = loadCalibration();
  const n = buckets.reduce((s, b) => s + b.n, 0);
  const correct = buckets.reduce((s, b) => s + b.correct, 0);
  if (!n) return { n: 0, correct: 0, buckets, overconfidence: 0 };
  const meanConfidence = buckets.reduce((s, b) => s + b.confidence * b.n, 0) / n / 5;
  return { n, correct, buckets, overconfidence: meanConfidence - correct / n };
}

/** 备份用：只导出有数据的档位 */
export function exportCalibration(): Record<string, { n: number; correct: number }> {
  const out: Record<string, { n: number; correct: number }> = {};
  for (const b of loadCalibration()) if (b.n) out[String(b.confidence)] = { n: b.n, correct: b.correct };
  return out;
}

/** 恢复备份用：整体覆盖。非法输入一律忽略，不抛错（备份文件可能来自旧版本）。 */
export function importCalibration(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const next: RawCounts = {};
  for (const c of CONFIDENCE_VALUES) {
    const cur = countOf(raw as RawCounts, c);
    if (cur.n) next[String(c)] = { n: cur.n, correct: cur.correct };
  }
  writeRaw(next);
}
