/**
 * 跨设备学习数据快照：把「与设备无关的学习进度」打成一个 JSON，换台机器导回去。
 *
 * 为什么要有它：整包备份（vault.exportAll）侧重笔记与附件，动辄几十兆，走文件传输很笨；
 * 而题库、统计、错题、复习卡、考试历史这些才是换设备后最想立刻接上的东西，加起来通常只有几百 KB。
 * 所以这里做一份「只有进度、没有附件」的薄快照。
 *
 * 设计约束：
 * - 每个部件都复用已有的 export* / import*，不新造序列化格式（各模块自己知道自己的旧版本怎么迁）。
 * - 导入语义由各模块决定（有的同名覆盖、有的合并），这里只负责调度与回报，不改写它们的规则。
 * - 文件带 version：将来某部件换了结构，旧快照仍能读——解析只校验外壳，部件内容交给各 import* 做宽容处理。
 */
import { exportQbanks, importQbanks } from './qbank';
import { exportQuestionStats, importQuestionStats } from './qbankStats';
import { exportStars, importStars } from './qbankStarred';
import { exportCalibration, importCalibration } from './qbankCalib';
import { loadMistakes, importMistakes } from './mistakes';
import { exportSrsState, importSrsState } from './srs';
import { exportExamHistory, importExamHistory } from './examHistory';
import { exportDaily, importDaily } from './dailyPractice';
import { exportDays, importDays } from './stats';
import { exportStudyLog, importStudyLog } from './studyLog';
import { exportTodos, importTodos } from './todos';
import { exportAchievements, importAchievements } from './achievementStore';
import { exportMastery, importMastery } from './tutor';
import { exportCardEdits, importCardEdits } from './cardEdits';
import { exportDayNotes, importDayNotes } from './studyCalendar';
import { exportVocabState, importVocabState } from './vocab';
import { exportDrillBackup, importDrillBackup } from './wordDrill';
import { exportExcerpts, importExcerpts } from './pdfExcerpts';
import { exportMarks, importMarks } from './mindmapMarks';

/** 外壳版本：部件增删改时 +1，读旧版仍放行（部件内容由各 import* 兼容） */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotPart {
  key: string;
  label: string;
  read: () => unknown;
  write: (value: unknown) => unknown;
}

/** 参与快照的部件清单。加一行就等于加一份数据，不需要改调用方。 */
export const SNAPSHOT_PARTS: SnapshotPart[] = [
  { key: 'qbank', label: '题库', read: exportQbanks, write: (v) => importQbanks(v) },
  { key: 'qbankStats', label: '逐题统计', read: exportQuestionStats, write: (v) => importQuestionStats(v) },
  { key: 'qbankStars', label: '题目收藏', read: exportStars, write: (v) => importStars(v) },
  { key: 'qbankCalib', label: '元认知校准', read: exportCalibration, write: (v) => importCalibration(v) },
  { key: 'mistakes', label: '错题本', read: loadMistakes, write: (v) => importMistakes(v) },
  { key: 'srs', label: '复习卡', read: exportSrsState, write: (v) => importSrsState(v) },
  { key: 'examHistory', label: '考试记录', read: exportExamHistory, write: (v) => importExamHistory(v) },
  { key: 'dailyPractice', label: '每日练习', read: exportDaily, write: (v) => importDaily(v) },
  { key: 'studyDays', label: '学习天数', read: exportDays, write: (v) => importDays(v) },
  { key: 'studyLog', label: '学习日志', read: exportStudyLog, write: (v) => importStudyLog(v) },
  { key: 'todos', label: '待办', read: exportTodos, write: (v) => importTodos(v) },
  { key: 'achievements', label: '成就', read: exportAchievements, write: (v) => importAchievements(v) },
  { key: 'mastery', label: '导师掌握度', read: exportMastery, write: (v) => importMastery(v) },
  { key: 'cardEdits', label: '卡片自定义', read: exportCardEdits, write: (v) => importCardEdits(v) },
  { key: 'dayNotes', label: '日历笔记', read: exportDayNotes, write: (v) => importDayNotes(v) },
  { key: 'vocab', label: '生词本', read: exportVocabState, write: (v) => importVocabState(v) },
  { key: 'wordDrill', label: '单词工坊', read: exportDrillBackup, write: (v) => importDrillBackup(v) },
  { key: 'pdfExcerpts', label: 'PDF 摘录', read: exportExcerpts, write: (v) => importExcerpts(v) },
  { key: 'mindmapMarks', label: '导图标记', read: exportMarks, write: (v) => importMarks(v) },
];

export interface Snapshot {
  app: 'knowlattice';
  kind: 'study-snapshot';
  version: number;
  exportedAt: number;
  parts: Record<string, unknown>;
}

export interface ApplyReport {
  applied: { key: string; label: string; result: unknown }[];
  missing: string[];
  failed: { key: string; label: string; message: string }[];
}

const byKey = new Map(SNAPSHOT_PARTS.map((part) => [part.key, part]));

/** 打包：只读一次各部件，读失败的部件留空但不影响其余（宁缺一个也别整包失败）。 */
export async function buildSnapshot(keys?: string[]): Promise<Snapshot> {
  const picked = keys ? keys.map((k) => byKey.get(k)).filter((p): p is SnapshotPart => !!p) : SNAPSHOT_PARTS;
  const parts: Record<string, unknown> = {};
  for (const part of picked) {
    try {
      parts[part.key] = await Promise.resolve(part.read());
    } catch {
      parts[part.key] = null;
    }
  }
  return { app: 'knowlattice', kind: 'study-snapshot', version: SNAPSHOT_VERSION, exportedAt: Date.now(), parts };
}

export function snapshotToJson(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 解析快照文件。外壳不对时抛中文错误（调用方直接 toast 出去），
 * 部件缺失不算错误——只回落到「这部分跳过」。
 */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  const snap = raw as Partial<Snapshot>;
  if (!snap || typeof snap !== 'object' || snap.kind !== 'study-snapshot') {
    throw new Error('这不是学习数据快照（kind 不匹配）');
  }
  if (!snap.parts || typeof snap.parts !== 'object') {
    throw new Error('快照里没有 parts 字段');
  }
  if (typeof snap.version === 'number' && snap.version > SNAPSHOT_VERSION + 2) {
    throw new Error('快照来自更新的版本，请升级后再导入');
  }
  return {
    app: 'knowlattice',
    kind: 'study-snapshot',
    version: typeof snap.version === 'number' ? snap.version : 0,
    exportedAt: typeof snap.exportedAt === 'number' ? snap.exportedAt : 0,
    parts: snap.parts as Record<string, unknown>,
  };
}

/**
 * 合并进本机。逐部件独立 try/catch：一个部件写失败不影响其它部件，
 * 报告里分清「没带这部分」「写失败了」——用户要知道是空快照还是真出错。
 */
export async function applySnapshot(snapshot: Snapshot, keys?: string[]): Promise<ApplyReport> {
  const picked = keys ? keys.map((k) => byKey.get(k)).filter((p): p is SnapshotPart => !!p) : SNAPSHOT_PARTS;
  const report: ApplyReport = { applied: [], missing: [], failed: [] };
  for (const part of picked) {
    if (!(part.key in snapshot.parts) || snapshot.parts[part.key] === null) {
      report.missing.push(part.key);
      continue;
    }
    try {
      const result = await Promise.resolve(part.write(snapshot.parts[part.key]));
      report.applied.push({ key: part.key, label: part.label, result });
    } catch (error) {
      report.failed.push({ key: part.key, label: part.label, message: (error as Error).message || '未知错误' });
    }
  }
  return report;
}

/** 一句话回报：给 toast 用，别让用户自己数 applied 里有几条 */
export function reportLine(report: ApplyReport): string {
  const ok = report.applied.length;
  const bad = report.failed.length;
  if (!ok && !bad) return '快照里没有可导入的数据';
  const head = `已合并 ${ok} 类数据`;
  const tail = [bad ? `${bad} 类失败` : '', report.missing.length ? `${report.missing.length} 类未包含` : '']
    .filter(Boolean)
    .join('，');
  return tail ? `${head}，${tail}` : head;
}
